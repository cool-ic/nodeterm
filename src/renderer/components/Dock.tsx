import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AGENT_CONFIG, BUILTIN_AGENT_IDS, type AgentId, type BuiltinAgentId } from '@shared/agents/config'
import type { CanvasLayout } from '@shared/canvas-layout'
import type { CustomAgent } from '@shared/types'
import { formatShortcut, isHoldChord } from '@shared/shortcut'
import { hasSpeechModel } from '@shared/speech'
import { commandTooltip, dictationBinding } from '../lib/keybindingOverrides'
import { AgentIcon } from '../lib/agentIcons'
import { useSettings } from '../state/settings'
import { useProjects } from '../state/projects'
import { accountsForProject, sshAccountsHint } from '../state/workspace'
import { CONTENT_ADD_ITEMS, contentAddItemsToDockRows, type AddHandlers } from '../lib/addMenuSpec'
import { layoutSubtitle, sortedLayouts } from '../lib/canvasLayoutView'
import { ZOOM_PRESETS, activeZoomPreset } from '../lib/zoomPresets'
import { Tooltip } from './Tooltip'
import { railMenuPlacement, type RailMenuPlacement, type RailSide } from '../lib/railMenu'

const isMac = /Mac/i.test(navigator.platform || navigator.userAgent)

interface RailMenuAnchor {
  /** Goes on the trigger (button or its wrapper), whose rect the menu is anchored to. */
  triggerRef: (el: HTMLElement | null) => void
  /** Goes on the menu itself: its size is what the vertical clamp needs. */
  menuRef: (el: HTMLElement | null) => void
  /** Inline `left`/`right`/`top` for the menu, or null before it has been measured. */
  style: CSSProperties | null
}

/**
 * The measured half of `railMenuPlacement` (see `../lib/railMenu`): keeps a portaled rail menu on
 * its trigger. The menu renders in the same commit as the trigger's open state, so the layout effect
 * below (which runs before the browser paints) already sees the menu's own box — no flash of an
 * unplaced menu.
 */
function useRailMenu(open: boolean): RailMenuAnchor {
  const trigger = useRef<HTMLElement | null>(null)
  const menu = useRef<HTMLElement | null>(null)
  const [style, setStyle] = useState<CSSProperties | null>(null)

  useLayoutEffect(() => {
    if (!open) {
      setStyle(null)
      return
    }
    const place = (): void => {
      const el = trigger.current
      const box = menu.current
      if (!el || !box) return
      const side: RailSide = el.closest('.canvas-rail--left') ? 'left' : 'right'
      const next = railMenuPlacement(
        el.getBoundingClientRect(),
        side,
        { width: box.offsetWidth, height: box.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight }
      )
      setStyle((cur) =>
        cur && cur.top === next.top && cur.left === next.left && cur.right === next.right ? cur : next
      )
    }
    place()
    window.addEventListener('resize', place)
    // Capture: the rail column is an inner scroll container, so a listener on `window` alone never
    // hears it scroll.
    document.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
    }
  }, [open])

  return {
    triggerRef: useCallback((el: HTMLElement | null) => {
      trigger.current = el
    }, []),
    menuRef: useCallback((el: HTMLElement | null) => {
      menu.current = el
    }, []),
    style
  }
}

/** A rail menu, portaled out of the card's scroller (see `railMenuPlacement`). */
function RailMenu({
  open,
  anchor,
  className,
  children
}: {
  open: boolean
  anchor: RailMenuAnchor
  className?: string
  children: ReactNode
}): JSX.Element | null {
  if (!open) return null
  return createPortal(
    <div ref={anchor.menuRef} className={className ? `dock-menu ${className}` : 'dock-menu'} style={anchor.style ?? undefined}>
      {children}
    </div>,
    document.body
  )
}

/** T226: which single-column track this dock renders — the left one (create + history) or the
 *  right one (view + status). Each instance owns only its own menus' open state. */
