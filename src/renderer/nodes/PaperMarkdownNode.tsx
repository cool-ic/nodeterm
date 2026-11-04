import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Handle, NodeResizer, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import type { EditorView } from '@codemirror/view'
import type { CanvasNode } from '../state/workspace'
import { isMacPlatform } from '@shared/platform-utils'
import { useSession } from '../session/session'
import { useProjects } from '../state/projects'
import { useSettings } from '../state/settings'
import { sshFs } from '../terminal/ssh-fs'
import { isPaperTheme, paperThemeClass, resolveTerminalTheme } from '../terminal/themes'
import { BUNDLED_TERMINAL_FONT } from '../terminal/paper-fonts'
import { paperLayoutStyle } from '../terminal/paper-layout'
import { effectiveTerminalFontSize, forwardedResetMatches, nextTerminalFontSizeOverride, normalizeTerminalFontSize, terminalFontZoomChord, type TerminalFontZoomAction } from '../terminal/terminal-font-zoom'
import { PaperMarkdownEditor } from '../editor/PaperMarkdownEditor'
import { PaperMarkdownRead } from '../editor/PaperMarkdownRead'
import { MarkdownDocument } from '../editor/markdown-document'
import { canvasOwnsMarkdownChord } from '../lib/markdownChord'
import { isGlobalKanbanOpen, isKanbanOpen } from '../state/viewMode'
import { NODE_MIN_SIZES } from '../lib/nodeSizing'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Tooltip } from '../components/Tooltip'
import { IconClose } from '../components/icons'
import { MaximizeButton } from './MaximizeButton'

