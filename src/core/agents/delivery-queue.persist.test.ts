import { describe, it, expect, vi } from 'vitest'
import {
  DeliveryQueue,
  DELIVERY_QUEUE_TTL_MS,
  QUEUE_FACT,
  QUEUE_PERSIST_BODY_MAX,
  QUEUE_PERSIST_BYTES_BUDGET,
  restoredBindingVerdict,
  sanitizePersistedQueueEntry,
  type CancelTimer,
  type DeliveryQueueDeps,
  type PersistedQueueEntry,
  type QueueBinding,
  type QueuedDeliveryRequest
} from './delivery-queue'
import type { AgentMessageOutcome } from './agent-message-decide'
import { DURABLE_STATE_MAX_BYTES, DurableFactFile } from '../durable-state'
import { restoreDeliveryQueue } from './agent-messaging'
import fs from 'node:fs'
import { testTmpDir } from '../test-tmp'

/**
 * A queued message across an app restart. Each test writes the queue through ONE instance, then
 * builds a NEW queue (a new process) and restores it — what a restart is to the queue. The rules
 * pinned: the TTL keeps running while the app is down (a lapsed message ends `expired` with the
 * sender told, never delivered late); a restored message goes only into the session it was queued
 * for; a board comment is never replayed into a pane — but a station notice IS, since T240 (its
 * expiry used to spawn a dead letter that was itself a notice: the restart chain).
 */

function instance(opts: {
  now: () => number
  binding: (id: string) => QueueBinding | undefined
  outcome?: AgentMessageOutcome
  trace?: DeliveryQueueDeps['trace']
  onDeliver?: (req: QueuedDeliveryRequest) => void
  liveness?: DeliveryQueueDeps['sessionLiveness']
}) {
  const delivered: QueuedDeliveryRequest[] = []
  const expired: {
    req: QueuedDeliveryRequest
    queuedForMs: number
    reason?: string
    bodyOmitted?: boolean
  }[] = []
  const flushed: { req: QueuedDeliveryRequest; outcome: AgentMessageOutcome }[] = []
  const queued: QueuedDeliveryRequest[] = []
  const traced: string[] = []
  const timers: { ms: number; fn: () => void; cancelled: boolean }[] = []
  let saved: PersistedQueueEntry[] = []
  const deps: DeliveryQueueDeps = {
    now: opts.now,
    deliver: async (req) => {
      opts.onDeliver?.(req)
      delivered.push(req)
      return opts.outcome ?? { kind: 'delivered', traceId: 'd', traced: 'memory', receipt: 'observed', signal: 'newTurn' }
    },
    trace:
      opts.trace ??
      (async (input) => {
        traced.push(input.outcome)
        return { traceId: `t${traced.length}`, traced: 'memory' }
      }),
    // T237: the host's answer. Deliberately UNWIRED by default — the same shape a shell with no
    // probe has, where `liveness()` is `unknown`, which must never be readable as a death.
    ...(opts.liveness ? { sessionLiveness: opts.liveness } : {}),
    onExpired: (req, info) =>
      expired.push({
        req,
        queuedForMs: info.queuedForMs,
        reason: info.reason,
        bodyOmitted: info.bodyOmitted
      }),
    onFlushed: (req, outcome) => flushed.push({ req, outcome }),
    onQueued: (req) => queued.push(req),
    schedule: (ms, fn): CancelTimer => {
      const t = { ms, fn, cancelled: false }
      timers.push(t)
      return () => (t.cancelled = true)
    },
    persist: (entries) => (saved = entries),
    bindingOf: opts.binding
  }
  return { queue: new DeliveryQueue(deps), delivered, expired, flushed, queued, traced, timers, saved: () => saved }
}

const req = (over: Partial<QueuedDeliveryRequest> = {}): QueuedDeliveryRequest => ({
  verb: 'send',
  sourceNodeId: 'orch',
  targetNodeId: 'st1',
  sourceTitle: 'orch',
  body: 'next task',
  ...over
})

