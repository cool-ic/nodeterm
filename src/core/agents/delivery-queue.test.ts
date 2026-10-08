import { describe, it, expect, vi } from 'vitest'
import {
  DeliveryQueue,
  DELIVERY_QUEUE_CAPACITY,
  DELIVERY_QUEUE_TTL_MS,
  EXPIRY_REASON_TEXT,
  RATE_LIMIT_MAX_ATTEMPTS,
  RATE_LIMIT_MAX_BACKOFF_MS,
  RATE_LIMIT_MAX_WAIT_MS,
  type DeliveryQueueDeps,
  type QueueExpiryReason,
  type QueuedDeliveryRequest,
  type CancelTimer
} from './delivery-queue'
import type { AgentMessageOutcome } from './agent-message-decide'
import { RETRYABLE } from './agent-message-decide'

/**
 * The bounded per-target queue, every rule driven with a fake clock, a fake scheduler and a
 * programmable `deliver` — so TTL expiry and flush-time re-validation are deterministic rather than
 * timing-dependent. The load-bearing test is the third-from-last: a grant revoked WHILE a message is
 * queued is dropped, not delivered, because the flush re-runs the whole delivery instead of trusting
 * the decision that queued it.
 */

interface FakeTimer {
  ms: number
  fn: () => void
  cancelled: boolean
}

function harness(over: Partial<DeliveryQueueDeps> = {}) {
  let clock = 1000
  const traced: { outcome: string; sourceNodeId: string; targetNodeId: string; reason?: string }[] = []
  const expired: {
    req: QueuedDeliveryRequest
    info: { traceId: string; queuedForMs: number; reason: QueueExpiryReason }
  }[] = []
  const flushed: { req: QueuedDeliveryRequest; outcome: AgentMessageOutcome }[] = []
  const woken: string[] = []
  const timers: FakeTimer[] = []
  let nextOutcome: AgentMessageOutcome = { kind: 'delivered', traceId: 'd', traced: 'memory', receipt: 'observed', signal: 'newTurn' }
  const delivered: QueuedDeliveryRequest[] = []

  const deps: DeliveryQueueDeps = {
    now: () => clock,
    deliver: async (req) => {
      delivered.push(req)
      return nextOutcome
    },
    trace: async (input) => {
      traced.push({
        outcome: input.outcome,
        sourceNodeId: input.sourceNodeId,
        targetNodeId: input.targetNodeId,
        ...(input.reason ? { reason: input.reason } : {})
      })
      return { traceId: `trace-${traced.length}`, traced: 'memory' }
    },
    wake: (id) => woken.push(id),
    onExpired: (req, info) => expired.push({ req, info }),
    onFlushed: (req, outcome) => flushed.push({ req, outcome }),
    schedule: (ms, fn): CancelTimer => {
      const t: FakeTimer = { ms, fn, cancelled: false }
      timers.push(t)
      return () => {
        t.cancelled = true
      }
    },
    ...over
  }

  return {
    deps,
    traced,
    expired,
    flushed,
    woken,
    timers,
    delivered,
    setClock: (n: number): void => {
      clock = n
    },
    setOutcome: (o: AgentMessageOutcome): void => {
      nextOutcome = o
    },
    /** Fire the most recently armed (not-yet-cancelled) timer — a TTL lapse. */
    fireLatestTimer: (): void => {
      const live = timers.filter((t) => !t.cancelled)
      live[live.length - 1].fn()
    }
  }
}

const req = (over: Partial<QueuedDeliveryRequest> = {}): QueuedDeliveryRequest => ({
  sourceNodeId: 'src',
  targetNodeId: 'dst',
  sourceTitle: 'Alpha',
  body: 'ping',
  ...over
})