/** The existing editor node/file route, with a small Markdown-specific surface and no Monaco. */
export function PaperMarkdownNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { deleteElements, updateNodeData } = useReactFlow()
  const { api } = useSession()
  const activeProjectId = useProjects(s => s.activeProjectId)
  const fs = useMemo(() => data.sshFs && activeProjectId ? sshFs(activeProjectId) : api.fs,
    [data.sshFs, activeProjectId, api.fs])
  const filePath = String(data.filePath ?? '')
  const name = filePath.replace(/\\/g, '/').split('/').pop() || 'Untitled.md'
  const doc = useMemo(() => new MarkdownDocument(fs, filePath), [fs, filePath])
  const [, refresh] = useState(0)
  const [reading, setReading] = useState(() => useSettings.getState().settings.openMarkdownPreview)
  const [confirmClose, setConfirmClose] = useState(false)
  const editor = useRef<EditorView | null>(null)
  const sheet = useRef<HTMLDivElement>(null)
  const hovered = useRef(false)
  const alive = useRef(false)
  const initialText = useRef('')
  const theme = useSettings(s => s.settings.terminalTheme)
  const size = useSettings(s => s.settings.fontSize)
  const spacing = useSettings(s => s.settings.terminalLineHeight)
  const paperMargins = useSettings(s => s.settings.terminalPaperMargins === true)
  const paperTheme = isPaperTheme(theme) ? theme : 'paper-ink'
  const palette = resolveTerminalTheme(paperTheme).theme
  const baseSize = normalizeTerminalFontSize(size) ?? 15
  const fontSize = effectiveTerminalFontSize(baseSize, data.markdownFontSize)
  const lineHeight = Number.isFinite(spacing) ? Math.max(1.45, Math.min(2, spacing)) : 1.45
  const paint = () => { if (alive.current) refresh(n => n + 1) }
  useEffect(() => {
    alive.current = true
    let disposed = false
    if (!data.fileMissing) void doc.load().then(() => { if (!disposed) { initialText.current = doc.text; paint() } })
    return () => { disposed = true; alive.current = false }
  }, [doc])
  useEffect(() => { if (!reading) editor.current?.requestMeasure() }, [reading, paperMargins, fontSize, lineHeight])
  const save = async () => {
    if (data.fileMissing || editor.current?.compositionStarted) return
    const pending = doc.save()
    paint()
    await pending
    paint()
  }
  const toggle = () => {
    if (editor.current?.compositionStarted) return
    setReading(value => !value)
  }
  const toggleRef = useRef(toggle)
  toggleRef.current = toggle
  useEffect(() => window.nodeTerminal.onMarkdownToggle(() => {
    if (canvasOwnsMarkdownChord(hovered.current, isGlobalKanbanOpen() || isKanbanOpen(useProjects.getState().activeProjectId ?? ''))) toggleRef.current()
  }), [])
  const zoomFont = (action: TerminalFontZoomAction) => {
    if (editor.current?.compositionStarted) return
    updateNodeData(id, node => ({
      markdownFontSize: nextTerminalFontSizeOverride(action, node.data.markdownFontSize, baseSize)
    }))
  }
  const zoomRef = useRef(zoomFont)
  zoomRef.current = zoomFont
  // Desktop claims ⌘0 before DOM keydown. Reuse its existing signal; only the focused sheet acts.
  useEffect(() => window.nodeTerminal.onZoomActualSize(mods => {
    if (forwardedResetMatches(mods, isMacPlatform()) && sheet.current?.contains(document.activeElement)) {
      zoomRef.current('reset')
    }
  }), [])
  const zoomKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229 || editor.current?.compositionStarted) return
    const action = terminalFontZoomChord(e, isMacPlatform())
    if (!action) return
    e.preventDefault()
    e.stopPropagation()
    zoomFont(action)
  }
  // Keep ⌘S available while reading. Source mode owns its shortcut through CodeMirror.
  const keyDown = (e: React.KeyboardEvent) => {
    if (reading && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault(); e.stopPropagation(); void save()
    }
  }
  const style = {
    ...paperLayoutStyle(paperTheme, fontSize, paperMargins),
    '--paper-md-font': BUNDLED_TERMINAL_FONT,
    '--paper-md-line-height': lineHeight,
    '--paper-md-ink': palette.foreground,
    '--paper-md-accent': palette.blue,
    '--paper-md-code': palette.green,
    '--paper-md-muted': palette.brightBlack,
    '--paper-md-wet': palette.yellow
  } as CSSProperties
  const close = () => { if (doc.dirty || doc.saving) setConfirmClose(true); else void deleteElements({ nodes: [{ id }] }) }
  return <>
    <div ref={sheet} className={`term-node editor-node paper-markdown${selected ? ' selected' : ''}`} data-nt-keyboard-owner
      data-paper-theme={paperTheme} style={{ ...style, borderTopColor: data.color }}
      onMouseEnter={() => { hovered.current = true }} onMouseLeave={() => { hovered.current = false }} onKeyDownCapture={zoomKeyDown} onKeyDown={keyDown}>
      <NodeResizer isVisible={selected} color={data.color} lineClassName="nt-resize-ghost" handleClassName="nt-resize-ghost" />
      <Handle id="flow-in" type="target" position={Position.Top} isConnectable={false} style={{ opacity: 0, pointerEvents: 'none', top: 0 }} />
      <div className="term-node__header">
        <span className="term-node__title-text" title={filePath}>{name}{doc.dirty ? ' ●' : ''}</span>
        <span className="term-node__spacer" />
        <Tooltip label={reading ? 'Edit Markdown' : 'Read Markdown'}>
          <button className="paper-markdown__button nodrag" aria-label={reading ? 'Edit Markdown' : 'Read Markdown'}
            disabled={!doc.loaded || !!data.fileMissing} onClick={toggle}>{reading ? 'Edit' : 'Read'}</button>
        </Tooltip>
        <Tooltip label="Save (⌘S / Ctrl+S)">
          <button className="paper-markdown__button nodrag" aria-label="Save Markdown" disabled={!doc.dirty || doc.saving || !!data.fileMissing}
            onClick={() => void save()}>{doc.saving ? 'Saving…' : 'Save'}</button>
        </Tooltip>
        <MaximizeButton id={id} maximized={!!data.premaxRect} />
        <Tooltip label="Close"><button className="term-node__close" aria-label="Close" onClick={close}><IconClose /></button></Tooltip>
      </div>
      <div className={`editor-node__body paper-markdown__paper${paperThemeClass(paperTheme)}`}>
        {!doc.loaded ? <div className="paper-markdown__message" role="status">{data.fileMissing ? 'This file’s worktree was removed.' : doc.error || 'Loading…'}</div> : <>
            <div className="paper-markdown__write" hidden={reading}>
              <PaperMarkdownEditor initialText={initialText.current} fileName={name}
                onChange={text => { const wasDirty = doc.dirty; doc.text = text; if (wasDirty !== doc.dirty) paint() }} onSave={() => void save()} onReady={view => { editor.current = view }} />
            </div>
            {reading && <article className="paper-markdown__read nodrag nowheel nokey" tabIndex={0} aria-label={`Read ${name}`}>
              <PaperMarkdownRead text={doc.text} filePath={filePath} fs={fs} openImage={path => {
                window.dispatchEvent(new CustomEvent('nodeterm:open-file', { detail: { path, ssh: !!data.sshFs, view: true } }))
              }} />
            </article>}
            {(doc.error || data.fileMissing) && <div className="paper-markdown__error nodrag" role="alert">{data.fileMissing ? 'Worktree removed. Copy your edits before closing; saving is disabled.' : doc.error}</div>}
          </>}
      </div>
    </div>
    <NodeResizer minWidth={NODE_MIN_SIZES.editor.width} minHeight={NODE_MIN_SIZES.editor.height} isVisible={selected} color={data.color} />
    {confirmClose && <ConfirmDialog message={doc.saving ? 'A save is in progress. Keep this editor open until it finishes.' : 'Discard unsaved Markdown edits?'}
      alert={doc.saving} confirmLabel={doc.saving ? 'Keep editing' : 'Discard'} cancelLabel="Keep editing"
      onConfirm={() => { if (!doc.saving) void deleteElements({ nodes: [{ id }] }); setConfirmClose(false) }} onCancel={() => setConfirmClose(false)} />}
  </>
}
