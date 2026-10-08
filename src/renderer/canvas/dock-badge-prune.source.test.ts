// T224's wiring, pinned where it lives. Canvas is a monolith with no render harness and main's
// index.ts is not importable in a test, so the two load-bearing wirings are read from the source:
// the self-heal must be driven by MAIN's cross-project node-id union (never by the current canvas,
// which would drop every closed project's nodes) and must leave a trace when it drops persisted
// state or when it cannot run at all. A source read is a weak test; what it stands between is a
// one-line regression that nothing else in the suite can see.
import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

const CANVAS_SRC = fs.readFileSync(path.join(__dirname, 'Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')
const MAIN_SRC = fs
  .readFileSync(path.resolve(__dirname, '../../main/index.ts'), 'utf8')
  .replace(/\r\n/g, '\n')

/** The source between two markers, both required — a missing marker fails loudly, never silently. */
function between(src: string, start: string, end: string): string {
  const from = src.indexOf(start)
  expect(from, `missing: ${start}`).toBeGreaterThan(-1)
  const to = src.indexOf(end, from + start.length)
  expect(to, `missing after ${start}: ${end}`).toBeGreaterThan(from)
  return src.slice(from, to)
}

const EFFECT = between(CANVAS_SRC, '// T224 — the Dock badge', '}, [nodesRef])')

describe('the Dock-badge self-heal (T224)', () => {
  it('asks main for the union and re-runs on every push, from the local preload', () => {
    expect(CANVAS_SRC).toContain('const wire = window.nodeTerminal')
    expect(EFFECT).toContain('if (!wire?.knownNodeIds) return')
    expect(EFFECT).toContain('.knownNodeIds()')
    expect(EFFECT).toContain('wire.onKnownNodeIds?.(prune)')
    // The canvas's session `api` follows a relay binding; the union describes THIS machine's
    // workspace index and the table pruned is the local one, so the effect must not ride it.
    expect(EFFECT).not.toContain('api.')
  })

  it('prunes against main’s answer, with the renderer’s own ids only added as existence evidence', () => {
    // Main's union is the criterion; an id absent from it is only pruned when nothing this
    // renderer holds proves it alive either. An unknown answer returns BEFORE the union, so a
    // failed read can never be folded into a prune.
    expect(EFFECT).toContain('if (!knownIds) return')
    expect(EFFECT.indexOf('const known = new Set(knownIds)')).toBeLessThan(
      EFFECT.indexOf('useProjects.getState().projects')
    )
    // Every project this window loaded — closed ones included — plus the mounted canvas, which
    // closes the window between a node's birth and the next workspace write. Never the other way
    // round: judging by the current canvas's nodes alone is what a closed project must survive.
    expect(EFFECT).toContain('for (const p of useProjects.getState().projects)')
    expect(EFFECT).toContain('for (const n of nodesRef.current) known.add(n.id)')
    expect(EFFECT).toContain('useAgentStatus.getState().pruneMissingNodes(known)')
  })

  it('leaves a visible trace both when it prunes and when it cannot run', () => {
    expect(EFFECT).toContain('if (removed.length)')
    expect(EFFECT).toContain('[agentStatus] pruned ${removed.length} unread entries')
    // main mirrors renderer consoles into the debug log ring — that is where the trace is read.
    expect(EFFECT).toContain('console.warn')
    expect(EFFECT).toContain('could not read the project node list; unread entries kept')
  })
})

describe('the main-process side of the union (T224)', () => {
  it('answers `null` — never an empty list — when the node set cannot be known', () => {
    const handler = between(MAIN_SRC, 'ipcMain.handle(IPC.agentKnownNodeIds', '})')
    expect(handler).toContain('workspaceStore.knownNodeIds()')
    expect(handler).toContain('return known ? [...known] : null')
    // The same reading for a throw: an answer we could not produce is not "no nodes exist".
    expect(handler).toContain('return null')
  })

  it('pushes the union after every workspace load/save, and never pushes an unknown set', () => {
    const onPersist = between(MAIN_SRC, 'workspaceStore.onPersist = () => {', '\n}')
    expect(onPersist).toContain('pushKnownNodeIds()')
    const push = between(MAIN_SRC, 'function pushKnownNodeIds(): void {', '\n}')
    expect(push).toContain('const known = workspaceStore.knownNodeIds()')
    expect(push).toContain('if (known) sendToMain(IPC.agentKnownNodeIdsChanged, [...known])')
  })
})