/** Round-trip through JSON and the read-time sanitizer, like the file does. */
const onDisk = (entries: PersistedQueueEntry[]): PersistedQueueEntry[] =>
  entries.map((e) => sanitizePersistedQueueEntry(JSON.parse(JSON.stringify(e)))).filter((e): e is PersistedQueueEntry => !!e)

describe('delivery queue across a restart', () => {
  it('a queued message comes back and is delivered on the target\'s next done — same session', async () => {
    let now = 1000
    const a = instance({ now: () => now, binding: () => ({ sessionId: 's-A', agentId: 'claude' }) })
    await a.queue.enqueue(req())
    const disk = onDisk(a.saved())
    expect(disk).toHaveLength(1)
    expect(disk[0].binding).toEqual({ sessionId: 's-A', agentId: 'claude' })

    now = 1000 + 60_000 // one minute of downtime
    const b = instance({ now: () => now, binding: () => ({ sessionId: 's-A', agentId: 'claude' }) })
    await b.queue.restore(disk)
    expect(b.queued).toHaveLength(1) // replayed, so "work pending" is rebuilt
    expect(b.queue.depth('st1')).toBe(1)
    // The TTL is what is LEFT, not a fresh five minutes.
    expect(b.timers.filter((t) => !t.cancelled).map((t) => t.ms)).toEqual([DELIVERY_QUEUE_TTL_MS - 60_000])
    await b.queue.onTargetIdle('st1')
    expect(b.delivered.map((r) => r.body)).toEqual(['next task'])
    expect(b.saved()).toEqual([])
  })

  it('a message whose TTL lapsed while the app was down EXPIRES at restore, sender told, never delivered', async () => {
    let now = 1000
    const a = instance({ now: () => now, binding: () => ({ sessionId: 's-A' }) })
    await a.queue.enqueue(req())
    now = 1000 + DELIVERY_QUEUE_TTL_MS + 1
    const b = instance({ now: () => now, binding: () => ({ sessionId: 's-A' }) })
    await b.queue.restore(onDisk(a.saved()))
    expect(b.expired).toHaveLength(1)
    expect(b.expired[0].queuedForMs).toBe(DELIVERY_QUEUE_TTL_MS + 1)
    expect(b.traced).toEqual(['expired'])
    expect(b.queue.depth('st1')).toBe(0)
    await b.queue.onTargetIdle('st1')
    expect(b.delivered).toEqual([])
  })

  it('T237① — a DIFFERENT session in the pane is only a death once the HOST agrees it is gone', async () => {
    const a = instance({ now: () => 1000, binding: () => ({ sessionId: 's-A', agentId: 'claude' }) })
    await a.queue.enqueue(req())
    // The ledger says another conversation is in the pane, and the host says the session is GONE:
    // the one shape that licenses the terminal verdict, with the sender told through `onFlushed`.
    const gone = instance({
      now: () => 2000,
      binding: () => ({ sessionId: 's-B', agentId: 'claude' }),
      liveness: async () => 'gone'
    })
    await gone.queue.restore(onDisk(a.saved()))
    await gone.queue.onTargetIdle('st1')
    expect(gone.delivered).toEqual([])
    expect(gone.flushed.map((f) => f.outcome.kind)).toEqual(['targetGone'])
  })

  it('T237① NAIL — the same mismatch with the host saying LIVE is NOT a death: held, nothing sent, no notice', async () => {
    // The field shape (§六): the ledger's verdict was enough to drop a live station's mail at
    // 02:55:05, with the target's tmux session alive the whole time. The entry must SURVIVE, must
    // not be typed anywhere, and must NOT produce a sender-facing notice — nothing has been lost
    // and nothing has died.
    const a = instance({ now: () => 1000, binding: () => ({ sessionId: 's-A', agentId: 'claude' }) })
    await a.queue.enqueue(req())
    const live = instance({
      now: () => 2000,
      binding: () => ({ sessionId: 's-B', agentId: 'claude' }),
      liveness: async () => 'live'
    })
    await live.queue.restore(onDisk(a.saved()))
    await live.queue.onTargetIdle('st1')
    expect(live.delivered).toEqual([])
    expect(live.flushed).toEqual([])
    expect(live.expired).toEqual([])
    expect(live.queue.depth('st1')).toBe(1)
    // …and a probe that CANNOT answer is the same non-death (T237③ at the flush path).
    const unknown = instance({
      now: () => 2000,
      binding: () => ({ sessionId: 's-B', agentId: 'claude' }),
      liveness: async () => 'unknown'
    })
    await unknown.queue.restore(onDisk(a.saved()))
    await unknown.queue.onTargetIdle('st1')
    expect(unknown.flushed).toEqual([])
    expect(unknown.expired).toEqual([])
    expect(unknown.queue.depth('st1')).toBe(1)
  })

  it('T237② NAIL — an entry that recorded NO session is held, not called a death', async () => {
    // The arm that actually fired in the field. It used to return `gone` before any probe was
    // consulted; now it holds (never typed, never a death claim) and reaches its TTL ending.
    const a = instance({ now: () => 1000, binding: () => undefined })
    await a.queue.enqueue(req())
    expect(a.saved()[0]?.binding).toBeUndefined()
    let clock = 2000
    const live = instance({
      now: () => clock,
      binding: () => ({ sessionId: 's-B' }),
      liveness: async () => 'live'
    })
    await live.queue.restore(onDisk(a.saved()))
    await live.queue.onTargetIdle('st1')
    expect(live.delivered).toEqual([])
    expect(live.flushed).toEqual([])
    expect(live.expired).toEqual([])
    expect(live.queue.depth('st1')).toBe(1)
    // TTL: the re-arm's premise is REACHABILITY, and this entry is not reachable — so the live
    // session does NOT hold it forever. When its deadline arrives it ends with the honest reason,
    // which claims no death and says nothing was typed.
    clock = 1000 + DELIVERY_QUEUE_TTL_MS
    live.timers.filter((t) => !t.cancelled).at(-1)!.fn()
    await vi.waitFor(() => expect(live.expired).toHaveLength(1))
    expect(live.expired[0].reason).toBe('binding-unproven')
    expect(live.delivered).toEqual([])
    expect(live.flushed).toEqual([])
  })

  it('T237 — an unprovable restored entry reaches its ending even if the target NEVER goes idle', async () => {
    // The TTL path consults the ledger too, so the honest ending does not depend on the target
    // emitting another idle event. Without this the entry would be re-armed forever by the live
    // probe (T205's rule), which is a promise to a sender that never resolves.
    const a = instance({ now: () => 1000, binding: () => undefined })
    await a.queue.enqueue(req())
    let clock = 2000
    const live = instance({
      now: () => clock,
      binding: () => ({ sessionId: 's-B' }),
      liveness: async () => 'live'
    })
    await live.queue.restore(onDisk(a.saved()))
    expect(live.queue.depth('st1')).toBe(1)
    clock = 1000 + DELIVERY_QUEUE_TTL_MS
    live.timers.filter((t) => !t.cancelled).at(-1)!.fn()
    await vi.waitFor(() => expect(live.expired).toHaveLength(1))
    expect(live.expired[0].reason).toBe('binding-unproven')
    expect(live.queue.depth('st1')).toBe(0)
  })

  it('T237 — a binding that AGREES again clears the hold: the entry becomes deliverable', async () => {
    // A pane legitimately comes back under the same session id (a cold restore resumes it), and a
    // hold whose reason is gone must not outlive it.
    const a = instance({ now: () => 1000, binding: () => ({ sessionId: 's-A' }) })
    await a.queue.enqueue(req())
    let clock = 2000
    let cur: QueueBinding = { sessionId: 's-B' }
    const b = instance({
      now: () => clock,
      binding: () => cur,
      liveness: async () => 'live'
    })
    await b.queue.restore(onDisk(a.saved()))
    await b.queue.onTargetIdle('st1') // mismatch + live probe ⇒ held, nothing typed
    expect(b.delivered).toEqual([])
    expect(b.queue.depth('st1')).toBe(1)
    cur = { sessionId: 's-A' } // the same conversation is provable again
    clock += 1000
    await b.queue.onTargetIdle('st1')
    expect(b.delivered).toHaveLength(1)
    expect(b.queue.depth('st1')).toBe(0)
  })

  it('T237 — a held entry is not expired early: it is its own TTL that ends it', async () => {
    const a = instance({ now: () => 1000, binding: () => undefined })
    await a.queue.enqueue(req())
    const b = instance({
      now: () => 1000 + 60_000, // one minute in, four minutes of TTL left
      binding: () => ({ sessionId: 's-B' }),
      liveness: async () => 'live'
    })
    await b.queue.restore(onDisk(a.saved()))
    await b.queue.onTargetIdle('st1')
    expect(b.delivered).toEqual([])
    expect(b.queue.depth('st1')).toBe(1)
    // Its TTL timer is still the REMAINING four minutes, not a fresh five — and it was not fired.
    expect(b.timers.filter((t) => !t.cancelled).map((t) => t.ms)).toEqual([DELIVERY_QUEUE_TTL_MS - 60_000])
  })

  it('restoredBindingVerdict: four dispositions, and the two that change an ENTRY rather than answer', () => {
    expect(restoredBindingVerdict({ sessionId: 's', agentId: 'claude' }, { sessionId: 's', agentId: 'codex' })).toBe('gone')
    expect(restoredBindingVerdict({ sessionId: 's' }, undefined)).toBe('wait')
    expect(restoredBindingVerdict({ sessionId: 's' }, { agentId: 'claude' })).toBe('wait')
    // T237②: nothing was recorded, so nothing can ever PROVE the conversation — held, never a death.
    expect(restoredBindingVerdict(undefined, { sessionId: 's' })).toBe('unprovable')
    expect(restoredBindingVerdict({ agentId: 'claude' }, { sessionId: 's' })).toBe('unprovable')
    expect(restoredBindingVerdict({ sessionId: 's' }, { sessionId: 's' })).toBe('deliver')
  })

  it('a restored message waits (TTL still running) while the target has not named a session yet', async () => {
    const a = instance({ now: () => 1000, binding: () => ({ sessionId: 's-A' }) })
    await a.queue.enqueue(req())
    let cur: QueueBinding | undefined
    const b = instance({ now: () => 2000, binding: () => cur })
    await b.queue.restore(onDisk(a.saved()))
    await b.queue.onTargetIdle('st1')
    expect(b.delivered).toEqual([])
    expect(b.queue.depth('st1')).toBe(1)
    cur = { sessionId: 's-A' }
    await b.queue.onTargetIdle('st1')
    expect(b.delivered).toHaveLength(1)
  })

  it('in-run entries are unchanged: a live entry is delivered whatever the binding says now', async () => {
    let cur: QueueBinding = { sessionId: 's-A' }
    const a = instance({ now: () => 1000, binding: () => cur })
    await a.queue.enqueue(req())
    cur = { sessionId: 's-B' }
    await a.queue.onTargetIdle('st1')
    expect(a.delivered).toHaveLength(1)
  })

  it('a board comment is expired at restore, never replayed into a pane', async () => {
    // Only the local user, typing in THIS app, may trigger a board comment — a message read back
    // off disk must not be able to speak as a person. (A station notice left this test in T240:
    // it now replays like a send — see the restored-notice pins below.)
    const a = instance({ now: () => 1000, binding: () => ({ sessionId: 's-A' }) })
    await a.queue.enqueue(
      req({ verb: 'board-comment', sourceNodeId: 'board-comment:c1', projectId: 'p1', commentId: 'c1', author: 'me', text: '@x hi' })
    )
    const disk = onDisk(a.saved())
    expect(disk).toHaveLength(1)
    expect(disk[0].req.projectId).toBe('p1') // its trace still finds its board
    const b = instance({ now: () => 2000, binding: () => ({ sessionId: 's-A' }) })
    await b.queue.restore(disk)
    expect(b.expired.map((e) => e.req.verb)).toEqual(['board-comment'])
    await b.queue.onTargetIdle('st1')
    expect(b.delivered).toEqual([])
  })

  it('T240 — a station notice survives the restart: still queued, delivered ONCE on the next idle', async () => {
    // The chain, for the record: a queued notice hit a restart, was judged not-restorable, and its
    // dead letter was ITSELF a notice — three field loops on 2026-10-09, one entry expiring twice
    // after 17306s of waiting. Now it rides the same rules as a send: source is a node id, the
    // binding gates the flush, one delivery, one delivered end.
    const a = instance({ now: () => 1000, binding: () => ({ sessionId: 's-A', agentId: 'claude' }) })
    await a.queue.enqueue(req({ verb: 'station-notice', sourceNodeId: 'st1', targetNodeId: 'orch1', sourceTitle: 'Station' }))
    const disk = onDisk(a.saved())
    expect(disk).toHaveLength(1)
    expect(disk[0].req.sourceNodeId).toBe('st1')

    let now = 1000 + 60_000
    const b = instance({
      now: () => now,
      binding: () => ({ sessionId: 's-A', agentId: 'claude' })
    })
    await b.queue.restore(disk)
    expect(b.queued).toHaveLength(1) // replayed like any entry
    expect(b.expired).toEqual([]) // NOT judged not-restorable any more
    expect(b.queue.depth('orch1')).toBe(1)
    await b.queue.onTargetIdle('orch1')
    expect(b.delivered.map((r) => r.verb)).toEqual(['station-notice'])
    // Exactly one delivered end: the entry is gone from the queue, so a second idle flush (or a
    // replayed onQueued) cannot put a second copy of the notice into the pane.
    await b.queue.onTargetIdle('orch1')
    expect(b.delivered).toHaveLength(1)
    expect(b.flushed.map((f) => f.outcome.kind)).toEqual(['delivered'])
    expect(b.saved()).toEqual([])
    // The end is a delivery, never an expiry: no dead letter leg runs for it at all.
    expect(b.expired).toEqual([])
  })

  it('T240 — a restored notice binds like a send: another session in the pane is T237, not a drop', async () => {
    const a = instance({ now: () => 1000, binding: () => ({ sessionId: 's-A' }) })
    await a.queue.enqueue(req({ verb: 'station-notice', sourceNodeId: 'st1', targetNodeId: 'orch1' }))
    // The host says the session is LIVE while the ledger disagrees: held, never typed, never a
    // death — the notice must not sneak past the binding just because "it is only a notification".
    const live = instance({
      now: () => 2000,
      binding: () => ({ sessionId: 's-B' }),
      liveness: async () => 'live'
    })
    await live.queue.restore(onDisk(a.saved()))
    await live.queue.onTargetIdle('orch1')
    expect(live.delivered).toEqual([])
    expect(live.flushed).toEqual([])
    expect(live.expired).toEqual([])
    expect(live.queue.depth('orch1')).toBe(1)
  })

  it('T240④ — a body-omitted notice still ends at restore, and says so on the expiry', async () => {
    const a = instance({ now: () => 1000, binding: () => ({ sessionId: 's-A' }) })
    await a.queue.enqueue(req({ verb: 'station-notice', sourceNodeId: 'st1', targetNodeId: 'orch1', body: 'x'.repeat(QUEUE_PERSIST_BODY_MAX + 1) }))
    const disk = onDisk(a.saved())
    expect(disk[0]).toMatchObject({ bodyOmitted: true, req: { body: '' } })
    const b = instance({ now: () => 2000, binding: () => ({ sessionId: 's-A' }) })
    await b.queue.restore(disk)
    // Nothing on disk to deliver: the not-restorable end stands — but the expiry now CARRIES the
    // fact, so main's in-band leg can spare the dead letter that used to feed the chain.
    expect(b.expired).toHaveLength(1)
    expect(b.expired[0].reason).toBe('not-restorable')
    expect(b.expired[0].bodyOmitted).toBe(true)
    expect(b.queue.depth('orch1')).toBe(0)
  })

  it('T240 — the sanitize guard stays whole for the new verb', () => {
    // A station notice's source is a node id at every production site; the restore guard keys on
    // RESTORABLE_VERBS, so admitting the verb must NOT admit a foreign source shape with it.
    const req = { targetNodeId: 'orch1', verb: 'station-notice', sourceTitle: 'Station', body: 'n', sourceNodeId: 'st1' }
    const meta = { enqueuedAt: 1, ttlMs: 1000, queuedTraceId: 'q' }
    expect(sanitizePersistedQueueEntry({ req: { ...req, sourceNodeId: 'board-comment:c1' }, ...meta })).toBeNull()
    expect(sanitizePersistedQueueEntry({ req: { ...req, sourceNodeId: '' }, ...meta })).toBeNull()
    expect(sanitizePersistedQueueEntry({ req: { ...req, sourceNodeId: '..' }, ...meta })).toBeNull()
    const ok = sanitizePersistedQueueEntry({ req, ...meta })
    expect(ok?.req.sourceNodeId).toBe('st1')
  })

  it('a body too large to store is written without it and expired at restore', async () => {
    const a = instance({ now: () => 1000, binding: () => ({ sessionId: 's-A' }) })
    await a.queue.enqueue(req({ body: 'x'.repeat(QUEUE_PERSIST_BODY_MAX + 1) }))
    const disk = onDisk(a.saved())
    expect(disk[0]).toMatchObject({ bodyOmitted: true, req: { body: '' } })
    const b = instance({ now: () => 2000, binding: () => ({ sessionId: 's-A' }) })
    await b.queue.restore(disk)
    expect(b.expired).toHaveLength(1)
    expect(b.delivered).toEqual([])
  })

  it('sanitizes hand-edited entries', () => {
    const good = { req: req(), enqueuedAt: 1, ttlMs: 1000, queuedTraceId: 't' }
    expect(sanitizePersistedQueueEntry(good)).toBeTruthy()
    expect(sanitizePersistedQueueEntry({ ...good, req: req({ targetNodeId: '../x' }) })).toBeNull()
    expect(sanitizePersistedQueueEntry({ ...good, req: req({ sourceNodeId: 'not a node' }) })).toBeNull()
    expect(sanitizePersistedQueueEntry({ ...good, ttlMs: 1e12 })).toBeNull()
    expect(sanitizePersistedQueueEntry({ ...good, ttlMs: -1 })).toBeNull()
    expect(sanitizePersistedQueueEntry({ ...good, req: { ...req(), extra: { nested: 1 } } })).toBeNull()
    expect(sanitizePersistedQueueEntry({ ...good, binding: { sessionId: 5 } })).toBeNull()
    expect(sanitizePersistedQueueEntry('x')).toBeNull()
  })

  it('end to end through the file: write → new instance → restore → deliver', async () => {
    const dir = testTmpDir('nt-queue-')
    const fileA = new DurableFactFile(QUEUE_FACT, { userDataDir: dir, debounceMs: 1 })
    const a = instance({ now: () => 1000, binding: () => ({ sessionId: 's-A' }) })
    await a.queue.enqueue(req())
    fileA.save(a.saved())
    await fileA.flush()
    const b = instance({ now: () => 2000, binding: () => ({ sessionId: 's-A' }) })
    await b.queue.restore(new DurableFactFile(QUEUE_FACT, { userDataDir: dir }).load())
    await b.queue.onTargetIdle('st1')
    expect(b.delivered.map((r) => r.body)).toEqual(['next task'])
  })

  it('the written file stays under the load limit however much is queued; nothing is silently dropped (review repro)', async () => {
    const dir = testTmpDir('nt-queue-budget-')
    const file = new DurableFactFile(QUEUE_FACT, { userDataDir: dir, debounceMs: 1 })
    const a = instance({ now: () => 1000, binding: () => ({ sessionId: 's' }) })
    for (let t = 0; t < 5; t++)
      for (let i = 0; i < 16; i++)
        await a.queue.enqueue(req({ targetNodeId: `st${t}`, body: `${t}-${i}-` + 'x'.repeat(250_000) }))
    file.save(a.saved())
    await file.flush()
    expect(fs.statSync(file.path).size).toBeLessThan(DURABLE_STATE_MAX_BYTES)
    const loaded = new DurableFactFile(QUEUE_FACT, { userDataDir: dir }).load()
    expect(loaded).toHaveLength(80)
    const full = loaded.filter((e) => !e.bodyOmitted)
    expect(full.length).toBeGreaterThan(0)
    expect(full.reduce((n, e) => n + JSON.stringify(e).length, 0)).toBeLessThanOrEqual(QUEUE_PERSIST_BYTES_BUDGET)
    // Every reduced entry is ENDED loudly at restore, the full ones wait for their target.
    const b = instance({ now: () => 2000, binding: () => ({ sessionId: 's' }) })
    await b.queue.restore(loaded)
    expect(b.expired).toHaveLength(80 - full.length)
    expect(b.expired.length + [0, 1, 2, 3, 4].reduce((n, t) => n + b.queue.depth(`st${t}`), 0)).toBe(80)
  })

  it('lapsed entries never enter the live lists: a flush during an expiry\'s await delivers nothing of them', async () => {
    const a = instance({ now: () => 1000, binding: () => ({ sessionId: 's' }) })
    await a.queue.enqueue(req({ verb: 'board-comment', sourceNodeId: 'board-comment:c1', projectId: 'p1' }))
    await a.queue.enqueue(req({ body: 'x'.repeat(QUEUE_PERSIST_BODY_MAX + 1) }))
    let release = (): void => {}
    let b!: ReturnType<typeof instance>
    const stalled = new Promise<void>((r) => (release = r))
    b = instance({
      now: () => 2000,
      binding: () => ({ sessionId: 's' }),
      trace: async () => {
        await b.queue.onTargetIdle('st1') // a `done` arriving while the expiry is being reported
        await stalled
        return { traceId: 't', traced: 'memory' }
      }
    })
    const restoring = b.queue.restore(onDisk(a.saved()))
    await new Promise((r) => setTimeout(r, 0))
    release()
    await restoring
    expect(b.delivered).toEqual([])
    expect(b.expired).toHaveLength(2)
  })

  it('lapsed entries take no capacity: 16 deliverable ones all come back beside an expired one', async () => {
    const entries: PersistedQueueEntry[] = [
      { req: req({ verb: 'board-comment', sourceNodeId: 'board-comment:c1' }), enqueuedAt: 1000, ttlMs: DELIVERY_QUEUE_TTL_MS, queuedTraceId: 't' },
      ...Array.from({ length: 16 }, (_, i) => ({
        req: req({ body: `m${i}` }),
        enqueuedAt: 1000,
        ttlMs: DELIVERY_QUEUE_TTL_MS,
        queuedTraceId: `t${i}`,
        binding: { sessionId: 's' }
      }))
    ]
    const b = instance({ now: () => 2000, binding: () => ({ sessionId: 's' }) })
    await b.queue.restore(onDisk(entries))
    expect(b.queue.depth('st1')).toBe(16)
    expect(b.expired.map((e) => e.req.verb)).toEqual(['board-comment'])
  })

  it('an entry is written off disk BEFORE its delivery attempt (at most once across a crash)', async () => {
    let onDiskDuringDelivery: PersistedQueueEntry[] | null = null
    let a!: ReturnType<typeof instance>
    a = instance({ now: () => 1000, binding: () => ({ sessionId: 's' }), onDeliver: () => (onDiskDuringDelivery = a.saved()) })
    await a.queue.enqueue(req())
    expect(a.saved()).toHaveLength(1)
    await a.queue.onTargetIdle('st1')
    expect(onDiskDuringDelivery).toEqual([])
  })

  it('restoreDeliveryQueue reports no expiry until `ready` (the desktop workspace index) has resolved', async () => {
    const a = instance({ now: () => 1000, binding: () => ({ sessionId: 's' }) })
    await a.queue.enqueue(req())
    const b = instance({ now: () => 1000 + DELIVERY_QUEUE_TTL_MS + 1, binding: () => ({ sessionId: 's' }) })
    let loaded = (): void => {}
    const ready = new Promise<void>((r) => (loaded = r))
    const disk = onDisk(a.saved())
    const done = restoreDeliveryQueue(b.queue, { load: () => disk }, { ready })
    await new Promise((r) => setTimeout(r, 5))
    expect(b.expired).toEqual([])
    loaded()
    await done
    expect(b.expired).toHaveLength(1)
  })
})
