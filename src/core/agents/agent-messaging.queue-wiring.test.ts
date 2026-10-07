import { describe, it, expect, vi } from 'vitest'
import { createDeliveryQueue, type AgentMessagingDeps } from './agent-messaging'
import { DELIVERY_QUEUE_TTL_MS, type QueueExpiryReason, type QueuedDeliveryRequest } from './delivery-queue'

/**
 * THE FACTORY'S WIRING, not the queue's rules (those live in `delivery-queue.test.ts`, which builds
 * `new DeliveryQueue(deps)` by hand).
 *
 * This file exists because of a field failure with exactly that shape: T205 added
 * `sessionLiveness` to reading code and to `AgentMessagingDeps`, every unit test constructed the
 * queue with the probe, and `createDeliveryQueue` — the ONE builder both shells use — never
 * forwarded it. So both re-arm paths (a live target's TTL, a lapsed entry at restore) were dead
 * code in the app, a queued message to a pane whose tmux session was alive expired on schedule, and
 * the dead letter announced that the session was gone. A test of the seam cannot see a hole in the
 * wiring; these tests drive the builder the shells drive, and assert on the PROBE being reached.
 */
function factoryDeps(over: Partial<AgentMessagingDeps> = {}) {
  const probes: string[] = []
  const expiredInBand: {
    req: QueuedDeliveryRequest
    info: { traceId: string; queuedForMs: number; reason: QueueExpiryReason }
  }[] = []
  const deps: AgentMessagingDeps = {
    paneOwner: async () => null,
    sendEnvelope: async () => true,
    hasLiveSession: (id) => {
      probes.push(id)
      return 'live'
    },
    projects: () => [{ id: 'p1', nodes: [{ id: 'a1', title: 'Alpha' }, { id: 'b1', title: 'Beta' }] }],
    isRemoteNode: () => false,
    messagingEnabled: () => true,
    paneOwnerProject: () => 'p1',
    customAgents: () => undefined,
    appendBoardLog: async () => false,
    onExpiredInBand: (req, info) => expiredInBand.push({ req, info }),
    ...over
  }
  return { deps, probes, expiredInBand }
}

/** A queue built the way a shell builds it, with a scheduler the test fires by hand. */
function wiredQueue(over: Partial<AgentMessagingDeps> = {}) {
  const f = factoryDeps(over)
  const timers: { fn: () => void; cancelled: boolean }[] = []
  const queue = createDeliveryQueue(f.deps, {
    ttlMs: 1000,
    schedule: (_ms, fn) => {
      const t = { fn, cancelled: false }
      timers.push(t)
      return () => {
        t.cancelled = true
      }
    }
  })
  return {
    ...f,
    queue,
    /** Fire the most recently armed, still-pending timer — a TTL lapse. */
    lapse: (): void => {
      const live = timers.filter((t) => !t.cancelled)
      live[live.length - 1].fn()
    }
  }
}

const req = (over: Partial<QueuedDeliveryRequest> = {}): QueuedDeliveryRequest => ({
  verb: 'send',
  sourceNodeId: 'a1',
  targetNodeId: 'b1',
  sourceTitle: 'Alpha',
  body: 'ping',
  ...over
})

describe('createDeliveryQueue forwards the session-liveness probe (T207b)', () => {
  it('a TTL lapse on a LIVE target asks the host and RE-ARMS — the entry is not dropped', async () => {
    const h = wiredQueue()
    await h.queue.enqueue(req())
    h.lapse()
    // The probe is the thing that was missing: without the forward, this list stays empty and the
    // entry is dropped below.
    await vi.waitFor(() => expect(h.probes).toEqual(['b1']))
    expect(h.queue.depth('b1')).toBe(1)
    expect(h.expiredInBand).toEqual([])
  })

  it('a TTL lapse on a GONE target expires WITH the reason the dead letter needs', async () => {
    const h = wiredQueue({ hasLiveSession: () => 'gone' })
    await h.queue.enqueue(req())
    h.lapse()
    await vi.waitFor(() => expect(h.expiredInBand).toHaveLength(1))
    expect(h.queue.depth('b1')).toBe(0)
    expect(h.expiredInBand[0].info.reason).toBe('session-gone')
    // Real clock here (the harness uses Date.now), so only the shape is pinned.
    expect(h.expiredInBand[0].info.queuedForMs).toBeGreaterThanOrEqual(0)
  })

  it('a TTL lapse the host cannot answer for expires as UNCERTAIN, never as a death', async () => {
    const h = wiredQueue({ hasLiveSession: () => 'unknown' })
    await h.queue.enqueue(req())
    h.lapse()
    await vi.waitFor(() => expect(h.expiredInBand).toHaveLength(1))
    expect(h.expiredInBand[0].info.reason).toBe('session-unknown')
  })

  it('a lapsed entry at RESTORE asks the host before declaring it dead, and re-queues a live one', async () => {
    // The field case verbatim: a message queued before a restart, its TTL running out while the app
    // was down, its target's tmux session alive the whole time. The old order expired any
    // clock-lapsed entry without asking, which is what produced the dead letter.
    const h = wiredQueue()
    await h.queue.restore([
      {
        req: req(),
        // Queued one full TTL plus a minute ago: the deadline passed while the app was down.
        enqueuedAt: -DELIVERY_QUEUE_TTL_MS - 60_000,
        ttlMs: DELIVERY_QUEUE_TTL_MS,
        queuedTraceId: 'q1'
      }
    ])
    expect(h.probes, 'the restore path must ask the host').toEqual(['b1'])
    expect(h.queue.depth('b1'), 'a live target keeps the entry').toBe(1)
    expect(h.expiredInBand).toEqual([])
  })

  it('a lapsed entry the host says is gone expires at restore, WITH the reason', async () => {
    const h = wiredQueue({ hasLiveSession: () => 'gone' })
    await h.queue.restore([
      {
        req: req(),
        enqueuedAt: -DELIVERY_QUEUE_TTL_MS - 60_000,
        ttlMs: DELIVERY_QUEUE_TTL_MS,
        queuedTraceId: 'q1'
      }
    ])
    expect(h.expiredInBand).toHaveLength(1)
    expect(h.expiredInBand[0].info.reason).toBe('session-gone')
  })

  it('an entry that cannot be restored says THAT, not that the session died', async () => {
    // A board comment is never replayed into a pane after a restart, and an over-size body is
    // written reduced. Neither is a session fact, and the old wording asserted one anyway.
    const h = wiredQueue({ hasLiveSession: () => 'live' })
    await h.queue.restore([
      {
        req: req({ verb: 'board-comment', sourceNodeId: 'board-comment:c1' }),
        enqueuedAt: -1_000,
        ttlMs: DELIVERY_QUEUE_TTL_MS,
        queuedTraceId: 'q1'
      }
    ])
    expect(h.expiredInBand).toHaveLength(1)
    expect(h.expiredInBand[0].info.reason).toBe('not-restorable')
  })
})