interface DockProps {
  group: 'create' | 'view'
  dirty: boolean
  zoomPct: number
  canUndo: boolean
  canRedo: boolean
  canGoBack: boolean
  canGoForward: boolean
  onAddTerminal: () => void
  onAddSticky: () => void
  /** Opens the Spawn-a-team dialog (issue #78) — the conductor lands at the Dock's default spot. */
  onSpawnTeam: () => void
  onAddDino: () => void
  onAddTrigger: () => void
  onAddFiles: () => void
  /** A run node (a launch.json configuration) rooted in the project folder. */
  onAddRun: () => void
  onAddAgent: (agentId: AgentId, accountId?: string) => void
  onOpenFile: () => void
  onAddRemote: () => void
  onConnectRemote: () => void
  // Content nodes the Dock used to omit (it lagged the pane menu). Now derived from the same
  // spec as every other add-menu, so the Dock "+" and the canvas right-click stay in parity.
  onAddBrowser: () => void
  onAddWeb: () => void
  onNewFile: () => void
  onAddWorktree: () => void
  onUndo: () => void
  onRedo: () => void
  onGoBack: () => void
  onGoForward: () => void
  onSave: () => void
  onFitView: () => void
  /** Saves the current arrangement under a name the user is asked for. */
  onSaveLayout: () => void
  /** Puts the canvas back the way `layout` recorded it. No confirm: it moves nodes and nothing
   *  else, and the undo stack picks it up like any other placement. */
  onRestoreLayout: (layout: CanvasLayout) => void
  /** Overwrites `layout` with the arrangement now on screen, keeping its name. */
  onUpdateLayout: (layout: CanvasLayout) => void
  onRenameLayout: (layout: CanvasLayout) => void
  onDeleteLayout: (layout: CanvasLayout) => void
  onZoomIn: () => void
  onZoomOut: () => void
  /** Jump to an exact zoom (a preset percentage), holding the screen centre still. */
  onZoomTo: (pct: number) => void
  /** T241: the camera lock — the one survivor of the old bottom-left Controls column. */
  canvasLocked: boolean
  onToggleCanvasLock: () => void
  onDictate: () => void
  dictateActive: boolean
}

/**
 * Bottom-center floating dock. The "+" opens a node-type menu above it.
 * All canvas actions live here so the canvas itself stays clean.
 */
