/**
 * T228 — THE SHELL-SIDE HOLD, end to end through the messaging service.
 *
 * `delivery-queue.test.ts` proves the queue's ladder and `agent-message.test.ts` proves the gate
 * writes no bytes. This file proves the JOIN between them, which is the part the ticket actually
 * asked for: a `send` to a target whose provider is cooling down comes back `queued` — held on a
 * CLOCK, with the reason in the sender's own words — while the sender's own pair window keeps
 * exactly the meaning it had before (a plain refusal). It also pins the third branch of the pane
 * scan, which is the one a two-valued verdict would get wrong.
 *
 * The renderer-side halves of the same ticket (the store field and the `list` column) live in the
 * WEB project's tests — a core test may not import them, and the layer boundary is worth more than
 * one tidy file (`no-electron.test.ts` guards the neighbouring edge).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createDeliveryQueue, deliverFromControl, type AgentMessagingDeps } from './agent-messaging'
import type { RateLimitReading } from '../../shared/agents/agent-messaging'
import { resetMessageFlow } from './agent-message-flow'
import { resetAgentMessageTraceForTests } from './agent-message-trace'
import { scanPaneForRateLimit } from './rate-limit-classify'
import { noteRateLimit, mirrorEntry, buildFile, recordAgentEvent, _resetForTest } from '../agent-status-mirror'
import { EXPIRY_REASON_TEXT } from './delivery-queue'
import { MANAGED_SCRIPT_REVISION } from './hooks/managed-script'
import type { MirrorEntry } from '../agent-status-mirror'
import type { BoardLogEntry } from '../../shared/types'

const idle: MirrorEntry = {
  state: 'done',
  updatedAt: 1,
  stateVerified: true,
  clientRevision: MANAGED_SCRIPT_REVISION
}

const reading = (over: Partial<RateLimitReading> = {}): RateLimitReading => ({
  kind: 'rateLimited',
  signature: 'too-many-requests',
  detail: 'the provider is rate limiting (TooManyRequests)',
  retryAfterMs: 120_000,
  defaulted: false,
  at: 1_000_000,
  ...over
})

function fakeDeps(over: Partial<AgentMessagingDeps> = {}) {
  const rec = {
    paneOwnerCalls: [] as string[],
    sent: [] as { nodeId: string; payload: string }[],
    log: [] as { projectId: string; entry: BoardLogEntry }[]
  }
  const projectsFn = () => [
    {
      id: 'p1',
      nodes: [
        { id: 'a1', title: 'Alpha', agentId: 'claude' },
        { id: 'b1', title: 'Beta', agentId: 'claude' }
      ]
    }
  ]
  const deps: AgentMessagingDeps = {
    paneOwner: async (nodeId) => {
      rec.paneOwnerCalls.push(nodeId)
      return { tty: '/dev/pts/9', panePid: 100, paneId: '%1', command: 'claude', argv: ['claude'], pids: [200] }
    },
    sendEnvelope: async (nodeId, payload) => {
      rec.sent.push({ nodeId, payload })
      return true
    },
    hasLiveSession: () => 'live',
    mirrorEntry: () => idle,
    projects: projectsFn,
    isRemoteNode: () => false,
    messagingEnabled: () => true,
    paneOwnerProject: (id) => projectsFn().find((p) => p.nodes.some((n) => n.id === id))?.id,
    customAgents: () => undefined,
    appendBoardLog: async (projectId, entry) => {
      rec.log.push({ projectId, entry })
      return true
    },
    subscribeReceipts: (cb) => {
      const t = setTimeout(() => cb({ nodeId: 'b1', newTurn: true, verified: true }), 5)
      return () => clearTimeout(t)
    },
    now: () => 1_000_000,
    ...over
  }
  return { deps, rec }
}

const send = (over: Record<string, unknown> = {}) => ({
  verb: 'send' as const,
  sourceNodeId: 'a1',
  targetNodeId: 'b1',
  body: 'do the thing',
  ...over
})

beforeEach(() => {
  resetMessageFlow()
  resetAgentMessageTraceForTests()
})

describe('T228② — a target inside its provider’s cooldown is HELD, not sent into a doomed turn', () => {
  it('comes back `queued`, names the cooldown in the sender’s terms, and arms a clock', async () => {
    const { deps, rec } = fakeDeps({ mirrorEntry: () => ({ ...idle, rateLimited: reading() }) })
    // The cooldown is 120s from `at`, and `now` IS `at`, so the full 120s is left.
    const timers: number[] = []
    deps.queue = createDeliveryQueue(deps, {
      schedule: (ms) => {
        timers.push(ms)
        return () => {}
      }
    })
    const { outcome } = await deliverFromControl(send(), deps)
    expect(outcome.kind).toBe('queued')
    expect((outcome as { queuedBecause?: string }).queuedBecause).toContain('rate limiting it')
    expect((outcome as { queuedBecause?: string }).queuedBecause).toContain('≈120s')
    // NOTHING was typed, and the pane was never even probed: the gate is decided from the reading.
    expect(rec.sent).toEqual([])
    expect(rec.paneOwnerCalls).toEqual([])
    // Held by a CLOCK (120s + a small slack), not by the target's next idle.
    expect(timers).toContain(120_500)
  })

  it('REGRESSION — the sender’s own pair window is still a plain refusal, unqueued', async () => {
    // The pair limiter refuses before the queue is consulted, and T228 must not have turned that
    // into a wait: a sender told `rateLimited` retries on its own, and queueing it would change the
    // meaning of an outcome the ticket explicitly freezes.
    const { deps, rec } = fakeDeps()
    deps.queue = createDeliveryQueue(deps)
    await deliverFromControl(send(), deps) // spend the pair window
    const second = await deliverFromControl(send(), deps)
    expect(second.outcome.kind).toBe('rateLimited')
    expect((second.outcome as { rateLimitedUntil?: number }).rateLimitedUntil).toBeUndefined()
    expect(second.reply.error).toContain('over the messaging budget')
    expect(rec.sent).toHaveLength(1) // only the first got through
  })

  it('a LAPSED reading delivers normally — the hold is a deadline, not a flag', async () => {
    const { deps, rec } = fakeDeps({
      mirrorEntry: () => ({ ...idle, rateLimited: reading({ retryAfterMs: 500 }) }),
      now: () => 1_000_000 + 60_000
    })
    const { outcome } = await deliverFromControl(send(), deps)
    expect(outcome.kind).toBe('delivered')
    expect(rec.sent).toHaveLength(1)
  })

  it('with NO queue wired the cooldown is refused, and the words say it is the TARGET’s limit', async () => {
    const { deps, rec } = fakeDeps({ mirrorEntry: () => ({ ...idle, rateLimited: reading() }) })
    const { outcome, reply } = await deliverFromControl(send(), deps)
    expect(outcome).toEqual({ kind: 'rateLimited', retryAfterMs: 120_000, rateLimitedUntil: 1_120_000 })
    expect(reply.error).toContain('the target’s provider is rate limiting it')
    expect(rec.sent).toEqual([])
  })
})

describe('T228 — the reading is taken off the pane, three ways', () => {
  const now = () => 1_000_000

  it('a pane that names a limit yields a reading stamped with the clock', async () => {
    const scan = await scanPaneForRateLimit(
      'b1',
      async () => 'Tool result error: TooManyRequests. Retry-After: 120',
      now
    )
    expect(scan).toEqual({
      kind: 'read',
      verdict: {
        kind: 'rateLimited',
        signature: 'too-many-requests',
        detail: expect.stringContaining('rate limiting'),
        retryAfterMs: 120_000,
        defaulted: false,
        at: 1_000_000
      }
    })
  })

  it('a pane that names NO limit is a real answer — it RETIRES a standing reading', async () => {
    // The nail: an ordinary model error must not be absorbed into `rateLimited`, and it must CLEAR a
    // stale one, or a node limited an hour ago would keep holding its senders' mail.
    expect(
      await scanPaneForRateLimit('b1', async () => 'API Error: 500 internal server error', now)
    ).toEqual({ kind: 'read', verdict: null })
  })

  it('nothing to read is NO EVIDENCE — the standing reading is left alone', async () => {
    // `captureSession` answers '' for a missing tmux, a session that is already gone and a backend
    // that cannot capture. None of those says anything about the turn, so no verdict is invented.
    expect(await scanPaneForRateLimit('b1', async () => '', now)).toEqual({ kind: 'no-evidence' })
    expect(await scanPaneForRateLimit('b1', async () => '   \n ', now)).toEqual({ kind: 'no-evidence' })
    expect(
      await scanPaneForRateLimit(
        'b1',
        async () => {
          throw new Error('no pty')
        },
        now
      )
    ).toEqual({ kind: 'no-evidence' })
  })
})

describe('T228③ — the sender hears the END of a cooldown that never lifted', () => {
  it('the expiry reason is in the one shared table, so every surface says the same thing', () => {
    const text = EXPIRY_REASON_TEXT['rate-limit-exhausted']
    expect(text).toContain('rate limiting')
    // …and it never claims a death: this is the provider's limit, not the session's.
    expect(text).not.toContain('session')
    expect(EXPIRY_REASON_TEXT['session-unknown']).toContain('could not confirm')
  })
})

describe('T228① — the mirror carries the reading, and retires it on the right edge', () => {
  beforeEach(() => _resetForTest())

  it('a genuine new turn clears it; a standing (even lapsed) one is kept for `list` to judge', () => {
    recordAgentEvent({
      nodeId: 'b1',
      agentId: 'claude',
      sessionId: 's1',
      kind: 'state',
      state: 'done',
      errored: true,
      verified: true
    } as never)
    noteRateLimit('b1', reading())
    expect(mirrorEntry('b1')?.rateLimited?.retryAfterMs).toBe(120_000)
    // A new prompt: the station is being asked something else. The reading described the turn that
    // ENDED, so it goes — exactly like the renderer's `lastTurnError`.
    recordAgentEvent({
      nodeId: 'b1',
      agentId: 'claude',
      sessionId: 's1',
      kind: 'state',
      state: 'working',
      newTurn: true,
      verified: true
    } as never)
    expect(mirrorEntry('b1')?.rateLimited).toBeUndefined()
    // A LAPSED reading survives (it still describes the turn that ended), and the DECISION about
    // whether the cooldown is over is `rateLimitCooldown`'s — the gate and the `list` column must
    // agree, so neither may read the field's presence as "still limited".
    noteRateLimit('b1', reading({ at: 0, retryAfterMs: 10 }))
    expect(mirrorEntry('b1')?.rateLimited).toBeDefined()
  })

  it('`buildFile` carries it to the file the phone reads, in the app’s OWN vocabulary', () => {
    recordAgentEvent({
      nodeId: 'b1',
      agentId: 'claude',
      sessionId: 's1',
      kind: 'state',
      state: 'done',
      errored: true,
      verified: true
    } as never)
    noteRateLimit('b1', reading())
    const file = buildFile({ b1: mirrorEntry('b1')! }, 1_000_001)
    const entry = file.nodes['b1'] as { rateLimited?: { signature?: string; detail?: string } }
    expect(entry.rateLimited?.signature).toBe('too-many-requests')
    // Never the pane's words: the detail is our sentence, and the provider's text stays in the pane.
    expect(entry.rateLimited?.detail).not.toContain('Tool result')
  })

  it('a no-op for an unknown node — a reading annotates a station, it does not create one', () => {
    noteRateLimit('ghost', reading())
    expect(mirrorEntry('ghost')).toBeUndefined()
  })

  it('`null` RETIRES the reading — the path an errored non-rate-limit turn takes', () => {
    recordAgentEvent({
      nodeId: 'b1',
      agentId: 'claude',
      sessionId: 's1',
      kind: 'state',
      state: 'done',
      errored: true,
      verified: true
    } as never)
    noteRateLimit('b1', reading())
    noteRateLimit('b1', null)
    expect(mirrorEntry('b1')?.rateLimited).toBeUndefined()
  })
})
