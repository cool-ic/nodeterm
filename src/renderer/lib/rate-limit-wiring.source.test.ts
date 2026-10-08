// T228/T237's wirings, pinned where they live. `Canvas.tsx` is a monolith with no render harness,
// and `main/index.ts` is not importable in a test, so the load-bearing connections are read from
// source — the SAME substitute T224's guard uses, and for the reason T207b recorded the hard way:
// the queue's unit tests all constructed their own deps, so they tested the seam and not the
// wiring, and the probe was dead code in the shipping app for a week while the suite stayed green.
//
// A source read is a weak test. What it stands between: a one-line regression nothing else in the
// suite can see (an effect that stops subscribing, a trigger that stops firing, a dep that stops
// being forwarded).
import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const CANVAS = read('renderer/canvas/Canvas.tsx')
const MAIN = read('main/index.ts')
const SERVER_STATUS = read('server/agent-status.ts')
const SERVER_INDEX = read('server/index.ts')
const STORE = read('renderer/state/agentStatus.ts')
const ROUTING = read('renderer/lib/controlRouting.ts')
const BRIDGE = read('renderer/bridge/ws-bridge.ts')

/** The source between two markers, both required — a missing marker fails loudly, never silently. */
function between(src: string, start: string, end: string, from = 0): string {
  const at = src.indexOf(start, from)
  expect(at, `missing: ${start}`).toBeGreaterThan(-1)
  const to = src.indexOf(end, at + start.length)
  expect(to, `missing after ${start}: ${end}`).toBeGreaterThan(at)
  return src.slice(at, to)
}

describe('T228① — the reading is taken, carried, pushed and RENDERED (the wiring, not the seam)', () => {
  it('main classifies on an ERRORED `done` only, and pushes on the new channel', () => {
    expect(MAIN).toContain("if (enriched.state === 'done' && enriched.errored === true) void classifyRateLimit(enriched)")
    // The reading is taken from the pane by the shared reader, and the mirror write comes FIRST —
    // it is what the delivery gate reads, before any sender can be held.
    const fn = between(MAIN, 'const classifyRateLimit = async (', '\n  const emitAgentStatus')
    expect(fn).toContain('scanPaneForRateLimit(')
    expect(fn).toContain('noteRateLimit(e.nodeId, scan.verdict)')
    expect(fn).toContain("sendToMain(IPC.agentRateLimited, { nodeId: e.nodeId, verdict: scan.verdict })")
    expect(fn.indexOf('noteRateLimit')).toBeLessThan(fn.indexOf('sendToMain'))
  })

  it('the Server Edition takes the SAME reading, so the two shells cannot disagree', () => {
    expect(SERVER_INDEX).toContain('captureSession: (nodeId) => ptyManager.captureSession(nodeId, false)')
    expect(SERVER_STATUS).toContain('scanPaneForRateLimit(nodeId, capture, () => Date.now())')
    expect(SERVER_STATUS).toContain('platform.broadcast(IPC.agentRateLimited, { nodeId, verdict: scan.verdict })')
  })

  it('the renderer subscribes, and the effect still returns BOTH unsubscribes', () => {
    expect(CANVAS).toContain('api.onAgentRateLimited?.((p) => {')
    expect(CANVAS).toContain('useAgentStatus.getState().setRateLimited(p.nodeId, p.verdict)')
    // `onAgentStatus` used to be returned directly; a second subscription must not leak its listener
    // on unmount, which is the one thing a source read CAN see.
    expect(CANVAS).toContain('const offStatus = api.onAgentStatus(')
    expect(CANVAS).toContain('offStatus()')
    expect(CANVAS).toContain('offRateLimited?.()')
  })

  it('a browser canvas gets it too — the bridge forwards the channel', () => {
    expect(BRIDGE).toContain('onAgentRateLimited: (listener) =>')
    expect(BRIDGE).toContain('client.subscribe(IPC.agentRateLimited, listener as Listener)')
  })

  it('the store clears it on a genuine new turn, on the fast path included', () => {
    expect(STORE).toContain('setRateLimited(id: string, verdict: RateLimitReading | null): void')
    // The same-state fast path returns the SAME object, so a clearing that was not accounted for in
    // its bail condition would be silently skipped.
    const moves = between(STORE, 'const turnErrorMoves =', 'const interruptNext')
    expect(moves).toContain('prev.rateLimited !== undefined')
    expect(STORE).toContain('next.rateLimited = undefined')
  })

  it('`list` prints the cooldown from the reading and the clock — never from the field’s presence', () => {
    expect(ROUTING).toContain('rateLimitedFor !== undefined ? { rateLimitedFor }')
    expect(ROUTING).toContain('限流中(≈${n.rateLimitedFor}s)')
    const helper = between(ROUTING, 'function rateLimitSecondsLeft(', '\n/**')
    expect(helper).toContain('reading.at + reading.retryAfterMs - now')
    expect(helper).toContain('left > 0 ? Math.ceil(left / 1000) : undefined')
  })
})

describe('T237 — the wirings the queue cannot test from inside', () => {
  it('the station monitor reads the same standing reading main took', () => {
    expect(MAIN).toContain('rateLimitOf: (id) => mirrorEntry(id)?.rateLimited,')
  })

  it('the delivery hands the gate the host’s THREE-state answer, unfolded', () => {
    const run = between(MAIN, 'hasLiveSession: (id) => ptyManager.sessionLiveness(id)', '\n')
    expect(run.length).toBeGreaterThan(0) // the desktop probe is the tri-state one
    const messaging = read('core/agents/agent-messaging.ts')
    expect(messaging).toContain('targetLiveness: await deps.hasLiveSession(req.targetNodeId)')
    // The fold that used to live here (`!== 'gone'`) is gone: `unknown` must not be expressible as
    // `gone` at the fact, only at the gate — see `decidePreProbe`. Asserted as the ABSENCE of the
    // old fact name, because a mutation that simply ADDS a folded `targetLive:` beside the new one
    // would satisfy any `toContain` about the new one.
    expect(messaging).not.toContain("targetLive: (await deps.hasLiveSession")
    expect(messaging).not.toContain('targetLive:')
  })
})