export function Dock({
  group,
  dirty,
  zoomPct,
  canUndo,
  canRedo,
  canGoBack,
  canGoForward,
  onAddTerminal,
  onAddSticky,
  onSpawnTeam,
  onAddDino,
  onAddTrigger,
  onAddFiles,
  onAddRun,
  onAddAgent,
  onOpenFile,
  onAddRemote,
  onConnectRemote,
  onAddBrowser,
  onAddWeb,
  onNewFile,
  onAddWorktree,
  onUndo,
  onRedo,
  onGoBack,
  onGoForward,
  onSave,
  onFitView,
  onSaveLayout,
  onRestoreLayout,
  onUpdateLayout,
  onRenameLayout,
  onDeleteLayout,
  onZoomIn,
  onZoomOut,
  onZoomTo,
  canvasLocked,
  onToggleCanvasLock,
  onDictate,
  dictateActive
}: DockProps) {
  // T229: tooltips open AWAY from the window edge — the left track opens right, the right track
  // opens left. One mapping for the whole instance; the menus' anchors are CSS per rail
  // (`.canvas-rail--left .dock-menu` / `--right`), so the two halves cannot disagree.
  const tip = group === 'create' ? 'right' : 'left'
  const [menuOpen, setMenuOpen] = useState(false)
  const [zoomMenuOpen, setZoomMenuOpen] = useState(false)
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false)
  // Which builtin's flyout submenu is open (at most one). A builtin earns a flyout only when it has
  // ≥1 inheriting custom agent (one with a `baseAgent` matching it); otherwise it stays a flat
  // button, byte-identical to before this nesting existed.
  const [openSub, setOpenSub] = useState<BuiltinAgentId | null>(null)
  // The registry's first effective `speech.dictation` binding, `''` when the user unbound it.
  // The selector returns a STRING, so zustand's default equality keeps an unrelated settings
  // write from re-rendering the dock.
  const dictationShortcut = useSettings(() => dictationBinding())
  const speechEngine = useSettings((s) => s.settings.speech.engine)
  const speechModel = useSettings((s) => s.settings.speech.model)
  // Whisper with the explicit None selection = dictation off (issue #143). The mic stays visible
  // and clickable — the overlay it opens says where to turn dictation on — but the tooltip is
  // honest about the state instead of promising a shortcut that will only warn.
  const dictationOff = speechEngine === 'whisper' && !hasSpeechModel(speechModel)
  const customAgents = useSettings((s) => s.settings.customAgents)
  const disabledAgents = useSettings((s) => s.settings.disabledAgents)
  const claudeAccounts = useSettings((s) => s.settings.claudeAccounts)
  const activeProjectId = useProjects((s) => s.activeProjectId)
  const activeProject = useProjects((s) => s.projects.find((p) => p.id === activeProjectId))
  // Accounts usable in the active project (local for a local project, this host's for an SSH
  // project). The flat dock menu can't nest, so Claude gets one "New Claude — <label>" entry per
  // account (plus the base "Claude" = project default).
  const localAccounts = accountsForProject(claudeAccounts, activeProject)
  // ✓ marks the project's default account entry (what the base "Claude" resolves to).
  const defaultAccountId = localAccounts.some((a) => a.id === activeProject?.defaultAccountId)
    ? activeProject?.defaultAccountId
    : undefined

  // Group enabled custom agents by their declared base harness. A builtin with a non-empty group
  // gets a flyout submenu (the base itself + its inheriting customs, and for Claude the account
  // rows); a builtin with an empty group stays flat. Baseless custom agents render flat after the
  // builtins, exactly as they did before.
  const enabledCustoms = customAgents.filter((c) => !disabledAgents.includes(c.id))
  const inheritingByBase = new Map<BuiltinAgentId, CustomAgent[]>()
  for (const c of enabledCustoms) {
    if (!c.baseAgent) continue
    const arr = inheritingByBase.get(c.baseAgent) ?? []
    arr.push(c)
    inheritingByBase.set(c.baseAgent, arr)
  }
  const baselessCustoms = enabledCustoms.filter((c) => !c.baseAgent)

  const pick = (fn: () => void) => () => {
    fn()
    setMenuOpen(false)
  }

  const pickZoom = (fn: () => void) => () => {
    fn()
    setZoomMenuOpen(false)
  }

  const pickLayout = (fn: () => void) => () => {
    fn()
    setLayoutMenuOpen(false)
  }

  // A relay tab is a live connection to another machine, never a workspace on this disk, so there
  // is nothing here to write a layout into. Disabled with the reason rather than hidden - the rule
  // this repo sets for the cwd-less add-menu rows and the trigger card.
  const layoutsDisabled = !!activeProject?.remote
  // Re-asked at render, not only at the click: switching to a relay tab while the menu is open
  // would otherwise leave it (and its backdrop) standing over a canvas it cannot act on.
  const layoutMenuVisible = layoutMenuOpen && !layoutsDisabled
  // T249: each menu is portaled out of the card's scroll container, so it needs its trigger's rect
  // (and its own size, for the vertical clamp) — see `useRailMenu`.
  const addMenuAnchor = useRailMenu(menuOpen)
  const zoomMenuAnchor = useRailMenu(zoomMenuOpen)
  const layoutsMenuAnchor = useRailMenu(layoutMenuVisible)
  const layoutRows = sortedLayouts(activeProject?.layouts)

  // The preset the readout currently sits on, or null between two — the menu's tick.
  const activePreset = activeZoomPreset(zoomPct)

  // Derive the content rows from the shared add-menu spec (the same list the pane right-click and
  // the sidebar "+" use), so the Dock can no longer lag the canvas menu on which kinds are addable.
  // Terminal + agents + "New Remote Connection" stay Dock-local (agents have bespoke flyouts;
  // remote-connection is a different flow than the pane menu's remote picker).
  const hasCwd = !!(activeProject?.ssh?.remoteCwd ?? activeProject?.cwd)
  const isSshProject = !!activeProject?.ssh
  const dockAddHandlers: AddHandlers = {
    terminal: onAddTerminal,
    remote: onAddRemote,
    browser: onAddBrowser,
    web: onAddWeb,
    sticky: onAddSticky,
    spawnTeam: onSpawnTeam,
    dino: onAddDino,
    trigger: onAddTrigger,
    files: onAddFiles,
    run: onAddRun,
    openFile: onOpenFile,
    newFile: onNewFile,
    worktree: onAddWorktree
  }
  const contentRows = contentAddItemsToDockRows(CONTENT_ADD_ITEMS, dockAddHandlers, {
    hasCwd,
    isSshProject
  })

  return (
    <>
      {(menuOpen || zoomMenuOpen || layoutMenuVisible) &&
        createPortal(
          <div
            className="dock-backdrop"
            onClick={() => {
              setMenuOpen(false)
              setZoomMenuOpen(false)
              setLayoutMenuOpen(false)
            }}
          />,
          document.body
        )}

      <div className="dock">
        <RailMenu open={menuOpen} anchor={addMenuAnchor}>
            <button onClick={pick(onAddTerminal)}>
              <TerminalIcon />
              <span>Terminal</span>
            </button>
            <button onClick={pick(onAddRemote)}>
              <TerminalIcon />
              <span>Remote…</span>
            </button>
            {BUILTIN_AGENT_IDS.filter((aid) => !disabledAgents.includes(aid)).flatMap((aid) => {
              const inheriting = inheritingByBase.get(aid) ?? []
              // No inheriting customs → the builtin stays a flat button (with Claude's account
              // rows), byte-identical to before nesting existed.
              if (inheriting.length === 0) {
                const base = (
                  <button key={aid} title={AGENT_CONFIG[aid].notice} onClick={pick(() => onAddAgent(aid))}>
                    <AgentIcon agentId={aid} size={18} />
                    <span>{AGENT_CONFIG[aid].label}</span>
                  </button>
                )
                if (aid !== 'claude') return [base]
                // SSH project with no accounts on its host: a disabled row saying where this
                // host's accounts come from (local accounts are correctly invisible here).
                const acctHint = sshAccountsHint(activeProject, localAccounts)
                if (acctHint) {
                  return [
                    base,
                    <button key={`${aid}-acct-hint`} disabled title={acctHint}>
                      <AgentIcon agentId={aid} size={18} />
                      <span>No accounts on this host yet</span>
                    </button>
                  ]
                }
                // Claude picks up one flat entry per logged-in local account.
                if (localAccounts.length === 0) return [base]
                return [
                  base,
                  ...localAccounts.map((a) => (
                    <button key={`${aid}-${a.id}`} onClick={pick(() => onAddAgent(aid, a.id))}>
                      <AgentIcon agentId={aid} size={18} />
                      <span>
                        Claude — {a.label}
                        {a.id === defaultAccountId ? ' ✓' : ''}
                      </span>
                    </button>
                  ))
                ]
              }
              // Has inheriting customs → render as a flyout submenu. The parent button still
              // launches the base harness in one click (preserving today's behavior); hovering it
              // reveals the base's variants — its account rows (Claude) and the inheriting customs.
              const acctHint = sshAccountsHint(activeProject, localAccounts)
              return [
                <div
                  key={aid}
                  className="dock-menu__has-sub"
                  onMouseEnter={() => setOpenSub(aid)}
                  onMouseLeave={() => setOpenSub((cur) => (cur === aid ? null : cur))}
                >
                  <button title={AGENT_CONFIG[aid].notice} onClick={pick(() => onAddAgent(aid))}>
                    <AgentIcon agentId={aid} size={18} />
                    <span>{AGENT_CONFIG[aid].label}</span>
                    <span className="dock-menu__chevron">▸</span>
                  </button>
                  {openSub === aid && (
                    <div className="dock-menu__sub">
                      {aid === 'claude' && localAccounts.length > 0 && (
                        <>
                          <div className="dock-menu__sub-label">Accounts</div>
                          {localAccounts.map((a) => (
                            <button
                              key={a.id}
                              onClick={pick(() => onAddAgent(aid, a.id))}
                            >
                              <AgentIcon agentId={aid} size={18} />
                              <span>
                                {a.label}
                                {a.id === defaultAccountId ? ' ✓' : ''}
                              </span>
                            </button>
                          ))}
                        </>
                      )}
                      {aid === 'claude' && acctHint && (
                        <button disabled title={acctHint}>
                          <AgentIcon agentId={aid} size={18} />
                          <span>No accounts on this host yet</span>
                        </button>
                      )}
                      <div className="dock-menu__sub-label">Custom</div>
                      {inheriting.map((c) => (
                        <button key={c.id} onClick={pick(() => onAddAgent(c.id))}>
                          <AgentIcon agentId={c.id} size={18} />
                          <span>{c.label}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ]
            })}
            {baselessCustoms.map((c) => (
              <button key={c.id} onClick={pick(() => onAddAgent(c.id))}>
                <AgentIcon agentId={c.id} size={18} />
                <span>{c.label}</span>
              </button>
            ))}
            {contentRows.map((row) => (
              <button
                key={row.kind}
                disabled={row.disabled}
                title={row.hint}
                onClick={pick(row.onClick)}
              >
                {row.icon}
                <span>{row.label}</span>
              </button>
            ))}
            <button onClick={pick(onConnectRemote)}>
              <RemoteIcon />
              <span>New Remote Connection</span>
            </button>
        </RailMenu>

        {group === 'create' && (
          <>
        <Tooltip label="Add node" placement={tip}>
          <button
            ref={addMenuAnchor.triggerRef}
            className={`dock-btn dock-add${menuOpen ? ' active' : ''}`}
            aria-label="Add node"
            onClick={() => {
              setZoomMenuOpen(false)
              setLayoutMenuOpen(false)
              setMenuOpen((v) => !v)
            }}
          >
            <PlusIcon />
          </button>
        </Tooltip>

        <span className="dock-sep" />

        <Tooltip label={commandTooltip('Undo', 'canvas.undo')} placement={tip}>
          <button className="dock-btn" aria-label="Undo" disabled={!canUndo} onClick={onUndo}>
            <UndoIcon />
          </button>
        </Tooltip>
        <Tooltip label={commandTooltip('Redo', 'canvas.redo')} placement={tip}>
          <button className="dock-btn" aria-label="Redo" disabled={!canRedo} onClick={onRedo}>
            <RedoIcon />
          </button>
        </Tooltip>

        <span className="dock-sep" />

        <Tooltip label={commandTooltip('Go back', 'canvas.goBack')} placement={tip}>
          <button className="dock-btn" aria-label="Go back" disabled={!canGoBack} onClick={onGoBack}>
            <ArrowLeftIcon />
          </button>
        </Tooltip>
        <Tooltip label={commandTooltip('Go forward', 'canvas.goForward')} placement={tip}>
          <button
            className="dock-btn"
            aria-label="Go forward"
            disabled={!canGoForward}
            onClick={onGoForward}
          >
            <ArrowRightIcon />
          </button>
        </Tooltip>

        <span className="dock-sep" />

        <Tooltip label={dirty ? 'Save (unsaved changes)' : 'Save'} placement={tip}>
          <button className="dock-btn" aria-label="Save" onClick={onSave}>
            <SaveIcon />
            <span className={`dock-dirty${dirty ? ' dirty' : ''}`} />
          </button>
        </Tooltip>
          </>
        )}

        {/* T226: two single-column tracks. The LEFT one (create + history) ends at Save; the
            RIGHT one (view + status) runs Fit → zoom → layouts → dictate, and the status badges
            follow it in Canvas's rail body. */}
        {group === 'view' && (
          <>
        <Tooltip label="Fit view" placement={tip}>
          <button className="dock-btn" aria-label="Fit view" onClick={onFitView}>
            <FrameIcon />
          </button>
        </Tooltip>
        <Tooltip label="Zoom out" placement={tip}>
          <button className="dock-btn" aria-label="Zoom out" onClick={onZoomOut}>
            <MinusIcon />
          </button>
        </Tooltip>
        <div className="dock-zoom-wrap" ref={zoomMenuAnchor.triggerRef}>
          <RailMenu open={zoomMenuOpen} anchor={zoomMenuAnchor} className="dock-zoom-menu">
              {ZOOM_PRESETS.map((pct) => (
                <button
                  key={pct}
                  className={pct === activePreset ? 'is-current' : undefined}
                  onClick={pickZoom(() => onZoomTo(pct))}
                >
                  <span className="dock-menu__check">{pct === activePreset ? <CheckIcon /> : null}</span>
                  <span>{pct}%</span>
                  {pct === 100 && <span className="dock-menu__chord">{isMac ? '⌘0' : 'Ctrl+0'}</span>}
                </button>
              ))}
              <span className="dock-menu__rule" />
              <button onClick={pickZoom(onFitView)}>
                <span className="dock-menu__check" />
                <span>Zoom to fit</span>
                <span className="dock-menu__chord">⇧1</span>
              </button>
          </RailMenu>
          <Tooltip label="Zoom presets" placement={tip}>
            <button
              className={`dock-zoom${zoomMenuOpen ? ' active' : ''}`}
              aria-label="Zoom presets"
              aria-haspopup="menu"
              aria-expanded={zoomMenuOpen}
              onClick={() => {
                setMenuOpen(false)
                setLayoutMenuOpen(false)
                setZoomMenuOpen((v) => !v)
              }}
            >
              {zoomPct}%
            </button>
          </Tooltip>
        </div>
        <Tooltip label="Zoom in" placement={tip}>
          <button className="dock-btn" aria-label="Zoom in" onClick={onZoomIn}>
            <PlusSmallIcon />
          </button>
        </Tooltip>

        {/* T241: the camera lock is the only survivor of the old bottom-left Controls column.
            It is a MODE toggle, not a camera move — it changes what the three above are allowed
            to do — so it keeps a hairline of its own above and below rather than reading as a
            fourth zoom action. Same aria-label contract the Controls button had. */}
        <span className="dock-sep" />
        <Tooltip
          label={canvasLocked ? 'Unlock view (pan/zoom)' : 'Lock view (pan/zoom); nodes stay movable'}
          placement={tip}
        >
          <button
            className={`dock-btn canvas-lock-btn${canvasLocked ? ' locked' : ''}`}
            aria-label={canvasLocked ? 'Unlock view' : 'Lock view'}
            onClick={onToggleCanvasLock}
          >
            {canvasLocked ? <LockIcon /> : <UnlockIcon />}
          </button>
        </Tooltip>

        <span className="dock-sep" />

        {/* An arrangement is view state, not a node you add, so it sits in the view cluster rather
            than behind the "+". */}
        <div className="dock-layouts-wrap" ref={layoutsMenuAnchor.triggerRef}>
          <RailMenu open={layoutMenuVisible} anchor={layoutsMenuAnchor} className="dock-layouts-menu">
              {layoutRows.length === 0 ? (
                // Never an empty popover: a menu that opens onto nothing reads as broken rather
                // than as empty.
                <button disabled>
                  <span>No layouts saved yet</span>
                </button>
              ) : (
                layoutRows.map((layout) => (
                  <div key={layout.id} className="dock-menu__row">
                    <button
                      className="dock-menu__row-main"
                      onClick={pickLayout(() => onRestoreLayout(layout))}
                    >
                      <LayoutsIcon />
                      <span className="dock-menu__row-text">
                        <span className="dock-menu__row-name">{layout.name}</span>
                        <span className="dock-menu__row-sub">{layoutSubtitle(layout)}</span>
                      </span>
                    </button>
                    <span className="dock-menu__row-actions">
<Tooltip label="Update to the arrangement on screen" placement="right">
                        <button
                          className="dock-menu__row-act"
                          aria-label={`Update layout ${layout.name} to the current arrangement`}
                          onClick={(e) => {
                            // The row itself restores; these three must not.
                            e.stopPropagation()
                            setLayoutMenuOpen(false)
                            onUpdateLayout(layout)
                          }}
                        >
                          <UpdateIcon />
                        </button>
                      </Tooltip>
                      <Tooltip label="Rename" placement="right">
                        <button
                          className="dock-menu__row-act"
                          aria-label={`Rename layout ${layout.name}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            setLayoutMenuOpen(false)
                            onRenameLayout(layout)
                          }}
                        >
                          <PencilIcon />
                        </button>
                      </Tooltip>
                      <Tooltip label="Delete" placement="right">
                        <button
                          className="dock-menu__row-act"
                          aria-label={`Delete layout ${layout.name}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            setLayoutMenuOpen(false)
                            onDeleteLayout(layout)
                          }}
                        >
                          <CrossIcon />
                        </button>
                      </Tooltip>
                    </span>
                  </div>
                ))
              )}
              <span className="dock-menu__rule" />
              <button onClick={pickLayout(onSaveLayout)}>
                <PlusSmallIcon />
                <span>Save current layout…</span>
              </button>
          </RailMenu>
          <Tooltip
            label={layoutsDisabled ? 'Layouts are managed on the host' : 'Layouts'}
            placement={tip}
          >
            <button
              className={`dock-btn${layoutMenuOpen ? ' active' : ''}`}
              aria-label="Layouts"
              aria-haspopup="menu"
              aria-expanded={layoutMenuOpen}
              disabled={layoutsDisabled}
              onClick={() => {
                setMenuOpen(false)
                setZoomMenuOpen(false)
                setLayoutMenuOpen((v) => !v)
              }}
            >
              <LayoutsIcon />
            </button>
          </Tooltip>
        </div>
        <Tooltip
          label={
            dictationOff
              ? 'Dictation off — choose a model in Settings → Speech'
              : // The user unbound the shortcut: the mic button still dictates, so the tooltip
                // keeps the label and drops the chord rather than promising a key that is gone.
                dictationShortcut === ''
                ? 'Dictate'
                : isHoldChord(dictationShortcut)
                  ? `Dictate (hold ${formatShortcut(dictationShortcut, isMac)})`
                  : `Dictate (${formatShortcut(dictationShortcut, isMac)})`
          }
          placement={tip}
        >
          <button
            className={`dock-btn${dictateActive ? ' active' : ''}`}
            aria-label="Dictate"
            onClick={onDictate}
          >
            <MicIcon />
          </button>
        </Tooltip>
        <span className="dock-sep" />
          </>
        )}
      </div>
    </>
  )
}

/* ---- inline icons (stroke = currentColor) ---- */
const S = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

function PlusIcon() {
  return (
    <svg {...S} width={20} height={20}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}
function UndoIcon() {
  return (
    <svg {...S}>
      <path d="M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H10" />
    </svg>
  )
}
function RedoIcon() {
  return (
    <svg {...S}>
      <path d="M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H14" />
    </svg>
  )
}
function ArrowLeftIcon() {
  return (
    <svg {...S}>
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </svg>
  )
}
function ArrowRightIcon() {
  return (
    <svg {...S}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  )
}
function PlusSmallIcon() {
  return (
    <svg {...S}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}
function CheckIcon() {
  return (
    <svg {...S} width={13} height={13} strokeWidth={2.4}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  )
}
function MinusIcon() {
  return (
    <svg {...S}>
      <path d="M5 12h14" />
    </svg>
  )
}
function SaveIcon() {
  return (
    <svg {...S}>
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <path d="M17 21v-8H7v8M7 3v5h8" />
    </svg>
  )
}
function FrameIcon() {
  return (
    <svg {...S}>
      <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
    </svg>
  )
}
/* T241: the padlock geometry is icons.tsx's IconLock/IconUnlock re-cut to the dock's own 18px
   `S` set — a 16px glyph would be the odd one out in a column of 18px neighbours. */
function LockIcon() {
  return (
    <svg {...S}>
      <rect x="4.5" y="10.5" width="15" height="10.5" rx="2.5" />
      <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
    </svg>
  )
}
function UnlockIcon() {
  return (
    <svg {...S}>
      <rect x="4.5" y="10.5" width="15" height="10.5" rx="2.5" />
      <path d="M8 10.5V7a4 4 0 0 1 7.7-1.5" />
    </svg>
  )
}
function LayoutsIcon() {
  return (
    <svg {...S}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M10 4v16M10 12h11" />
    </svg>
  )
}
function UpdateIcon() {
  return (
    <svg {...S} width={13} height={13}>
      <path d="M20 11a8 8 0 1 0-2.3 6.3M20 6v5h-5" />
    </svg>
  )
}
function PencilIcon() {
  return (
    <svg {...S} width={13} height={13}>
      <path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" />
    </svg>
  )
}
function CrossIcon() {
  return (
    <svg {...S} width={13} height={13}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}
function TerminalIcon() {
  return (
    <svg {...S}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M13 15h4" />
    </svg>
  )
}
function MicIcon() {
  return (
    <svg {...S}>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8" />
    </svg>
  )
}
function RemoteIcon() {
  return (
    <svg {...S}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18" />
    </svg>
  )
}