describe('DeliveryQueue', () => {
  it('enqueue returns a queued receipt with position + TTL, and traces `queued`', async () => {
    const h = harness()
    const q = new DeliveryQueue(h.deps)
    const out = await q.enqueue(req())
    expect(out).toEqual({ kind: 'queued', traceId: 'trace-1', position: 1, ttlMs: DELIVERY_QUEUE_TTL_MS })
    expect(q.depth('dst')).toBe(1)
    expect(h.traced).toEqual([{ outcome: 'queued', sourceNodeId: 'src', targetNodeId: 'dst' }])
  })

  it('positions count up per target', async () => {
    const h = harness()
    const q = new DeliveryQueue(h.deps)
    const a = await q.enqueue(req({ body: 'a' }))
    const b = await q.enqueue(req({ body: 'b' }))
    expect(a).toMatchObject({ kind: 'queued', position: 1 })
    expect(b).toMatchObject({ kind: 'queued', position: 2 })
    expect(q.depth('dst')).toBe(2)
  })

  it('refuses with `queueFull` at capacity — never drops an accepted message', async () => {
    const h = harness()
    const q = new DeliveryQueue(h.deps, { capacity: 2 })
    await q.enqueue(req({ body: 'a' }))
    await q.enqueue(req({ body: 'b' }))
    const out = await q.enqueue(req({ body: 'c' }))
    expect(out).toEqual({ kind: 'queueFull', capacity: 2 })
    // The two already queued are untouched — capacity refuses the new one, it does not evict.
    expect(q.depth('dst')).toBe(2)
  })

  it('flushes on idle: delivers oldest-first and empties the queue', async () => {
    const h = harness()
    const q = new DeliveryQueue(h.deps)
    await q.enqueue(req({ body: 'first' }))
    await q.enqueue(req({ body: 'second' }))
    await q.onTargetIdle('dst')
    expect(h.delivered.map((r) => r.body)).toEqual(['first', 'second'])
    expect(q.depth('dst')).toBe(0)
    expect(h.flushed.map((f) => f.outcome.kind)).toEqual(['delivered', 'delivered'])
  })

  it('a hibernated target is WOKEN on enqueue, before it is idle', async () => {
    const h = harness()
    const q = new DeliveryQueue(h.deps)
    await q.enqueue(req(), { hibernated: true })
    expect(h.woken).toEqual(['dst'])
    // A merely-busy target is not woken.
    await q.enqueue(req({ targetNodeId: 'busy' }))
    expect(h.woken).toEqual(['dst'])
  })

  // ── THE LOAD-BEARING PROPERTY: flush-time re-validation ────────────────────────────────────────
  it('DROPS a message whose grant was revoked while it was queued — never delivers it', async () => {
    const h = harness()
    const q = new DeliveryQueue(h.deps)
    // Enqueued while the target was busy…
    await q.enqueue(req({ body: 'secret' }))
    expect(q.depth('dst')).toBe(1)
    // …and by flush time the grant is gone: `deliver` (the full re-validated path) now refuses.
    h.setOutcome({ kind: 'notPermitted', reason: 'switch-off' })
    await q.onTargetIdle('dst')
    // It was attempted through the real delivery (which is where the grant is checked) and DROPPED —
    // not re-queued, not delivered.
    expect(h.delivered.map((r) => r.body)).toEqual(['secret'])
    expect(q.depth('dst')).toBe(0)
    expect(h.flushed).toHaveLength(1)
    expect(h.flushed[0].outcome).toEqual({ kind: 'notPermitted', reason: 'switch-off' })
    // Never reported as delivered.
    expect(h.flushed.some((f) => f.outcome.kind === 'delivered')).toBe(false)
  })

  it('a still-busy target at flush keeps the message queued (TTL from the original enqueue)', async () => {
    const h = harness()
    const q = new DeliveryQueue(h.deps)
    await q.enqueue(req())
    h.setOutcome({ kind: 'targetBusy', state: 'working' })
    await q.onTargetIdle('dst')
    // Attempted, found busy again, put back — not lost, not delivered.
    expect(h.delivered).toHaveLength(1)
    expect(q.depth('dst')).toBe(1)
    expect(h.flushed).toHaveLength(0)
    // A later idle when it is truly free delivers it.
    h.setOutcome({ kind: 'delivered', traceId: 'd', traced: 'memory', receipt: 'observed', signal: 'newTurn' })
    await q.onTargetIdle('dst')
    expect(q.depth('dst')).toBe(0)
    expect(h.flushed.map((f) => f.outcome.kind)).toEqual(['delivered'])
  })

  // ── TTL expiry — never a silent drop ──────────────────────────────────────────────────────────
  it('a TTL lapse traces `expired` AND tells the sender, then removes the entry', async () => {
    const h = harness()
    const q = new DeliveryQueue(h.deps, { ttlMs: 1000 })
    await q.enqueue(req())
    expect(q.depth('dst')).toBe(1)
    h.setClock(1000 + 1000) // the TTL has elapsed
    h.fireLatestTimer()
    await Promise.resolve() // let the async expiry settle
    await Promise.resolve()
    expect(q.depth('dst')).toBe(0)
    // Both legs: the durable trace and the live notify.
    expect(h.traced.map((t) => t.outcome)).toContain('expired')
    expect(h.expired).toHaveLength(1)
    expect(h.expired[0].info.queuedForMs).toBe(1000)
    expect(h.expired[0].info.traceId).toBeTruthy()
  })

  // ── T228③: the TARGET's provider cooldown — a clock, never a drop ──────────────────────────────
  describe('T228③ — a rate-limited entry backs off and is never dropped on the limit itself', () => {
    const limited = (ms: number): AgentMessageOutcome => ({
      kind: 'rateLimited',
      retryAfterMs: ms,
      rateLimitedUntil: 1000 + ms
    })

    it('puts the entry back on a TIMER (not the next idle) and re-offers it after the backoff', async () => {
      const h = harness()
      const q = new DeliveryQueue(h.deps, { ttlMs: 60 * 60_000 })
      await q.enqueue(req())
      h.setOutcome(limited(60_000))
      await q.onTargetIdle('dst')
      // Attempted, met the cooldown, still ours — not delivered, not dead-lettered.
      expect(h.delivered).toHaveLength(1)
      expect(q.depth('dst')).toBe(1)
      expect(h.expired).toEqual([])
      // The re-offer is a CLOCK: a rate-limited target goes idle immediately, so waiting for an
      // idle event would wait forever. The first ladder rung IS the provider's own retryAfter.
      const nudge = h.timers.filter((t) => !t.cancelled).at(-1)!
      expect(nudge.ms).toBe(60_000)

      // Fire it, still limited: the rung DOUBLES (exponential), and the entry survives.
      h.setClock(1000 + 60_000)
      nudge.fn()
      await vi.waitFor(() => expect(h.delivered).toHaveLength(2))
      const second = h.timers.filter((t) => !t.cancelled).at(-1)!
      expect(second.ms).toBe(120_000)

      // Fire it again with the limit lifted: it delivers, and the sender hears `delivered`.
      h.setClock(1000 + 60_000 + 120_000)
      h.setOutcome({ kind: 'delivered', traceId: 'd', traced: 'memory', receipt: 'observed', signal: 'newTurn' })
      second.fn()
      await vi.waitFor(() => expect(q.depth('dst')).toBe(0))
      expect(h.flushed.map((f) => f.outcome.kind)).toEqual(['delivered'])
      expect(h.expired).toEqual([])
    })

    it('a `done` from the very turn that hit the limit does NOT burn a rung', async () => {
      // The field shape: the cooldown starts, and the errored turn's own `done` arrives a moment
      // later. Without the hold guard that event would spend an attempt and re-arm a shorter clock
      // every time the target errored — a ladder that never gets anywhere and tells the sender
      // nothing.
      const h = harness()
      const q = new DeliveryQueue(h.deps, { ttlMs: 60 * 60_000 })
      await q.enqueue(req())
      h.setOutcome(limited(60_000))
      await q.onTargetIdle('dst')
      expect(h.delivered).toHaveLength(1)
      h.setClock(1000 + 5_000) // five seconds in: the hold is still running
      await q.onTargetIdle('dst')
      // No second delivery attempt was spent…
      expect(h.delivered).toHaveLength(1)
      expect(q.depth('dst')).toBe(1)
      // …and the pending re-offer is the one the backoff already armed (the queue keeps at most one
      // nudge per target, so the hold's remainder does not arm a second clock). It still fires at
      // the hold's own deadline, which is what the entry is waiting for.
      const nudge = h.timers.filter((t) => !t.cancelled).at(-1)!
      expect(nudge.ms).toBe(60_000)
    })

    it('past the attempt cap it becomes a DEAD LETTER on the T234 in-band path, saying which limit', async () => {
      const h = harness()
      const q = new DeliveryQueue(h.deps, { ttlMs: 24 * 60 * 60_000 })
      await q.enqueue(req())
      h.setOutcome(limited(60_000))
      let clock = 1000
      await q.onTargetIdle('dst') // attempt 1 meets the cooldown → the first rung is 60s
      const rungs: number[] = []
      for (let i = 0; q.depth('dst') > 0 && i < 12; i++) {
        const nudge = h.timers.filter((t) => !t.cancelled).at(-1)!
        rungs.push(nudge.ms)
        clock += nudge.ms
        h.setClock(clock)
        nudge.fn() // firing also clears the queue's one-nudge-per-target dedup
        await vi.waitFor(() => expect(h.delivered.length).toBe(i + 2))
      }
      // The ladder is the ticket's: the provider's own retryAfter first, then ×2, capped.
      expect(rungs).toEqual([60_000, 120_000, 240_000, 480_000])
      await vi.waitFor(() => expect(h.expired).toHaveLength(1))
      expect(q.depth('dst')).toBe(0)
      expect(h.expired[0].info.reason).toBe('rate-limit-exhausted')
      // Never reported as delivered, and never dropped in silence: the durable trace line carries
      // the reason IN WORDS and the in-band notice reads the same table (`EXPIRY_REASON_TEXT`).
      expect(h.flushed).toEqual([])
      const line = h.traced.find((t) => t.outcome === 'expired')
      expect(line?.reason).toBe(EXPIRY_REASON_TEXT['rate-limit-exhausted'])
      expect(line?.reason).toContain('rate limiting')
      expect(line?.reason).not.toContain('session')
    })

    it('the backoff is CAPPED at ten minutes, however long the provider asks', async () => {
      const h = harness()
      const q = new DeliveryQueue(h.deps, { ttlMs: 24 * 60 * 60_000 })
      await q.enqueue(req())
      h.setOutcome(limited(30 * 60_000)) // the provider says half an hour
      await q.onTargetIdle('dst')
      const nudge = h.timers.filter((t) => !t.cancelled).at(-1)!
      expect(nudge.ms).toBe(RATE_LIMIT_MAX_BACKOFF_MS)
    })

    it('the total-wait cap ends it early even when attempts remain', async () => {
      // A short cooldown can ladder many times inside a long wait; the ticket bounds the WAIT as
      // well as the count, so a station whose provider re-limits for an hour does not hold its
      // sender's mail for an hour.
      const h = harness()
      const q = new DeliveryQueue(h.deps, { ttlMs: 24 * 60 * 60_000 })
      await q.enqueue(req())
      h.setOutcome(limited(60_000))
      await q.onTargetIdle('dst')
      h.setClock(1000 + RATE_LIMIT_MAX_WAIT_MS)
      await q.onTargetIdle('dst')
      await vi.waitFor(() => expect(h.expired).toHaveLength(1))
      expect(h.expired[0].info.reason).toBe('rate-limit-exhausted')
      expect(q.depth('dst')).toBe(0)
    })

    it('REGRESSION — a pair-window `rateLimited` (no `rateLimitedUntil`) keeps its old meaning', async () => {
      // The sender's own pacing is NOT the target's cooldown: it waits for the next idle exactly as
      // it always did, is never given a backoff ladder, and never becomes a dead letter on a timer.
      const h = harness()
      const q = new DeliveryQueue(h.deps)
      await q.enqueue(req())
      h.setOutcome({ kind: 'rateLimited', retryAfterMs: 5000 })
      await q.onTargetIdle('dst')
      expect(h.delivered).toHaveLength(1)
      expect(q.depth('dst')).toBe(1)
      expect(h.expired).toEqual([])
      // One timer, its TTL — no second, shorter nudge was armed for a backoff.
      expect(h.timers.filter((t) => !t.cancelled)).toHaveLength(1)
      expect(h.timers.filter((t) => !t.cancelled)[0].ms).toBe(DELIVERY_QUEUE_TTL_MS)
    })
  })

  it('a TTL lapse on a LIVE target re-arms instead of expiring (a busy turn may outlive the TTL)', async () => {
    const h = harness({ sessionLiveness: async () => 'live' })
    const q = new DeliveryQueue(h.deps, { ttlMs: 1000 })
    await q.enqueue(req())
    h.setClock(1000 + 1000)
    const timersBefore = h.timers.length
    h.fireLatestTimer()
    await Promise.resolve()
    await Promise.resolve()
    // Still queued; a fresh timer was armed; nothing was traced expired and the sender was not told.
    expect(q.depth('dst')).toBe(1)
    expect(h.timers.length).toBeGreaterThan(timersBefore)
    expect(h.expired).toHaveLength(0)
    expect(h.traced.map((t) => t.outcome)).not.toContain('expired')
  })

  it('a TTL lapse on a GONE target expires loudly and SAYS the session is gone', async () => {
    const h = harness({ sessionLiveness: async () => 'gone' })
    const q = new DeliveryQueue(h.deps, { ttlMs: 1000 })
    await q.enqueue(req())
    h.setClock(1000 + 1000)
    h.fireLatestTimer()
    // The probe adds a microtask turn to the expiry path; wait on the effect, not on a tick count.
    await vi.waitFor(() => expect(h.expired).toHaveLength(1))
    expect(q.depth('dst')).toBe(0)
    expect(h.expired[0].info.reason).toBe('session-gone')
  })

  // ── T207b: "could not ask" is not "gone" ─────────────────────────────────────────────────────
  it('an UNANSWERABLE probe expires as UNCERTAIN — never as a death', async () => {
    // The field case: a hand-resumed pane, alive in tmux, absent from this process's registry.
    // The old boolean folded that into "the session is gone" and the dead letter said so.
    const h = harness({ sessionLiveness: async () => 'unknown' })
    const q = new DeliveryQueue(h.deps, { ttlMs: 1000 })
    await q.enqueue(req())
    h.setClock(1000 + 1000)
    h.fireLatestTimer()
    await vi.waitFor(() => expect(h.expired).toHaveLength(1))
    expect(h.expired[0].info.reason).toBe('session-unknown')
    // The durable line carries it too, in words: the sender reads that one after a reload.
    const expired = h.traced.find((t) => t.outcome === 'expired')
    expect(expired?.reason).toContain('could not confirm')
  })

  it('a probe that THROWS is uncertainty, not a death — the sender is told which', async () => {
    const h = harness({
      sessionLiveness: async () => {
        throw new Error('pty gone')
      }
    })
    const q = new DeliveryQueue(h.deps, { ttlMs: 1000 })
    await q.enqueue(req())
    h.setClock(1000 + 1000)
    h.fireLatestTimer()
    await vi.waitFor(() => expect(h.expired).toHaveLength(1))
    expect(q.depth('dst')).toBe(0)
    expect(h.expired[0].info.reason).toBe('session-unknown')
  })

  it('NO probe wired at all is uncertainty too (the receipt promises no deadline it cannot keep)', async () => {
    const h = harness({})
    const q = new DeliveryQueue(h.deps, { ttlMs: 1000 })
    await q.enqueue(req())
    h.setClock(1000 + 1000)
    h.fireLatestTimer()
    await vi.waitFor(() => expect(h.expired).toHaveLength(1))
    expect(h.expired[0].info.reason).toBe('session-unknown')
  })

  it('an expiry timer that fires AFTER the entry already flushed is a no-op (no double drop)', async () => {
    const h = harness()
    const q = new DeliveryQueue(h.deps, { ttlMs: 1000 })
    await q.enqueue(req())
    await q.onTargetIdle('dst') // delivered — the entry is gone, its timer cancelled
    expect(q.depth('dst')).toBe(0)
    // A stale timer fire (belt-and-braces: the entry is no longer in any list) must not expire.
    const before = h.expired.length
    h.timers[0].fn()
    await Promise.resolve()
    expect(h.expired.length).toBe(before)
  })

  it('the constants are finite and positive — a real bound and a real TTL', () => {
    expect(DELIVERY_QUEUE_CAPACITY).toBeGreaterThan(0)
    expect(Number.isFinite(DELIVERY_QUEUE_CAPACITY)).toBe(true)
    expect(DELIVERY_QUEUE_TTL_MS).toBeGreaterThan(0)
    expect(Number.isFinite(DELIVERY_QUEUE_TTL_MS)).toBe(true)
  })
  // T234 — a flush that did not reach the pane. Which of the two write outcomes it is decides
  // whether the entry survives, and that split is the whole ticket: a write that burned its bounded
  // retries against a live session is terminal (and the sender is told), while a write that failed
  // because the shell was quitting, or because the probe could not answer, is a HOLD.
  it('a held write keeps the entry queued and drains no further', async () => {
    const h = harness()
    h.setOutcome({ kind: 'targetWriteHeld', attempts: 4, reason: 'shell-teardown' })
    const q = new DeliveryQueue(h.deps)
    await q.enqueue(req())
    await q.onTargetIdle('dst')
    expect(q.depth('dst')).toBe(1)
    // Held is not an ending: no `onFlushed`, so no sender notice and no chip settling.
    expect(h.flushed).toEqual([])
    expect(h.expired).toEqual([])
  })

  it('an exhausted write against a live session IS terminal, and reaches the sender', async () => {
    const h = harness()
    h.setOutcome({ kind: 'targetWriteFailed', attempts: 4, reason: 'retries-exhausted' })
    const q = new DeliveryQueue(h.deps)
    await q.enqueue(req())
    await q.onTargetIdle('dst')
    expect(q.depth('dst')).toBe(0)
    expect(h.flushed).toHaveLength(1)
    expect(h.flushed[0].outcome).toEqual({
      kind: 'targetWriteFailed',
      attempts: 4,
      reason: 'retries-exhausted'
    })
  })

  it('an ordinary send that expires is still reported retryable — the T207 behavior is unchanged', () => {
    // The regression nail: `expired` stays retryable for the sender, so the receipt and the notice
    // keep telling it to try once more. T234 added outcomes; it did not reclassify any.
    expect(RETRYABLE.expired).toBe(true)
  })

})
