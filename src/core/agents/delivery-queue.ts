import type { AgentMessageOutcome } from './agent-message-decide'
import { RETRYABLE } from './agent-message-decide'
import type { DeliveryTraceInput } from './agent-message-trace'
import type { DurableFactSpec } from '../durable-state'
import { isSafeNodeId } from '../../shared/safe-id'
import type { SessionLiveness } from '../../shared/agents/agent-messaging'

/**
 * DELIVER-ON-IDLE — a bounded, per-target queue with a TTL, and never a silent drop.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 *
 * Gate 2 refuses a BUSY target (`targetBusy`) and a target between sessions
 * (`targetNotIdleUnknown`), and Eco hibernation leaves an idle node's pane on a SHELL — so
 * `targetNotAgentPane` refuses it *forever* on exactly the nodes an orchestration is most likely to
 * message (the ones sitting idle). "Retry in a moment" pushes that onto a language model with a rate
 * limiter in front of it: a busy-loop that burns tokens. Wake-then-deliver is therefore not a
 * nicety — it is what makes messaging usable across a long-running canvas.
 *
 * So a `targetBusy` / hibernated target with queueing on is ENQUEUED, and delivered when the target
 * next goes idle. `queued` is NOT `delivered`: the bytes have not reached the pane, and the receipt
 * (Task 3.4) is what will close the loop once they do. A queue full stops the sender loudly
 * (`queueFull`), and a message that waits out its TTL EXPIRES loudly — to the trace and to the
 * sender — because a silent drop is the one outcome a security core may never have.
 *
 * ── THE DECSET-2004 MEASUREMENT MADE THIS SAFE (2026-08-15, this host) ───────────────────────────
 *
 * Deliver-on-idle only works if a queued message can be framed into the target's pane WITHOUT a
 * per-delivery bracketed-paste probe. Measured: all four agent CLIs (claude, codex, gemini,
 * opencode) keep DECSET 2004 ON at idle AND during startup, twice each, no flapping — so
 * `paste-buffer -p` frames every flush, including one into a still-starting agent after a wake. The
 * ONE unsafe surface is a NON-agent pane (a plain REPL/terminal): 2004 OFF ⇒ the payload lands as
 * raw keystrokes, one submit per newline. This queue therefore gates on NODE TYPE, not on a runtime
 * probe: it only ever enqueues for a target whose delivery attempt refused as `targetBusy` /
 * `hibernated` — i.e. a pane gate 1 already judged an AGENT pane — and the flush re-runs the whole
 * delivery (gate 1 included), so a pane that became a terminal while queued is refused, never
 * sprayed with unframed lines.
 *
 * ── FLUSH-TIME RE-VALIDATION IS THE LOAD-BEARING PROPERTY ───────────────────────────────────────
 *
 * A message queued for a busy agent must NOT trust the decision that queued it. Ownership can change
 * (the pane is respawned by another project), the grant can be revoked (the switch turned off, the
 * clone notice declined), the flow budget can move — all while the message waits. So the flush does
 * not cache anything: it calls `deps.deliver(req)` again, which is the SAME end-to-end path the verb
 * took (scope → ownership → grant → flow → `deliverAgentMessage`). A grant revoked while queued
 * therefore comes back `notPermitted` at flush and the message is DROPPED, never delivered — pinned
 * by `delivery-queue.test.ts`, which flips the injected `deliver` from `targetBusy` to
 * `notPermitted` between enqueue and flush and asserts nothing reached the pane.
 *
 * ── DURABLE ACROSS A RESTART (`snapshot` / `restore`, `QUEUE_FACT`) ─────────────────────────────
 *
 * The queue used to be process memory, so a `send` answered `queued` vanished on an app restart
 * while its sender believed it would be delivered. Every change is now mirrored (the `persist` dep)
 * to `<userData>/orchestration-state/delivery-queue.json`, and a shell restores it at boot, AFTER
 * wiring every listener (`onQueued` is replayed for each restored entry, so the station-outcome
 * store's "work pending" count is rebuilt from the queue rather than persisted twice). What a
 * restart means for an entry, decided here:
 *
 *  - **Its TTL keeps running while the app is down.** The deadline is wall-clock (`enqueuedAt` +
 *    `ttlMs`), not "5 minutes of uptime". An entry whose deadline passed while the app was down is
 *    EXPIRED at restore — traced `expired` and the sender told through `onExpired`, exactly like an
 *    expiry in-run — never delivered late and never dropped in silence.
 *  - **It is typed only into the SAME session it was queued for.** At enqueue the target's agent
 *    and session id are recorded (`bindingOf`, the status mirror). A RESTORED entry flushes only if
 *    the target's current session and agent are the recorded ones; a different session (the pane
 *    was respawned, `/clear`, another agent now runs there) is held pending the host's own answer —
 *    only a probe that also says `gone` ends it as `targetGone`, and the sender is told (T237①). An
 *    entry with no recorded session is not delivered either, and is NOT called a death: it is held
 *    (T237②) and ends at its TTL with a notice saying the binding could not be proven. A target
 *    whose session is not known YET waits (the flush trigger is a hook event, which names it).
 *    In-run entries are unchanged.
 *  - **The whole gate chain still runs at flush**, as it always did (scope, pane ownership, grant,
 *    flow). Note what that means after a restart where tmux survived: pane ownership is recorded
 *    only on a fresh spawn (pane-ownership.ts), so the surviving pane is UNPROVEN and the flush is
 *    refused `notPermitted` — the sender is told, which is still strictly better than the silent
 *    loss it replaces. After a machine reboot the cold-restored pane IS a fresh spawn, so a message
 *    for a session that resumed under its old id is delivered.
 *  - **A board comment never flushes after a restart**: only the local user, typing in THIS app,
 *    may trigger one — a message read back off disk must not be able to speak as a person. An
 *    entry whose body was too large to store (`QUEUE_PERSIST_BODY_MAX`) ends at restore too: there
 *    is nothing on disk to deliver. Both ends are TOLD (row / sender), never silent.
 *  - **A station notice DOES survive a restart now (T240).** It used to be expired at restore on
 *    the theory that its monitor's state did not survive — but its body is self-contained (core
 *    composed it from a closed table, so nothing needs re-deriving), every delivery gate re-runs
 *    at flush, and expiring it produced a dead letter that is ITSELF a station notice: a restart
 *    ate a notice, the dead letter queued, the next restart ate it too — three field loops on
 *    2026-10-09, one entry waiting 17306s before expiring twice. Restored notices now ride the
 *    same rules as a `send`: one delivery attempt per idle flush, T237's binding verdicts when the
 *    conversation cannot be proven, the sender told at the end. Only a body-omitted notice still
 *    ends at restore (nothing to deliver), and its end no longer spawns a dead letter — main skips
 *    the in-band leg for it, which is the last link of that chain.
 *  - Not flushed at boot: the first flush waits for the target's next `done`, like any entry. A
 *    target that stays idle through the rest of the TTL expires it (sender told).
 *  - A crash inside the save window loses that window; a clean quit flushes synchronously. The file
 *    is hand-editable, so every entry is re-checked on read (`sanitizePersistedQueueEntry`). It holds
 *    message bodies, so it is written 0600 under userData and never leaves the machine.
 *
 * ── SHIPS ON BOTH SHELLS, USED ON ONE ──────────────────────────────────────────────────────────
 *
 * Pure `src/core`: no electron, no main import (`no-electron.test.ts`). Every side effect — the
 * clock, the delivery, the wake, the trace, the sender-notify, the timer — is injected, so the whole
 * lifecycle is driven without a pty or a window. The desktop is the only shell that wires a consumer
 * (messaging does not exist on the Server Edition, Task 5.3); the module still compiles and ships
 * there, like everything else in this directory.
 */

/** How long a message waits queued before it expires. Long enough for an orchestration turn (which
 *  can run minutes), bounded so a target that never goes idle cannot pin a message forever. */
export const DELIVERY_QUEUE_TTL_MS = 5 * 60_000

/** How many messages one target may have queued at once. Small and per-target: an unbounded queue
 *  is a memory-DoS surface, and refusing at the bound (rather than dropping the oldest) keeps FIFO
 *  fairness and tells the sender loudly instead of silently discarding a message already accepted. */
export const DELIVERY_QUEUE_CAPACITY = 16

/**
 * T228③ — the bounds on re-offering an entry that met the TARGET's provider cooldown.
 *
 * The ticket's rule, as constants: never a silent drop and never a dead letter for a limit that is
 * the provider's own advice, but also never an unbounded wait. `RATE_LIMIT_MAX_ATTEMPTS` is how many
 * times the cooldown is allowed to REFUSE the entry before it becomes a dead letter — each refusal
 * doubles the previous delay (the provider's own `retryAfter` is the first rung), capped at ten
 * minutes. `RATE_LIMIT_MAX_WAIT_MS` bounds the total wait independently, since a short reading can
 * ladder many rungs inside a long wait — whichever runs out first is the end, and a station whose
 * provider keeps re-limiting it is a fact its sender needs rather than a message to hold forever.
 */
export const RATE_LIMIT_MAX_ATTEMPTS = 5
export const RATE_LIMIT_MAX_BACKOFF_MS = 10 * 60_000
export const RATE_LIMIT_MAX_WAIT_MS = 10 * 60_000

/** The request the queue carries — opaque to the queue, handed straight back to `deps.deliver`. The
 *  queue keys everything on `targetNodeId` (the flush trigger and the per-target bound) and
 *  `sourceNodeId` (so an expiry can name who to tell); the rest travels untouched. */
export interface QueuedDeliveryRequest {
  sourceNodeId: string
  targetNodeId: string
  sourceTitle: string
  /** For the expiry trace's `bodyChars` — the body itself is never traced (see agent-message-trace). */
  body: string
  [k: string]: unknown
}

/** Cancels a scheduled timer. Returned by `schedule`. */
export type CancelTimer = () => void

export interface DeliveryQueueDeps {
  now(): number
  /**
   * The FULL, re-validated delivery — in production `deliverFromControl`. Called on every flush, so
   * the whole gate chain (scope, ownership, grant, flow, `deliverAgentMessage`) runs again against
   * live state. This is what makes the queue safe: it caches no authorization decision.
   */
  deliver(req: QueuedDeliveryRequest): Promise<AgentMessageOutcome>
  /** Record an outcome (`recordDelivery`). The queue traces `queued` on enqueue and `expired` on a
   *  TTL lapse; the flush's own outcomes are traced inside `deliver`. `req` is the queued request
   *  itself, so a shell can route the line by what the request carries (a board comment's board). */
  trace(input: DeliveryTraceInput, req?: QueuedDeliveryRequest): Promise<{ traceId: string; traced: string }>
  /**
   * Wake a hibernated target through the existing registry (`agent-restart.ts` hibernate/wake
   * pair). Optional: a target that is merely busy (not hibernated) needs no wake, and a shell with
   * no registry (the Server Edition) wires nothing. A wake is fire-and-forget here — the target's
   * eventual idle event is what triggers the flush, not this call's resolution.
   */
  wake?(nodeId: string): void
  /**
   * Tell the SENDER a queued message expired, and WHY. The trace is the durable leg (always
   * written); this is the live leg — the shell surfaces it (a board-log line for the sender, a
   * push). Optional so the core can be tested without a notify channel, but a production wiring
   * that omits it turns the "never a silent drop" guarantee into "durable-only", so the desktop
   * always supplies it. `reason` is required: every sender-facing sentence is built from it.
   */
  onExpired?(
    req: QueuedDeliveryRequest,
    info: {
      traceId: string
      queuedForMs: number
      reason: QueueExpiryReason
      /** T240④ — the entry's body was never on disk (snapshot reduction), so an in-band dead
       *  letter has nothing to quote and, for a notice, must not spawn another one. Absent on
       *  every entry that lived its whole life in memory. */
      bodyOmitted?: boolean
    }
  ): void
  /**
   * T205/T207b: what the host can say about the target's session right now. Drives the expiry rule
   * — a LIVE target never lets its queued entries expire (its busy turn merely outlived the TTL;
   * the next idle flush delivers), while a session that is not there expires them with the sender
   * told. THREE states, not a boolean: the boolean version folded "the probe could not answer"
   * into "the session is gone", and a dead letter built on that fold told a sender its mail died
   * with a session that was in fact alive. Optional so the core is testable without a pty probe;
   * unwired ⇒ 'unknown', which reports uncertainty instead of a death.
   */
  sessionLiveness?(nodeId: string): Promise<SessionLiveness>
  /** Tell the sender how a flush ended (delivered, or refused because the world changed under it).
   *  Same optionality reasoning as `onExpired`. */
  onFlushed?(req: QueuedDeliveryRequest, outcome: AgentMessageOutcome): void
  /** An entry was accepted into a target's queue — called synchronously, right as it is added, so a
   *  listener learns of it before any flush or expiry of that entry can run. Every entry that fires
   *  this later ends in exactly one `onFlushed` or `onExpired`. */
  onQueued?(req: QueuedDeliveryRequest): void
  /** Arm a one-shot timer, returning its cancel. Injected so tests drive TTL expiry deterministically
   *  instead of waiting real milliseconds; defaults to `setTimeout`/`clearTimeout`. */
  schedule?(ms: number, fn: () => void): CancelTimer
  /** The whole queue changed: mirror `snapshot()` to disk. Absent ⇒ process memory only. */
  persist?(entries: PersistedQueueEntry[]): void
  /** The target's current agent and session (the status mirror), recorded at enqueue and compared
   *  when a RESTORED entry flushes. Absent ⇒ nothing is recorded, and a restored entry is refused. */
  bindingOf?(nodeId: string): QueueBinding | undefined
}

/** Which conversation a queued message was addressed to. */
export interface QueueBinding {
  sessionId?: string
  agentId?: string
}

/**
 * What the host can say about a target's session right now (T205/T207b) — `live`, `gone`, or
 * `unknown` when it could not be asked. DECLARED in the shared messaging vocabulary, because
 * `TrustRow` is an IPC shape that names it as well; the QUEUE's rules for reading it live here.
 *
 * The distinction is the whole point: `unknown` is NOT `gone`, and reporting it as one is how a
 * dead letter told a sender its message died with a session that was alive at the time.
 */
export type { SessionLiveness } from '../../shared/agents/agent-messaging'

/** Why a queued entry ended without reaching its pane (T207b). */
export type QueueExpiryReason =
  /** The host asked and found no session. */
  | 'session-gone'
  /** The host could not say whether the session is still there. NOT a death. */
  | 'session-unknown'
  /**
   * T228③ — the TARGET's provider kept rate limiting it through every bounded retry. NOT a death
   * either, and not the sender's fault: the entry waited out its own backoff ladder and the limit
   * outlasted it.
   */
  | 'rate-limit-exhausted'
  /**
   * T237 — the entry came back from a restart unable to prove the target still runs the
   * conversation it was addressed to, and the host did not say the session is gone either. NOT a
   * death, and not a delivery: the message is held and then told to end, rather than typed into a
   * session nobody could prove was the same one.
   */
  | 'binding-unproven'
  /** The entry came back from a restart without enough to deliver it (its body was not stored, its
   *  verb does not survive a restart, or the target's queue was full). */
  | 'not-restorable'

/**
 * The sender-facing words for each reason, as ONE table: the durable trace line, the in-band dead
 * letter and the receipt all read it, so three surfaces cannot drift into three different claims
 * about the same expiry.
 */
export const EXPIRY_REASON_TEXT: Record<QueueExpiryReason, string> = {
  'session-gone': 'the target’s session is gone (the host asked, and nothing is there)',
  'session-unknown': 'nodeterm could not confirm whether the target’s session is still there',
  'rate-limit-exhausted':
    `the target’s provider kept rate limiting it through ${RATE_LIMIT_MAX_ATTEMPTS} attempts ` +
    `(waited out its own backoff ladder; this is the provider’s limit, not your order)`,
  'binding-unproven':
    'the message was addressed to a conversation the target is no longer provably running, and the ' +
    'target’s session was not confirmed gone either — nodeterm did not type it anywhere',
  'not-restorable': 'the entry did not survive the restart with enough to deliver it'
}

interface QueueEntry {
  req: QueuedDeliveryRequest
  enqueuedAt: number
  ttlMs: number
  cancelTimer: CancelTimer
  /** The traceId minted when this was queued, reused on its expiry so the two entries correlate. */
  queuedTraceId: string
  binding?: QueueBinding
  /** Came back from disk after a restart: flushes only into the session it was queued for. */
  restored?: true
  /** T240④ — the body was too large to store, so this restored entry has nothing to deliver and
   *  ends at restore; its expiry must not spawn an in-band dead letter for a notice (main reads
   *  the flag). An entry that lived its whole life in memory never carries it. */
  bodyOmitted?: true
  /**
   * T228③ — how many flushes of THIS entry met the target's provider cooldown, and the epoch the
   * next one is allowed (the backoff ladder's own deadline). Both are process-lifetime on purpose:
   * the cooldown reading that drives them is in-memory mirror state too, so a restart starts the
   * count over rather than resuming a ladder against a clock nobody remembers.
   */
  rateLimitAttempts?: number
  holdUntil?: number
  /**
   * T237 — this restored entry may NOT be delivered (its binding to a conversation is unproven) AND
   * the host did not confirm the target's session is gone. It is held, never typed, and never
   * called a death — and because it is also NOT reachable, the TTL's live-session re-arm (T205's
   * rule, which exists so that a message to a REACHABLE target is not expired under it) does not
   * apply: the entry is allowed to reach its honest, notified ending.
   */
  bindingUnproven?: true
}

/** One queued message as written to disk. */
export interface PersistedQueueEntry {
  req: QueuedDeliveryRequest
  enqueuedAt: number
  ttlMs: number
  queuedTraceId: string
  binding?: QueueBinding
  /** The body was too large to store; the entry is written only so its end can be told. */
  bodyOmitted?: true
}

/** A body larger than this is not written; its entry is expired at restore (sender told). */
export const QUEUE_PERSIST_BODY_MAX = 256 * 1024
/** JSON bytes of FULL entries a snapshot writes before the rest go out reduced (`snapshot`). Half
 *  the file limit: a reduced entry is a few hundred bytes, so 1024 of them fit in the other half. */
export const QUEUE_PERSIST_BYTES_BUDGET = 8 * 1024 * 1024

/** A reduced entry keeps only what its expiry needs to be routed and traced. */
const REDUCED_STRING_MAX = 200
const REDUCED_EXTRAS_MAX = 4

function clip(v: string): string {
  return v.length > REDUCED_STRING_MAX ? v.slice(0, REDUCED_STRING_MAX) : v
}

/** The request of an entry written without its body: short fields only, never a message text. */
function reducedRequest(req: QueuedDeliveryRequest): QueuedDeliveryRequest {
  const out: QueuedDeliveryRequest = {
    verb: typeof req.verb === 'string' ? clip(req.verb) : req.verb,
    sourceNodeId: clip(req.sourceNodeId),
    targetNodeId: req.targetNodeId,
    sourceTitle: clip(req.sourceTitle),
    body: ''
  }
  let extras = 0
  for (const [k, v] of Object.entries(req)) {
    if (k in out || extras >= REDUCED_EXTRAS_MAX) continue
    if (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= REDUCED_STRING_MAX)) {
      out[k] = v
      extras++
    }
  }
  return out
}

/** At most this many entries on disk. `DELIVERY_QUEUE_CAPACITY` per target bounds it in practice. */
export const QUEUE_PERSIST_MAX = 1024
/** The longest TTL a restored entry may claim — a hand-edited `ttlMs` must not keep one forever. */
export const QUEUE_PERSIST_TTL_MAX = 24 * 60 * 60 * 1000

/** The verbs a restored entry may still deliver. A board comment stays out on purpose (only the
 *  local user, typing in THIS app, may trigger one). `station-notice` was out until T240 — see the
 *  header: its expiry spawned a dead letter that was itself a notice, so a restart fed the chain.
 *  EVERY verb in this set has a NODE-ID source, which is what lets the sanitize guard below key on
 *  the set: a station notice's source is the station the notice is about (station-notice.ts's
 *  monitor and the outcome store) or the original message's target (main's two reversed routes —
 *  the expiry dead letter and the undelivered-sender notice), a node id at every production site.
 *  A board comment's `board-comment:<id>` source is the one non-node source in the file, and it is
 *  not in this set. */
const RESTORABLE_VERBS: ReadonlySet<string> = new Set(['send', 'reply', 'notify', 'station-notice'])

const EXTRA_KEY_RE = /^[A-Za-z][A-Za-z0-9]{0,40}$/

/** Re-check one entry read from disk (hand-editable input). `null` drops it. */
export function sanitizePersistedQueueEntry(raw: unknown): PersistedQueueEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  const r = e.req as Record<string, unknown> | null
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null
  if (typeof r.targetNodeId !== 'string' || !isSafeNodeId(r.targetNodeId)) return null
  // A board comment's source is `board-comment:<id>`, never a node id; everything else is a node.
  if (typeof r.sourceNodeId !== 'string' || r.sourceNodeId.length === 0 || r.sourceNodeId.length > 200)
    return null
  if (typeof r.verb !== 'string' || r.verb.length > 40) return null
  if (RESTORABLE_VERBS.has(r.verb) && !isSafeNodeId(r.sourceNodeId)) return null
  if (typeof r.sourceTitle !== 'string' || r.sourceTitle.length > 1000) return null
  if (typeof r.body !== 'string' || r.body.length > QUEUE_PERSIST_BODY_MAX) return null
  const req: QueuedDeliveryRequest = {
    sourceNodeId: r.sourceNodeId,
    targetNodeId: r.targetNodeId,
    sourceTitle: r.sourceTitle,
    body: r.body,
    verb: r.verb
  }
  let extras = 0
  for (const [k, v] of Object.entries(r)) {
    if (k in req) continue
    if (!EXTRA_KEY_RE.test(k) || ++extras > 16) return null
    if (typeof v === 'string' ? v.length > 64 * 1024 : typeof v !== 'number' && typeof v !== 'boolean')
      return null
    req[k] = v
  }
  const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  if (!fin(e.enqueuedAt) || !fin(e.ttlMs) || e.ttlMs <= 0 || e.ttlMs > QUEUE_PERSIST_TTL_MAX) return null
  if (typeof e.queuedTraceId !== 'string' || e.queuedTraceId.length > 200) return null
  const out: PersistedQueueEntry = {
    req,
    enqueuedAt: e.enqueuedAt,
    ttlMs: e.ttlMs,
    queuedTraceId: e.queuedTraceId
  }
  if (e.binding !== undefined) {
    const b = e.binding as Record<string, unknown> | null
    if (!b || typeof b !== 'object') return null
    const binding: QueueBinding = {}
    if (b.sessionId !== undefined) {
      if (typeof b.sessionId !== 'string' || b.sessionId.length > 200) return null
      binding.sessionId = b.sessionId
    }
    if (b.agentId !== undefined) {
      if (typeof b.agentId !== 'string' || b.agentId.length > 200) return null
      binding.agentId = b.agentId
    }
    out.binding = binding
  }
  if (e.bodyOmitted === true) out.bodyOmitted = true
  return out
}

/** The queue's durable file (core/durable-state.ts). */
export const QUEUE_FACT: DurableFactSpec<PersistedQueueEntry> = {
  kind: 'delivery-queue',
  version: 1,
  maxRecords: QUEUE_PERSIST_MAX,
  sanitize: sanitizePersistedQueueEntry
}

/**
 * May a RESTORED entry go into the target now? Four dispositions (T237), because the ledger alone
 * may not issue a death certificate and may not decide that a question is unanswerable forever:
 *
 *  - `deliver`    — recorded and current agree on the conversation: run the gate chain.
 *  - `wait`       — the CURRENT binding is not known YET (the mirror has not named a session for
 *                   the node, which is normal for a beat after a restart). Re-queue; the TTL keeps
 *                   running and the very next flush may deliver it.
 *  - `unprovable` — the ENTRY recorded no session id, so nothing can ever prove the target is
 *                   still the conversation it was addressed to. HOLD, do not deliver, and do NOT
 *                   declare the target dead: the entry runs to its TTL and ends with the honest
 *                   notice. (T237② — this arm used to return `gone`, and it is the arm that fired
 *                   in the field: a `send` enqueued while the target was mid-turn was restored
 *                   without a binding and dropped as a death, with the target's tmux session
 *                   alive the whole time.)
 *  - `gone`       — the ledger says a DIFFERENT conversation (another session id, or another agent
 *                   in the pane). This is the ledger's OPINION, not a verdict: the caller asks the
 *                   host before it may become terminal (T237①).
 */
export function restoredBindingVerdict(
  recorded: QueueBinding | undefined,
  current: QueueBinding | undefined
): 'deliver' | 'wait' | 'unprovable' | 'gone' {
  if (!recorded?.sessionId) return 'unprovable'
  if (!current?.sessionId) return 'wait'
  if (current.sessionId !== recorded.sessionId) return 'gone'
  if (recorded.agentId && current.agentId && current.agentId !== recorded.agentId) return 'gone'
  return 'deliver'
}

/** Outcomes that mean "the target still is not ready, come back" — a flush that gets one of these
 *  RE-QUEUES the entry at the front (its TTL keeps counting from the original enqueue) and STOPS
 *  draining, because one idle event does not promise the target stays idle. Derived from `RETRYABLE`
 *  minus the two outcomes the queue itself produces (`queueFull`, `expired`) — so `deliver`'s
 *  retryable outcomes (`rateLimited`, `targetBusy`, `targetNotIdleUnknown`, `targetStatusStale`) all
 *  wait for the NEXT idle, and a new retryable outcome added upstream is handled here the moment it
 *  exists rather than silently dropped. `rateLimited` waiting for the next idle (not re-flushing on a
 *  timer) is what keeps the queue from spinning against the very limiter that refused it.
 *
 *  T234 subtracts one more, and the subtraction is the point of the ticket: `targetWriteFailed` is a
 *  write that burned its bounded retries against a session the host still sees, so it is TERMINAL —
 *  keeping it would re-run those retries at every idle event and report nothing. `targetWriteHeld`
 *  is its opposite and IS here: the write failed for a reason that says nothing about the target
 *  (the shell was quitting, or the probe could not answer), so the entry waits and survives. */
const REQUEUE_ON: ReadonlySet<AgentMessageOutcome['kind']> = new Set(
  (Object.keys(RETRYABLE) as AgentMessageOutcome['kind'][]).filter(
    (k) => RETRYABLE[k] && k !== 'queueFull' && k !== 'expired' && k !== 'targetWriteFailed'
  )
)

export class DeliveryQueue {
  private readonly queues = new Map<string, QueueEntry[]>()
  /** At most one pending retry nudge per target (`retryAfter`). */
  private readonly nudges = new Map<string, CancelTimer>()
  private readonly capacity: number
  private readonly ttlMs: number
  private readonly schedule: (ms: number, fn: () => void) => CancelTimer

  constructor(
    private readonly deps: DeliveryQueueDeps,
    opts: { capacity?: number; ttlMs?: number } = {}
  ) {
    this.capacity = opts.capacity ?? DELIVERY_QUEUE_CAPACITY
    this.ttlMs = opts.ttlMs ?? DELIVERY_QUEUE_TTL_MS
    this.schedule =
      deps.schedule ??
      ((ms, fn): CancelTimer => {
        const t = setTimeout(fn, ms)
        return () => clearTimeout(t)
      })
  }

  /** How many messages are queued for a target right now — for assertions and a position count. */
  depth(nodeId: string): number {
    return this.queues.get(nodeId)?.length ?? 0
  }

  /**
   * Enqueue a message whose initial delivery refused as `targetBusy` (or whose target is
   * hibernated). Returns the `queued` receipt (with its position, TTL and — since T207 — `queuedBecause`,
   * the gate that held it, plus `liveWait` when a live target will re-arm rather than expire) or
   * `queueFull` at the bound — never enqueues past capacity. A `hibernated` target is woken here,
   * before it is idle; the wake's eventual idle event is what triggers the flush.
   */
  async enqueue(
    req: QueuedDeliveryRequest,
    opts: { hibernated?: boolean; ttlMs?: number; queuedBecause?: string } = {}
  ): Promise<
    Extract<AgentMessageOutcome, { kind: 'queued' } | { kind: 'queueFull' }>
  > {
    const list = this.queues.get(req.targetNodeId) ?? []
    if (list.length >= this.capacity) {
      // Refused, not dropped-oldest: an accepted message is never silently discarded to make room.
      return { kind: 'queueFull', capacity: this.capacity }
    }
    const now = this.deps.now()
    const t = await this.deps.trace({
      sourceNodeId: req.sourceNodeId,
      sourceTitle: req.sourceTitle,
      targetNodeId: req.targetNodeId,
      outcome: 'queued',
      bodyChars: req.body.length
    }, req)
    const binding = this.deps.bindingOf?.(req.targetNodeId)
    // A caller may ask for a longer wait than the queue's default (a target that has not STARTED
    // yet waits for a person to open its project), bounded by what a restored entry may claim.
    const ttlMs = Math.min(opts.ttlMs ?? this.ttlMs, QUEUE_PERSIST_TTL_MAX)
    const entry: QueueEntry = {
      req,
      enqueuedAt: now,
      ttlMs,
      queuedTraceId: t.traceId,
      cancelTimer: this.schedule(ttlMs, () => void this.expire(req.targetNodeId, entry)),
      ...(binding ? { binding: { ...binding } } : {})
    }
    list.push(entry)
    this.queues.set(req.targetNodeId, list)
    this.persist()
    this.deps.onQueued?.(req)
    // Kick the wake for a hibernated target so it starts its resume; the flush waits on the idle
    // event, not on the wake. A busy (non-hibernated) target needs nothing — it will go idle on its
    // own turn end.
    if (opts.hibernated) this.deps.wake?.(req.targetNodeId)
    return {
      kind: 'queued',
      traceId: t.traceId,
      position: list.length,
      ttlMs,
      ...(opts.queuedBecause ? { queuedBecause: opts.queuedBecause } : {}),
      // The receipt must not promise a deadline the queue will not keep: with a session probe
      // wired, `expire` re-arms for a live target instead of dropping the entry. (Read off
      // `sessionLiveness`, the field the probe actually arrives in — reading a stale name here is
      // how the receipt kept promising a deadline the queue no longer had.)
      ...(this.deps.sessionLiveness ? { liveWait: true } : {})
    }
  }

  /**
   * The target went idle — flush its queue, oldest first. Each entry is delivered through
   * `deps.deliver`, which RE-RUNS the whole gate chain against live state (the flush-time
   * re-validation). An entry whose flush says "still not ready" is put back (its TTL unchanged); any
   * other outcome is terminal and the entry is gone. Draining stops the moment the target is not
   * ready again — one idle event does not promise the target stays idle across N deliveries.
   */
  async onTargetIdle(nodeId: string): Promise<void> {
    for (;;) {
      const list = this.queues.get(nodeId)
      if (!list || list.length === 0) return
      const entry = list[0]
      // T228③: the head is inside a RATE-LIMIT HOLD — do not spend an attempt on it. A `done` from
      // the very turn that hit the limit arrives while the cooldown is still running, and without
      // this guard that idle event would burn the ladder one rung per errored turn while telling
      // the sender nothing. Re-arm the clock and wait it out.
      //
      // The entry is STILL IN THE LIST here (it is only shifted off below, just before a real
      // attempt), so this must NOT call `requeueFront` — that unshifts a second copy of it. Its TTL
      // timer is likewise still armed from the last requeue; only the nudge is owed.
      const holdUntil = entry.holdUntil ?? 0
      if (holdUntil > this.deps.now()) {
        this.retryAfter(nodeId, holdUntil - this.deps.now())
        return
      }
      // Take it off before delivering: a re-entrant idle event (deliver can await a real round-trip)
      // must not flush the same entry twice. It goes back on failure, at the FRONT, preserving order.
      list.shift()
      entry.cancelTimer()
      // Written off disk BEFORE the attempt (claim before effect): a crash mid-delivery then loses
      // this one message rather than typing it twice after the next boot. At most once.
      this.persist()
      // ── A RESTORED ENTRY: THE LEDGER IS NOT ENOUGH (T237) ──────────────────────────────────────
      //
      // See `restoredBindingVerdict` for the four dispositions. Two of them change an ENTRY's state
      // rather than answering: `unprovable` and an unconfirmed `gone` both mark the entry as
      // carrying an unproven binding, which is what lets `expire` end it honestly instead of
      // re-arming forever (see there).
      const verdict = entry.restored
        ? restoredBindingVerdict(entry.binding, this.deps.bindingOf?.(nodeId))
        : 'deliver'
      if (verdict === 'deliver') {
        // T237: a binding that AGREES again makes a held entry deliverable — the pane can legitimately
        // come back under the same session id (a cold restore resumes it), and the hold must not
        // outlive the reason for it.
        delete entry.bindingUnproven
      }
      if (verdict === 'wait') {
        this.requeueFront(nodeId, entry)
        return
      }
      if (verdict === 'unprovable') {
        entry.bindingUnproven = true
        this.requeueFront(nodeId, entry)
        return
      }
      if (verdict === 'gone') {
        // T237① — THE LEDGER'S OPINION, CROSS-CHECKED WITH THE HOST. `restoredBindingVerdict` says
        // the conversation changed; that is a fact about the RECORD, and the record's own opinion
        // was enough to drop a live station's mail in the field (02:55:05, same-millisecond
        // board-log pair, no write attempted, the target's tmux session alive throughout). Only a
        // host that ALSO says the session is absent licenses the terminal verdict; `live` and
        // `unknown` keep the entry, with the honest ending the TTL owes it.
        const liveness = await this.liveness(nodeId)
        if (liveness !== 'gone') {
          entry.bindingUnproven = true
          this.requeueFront(nodeId, entry)
          return
        }
      }
      const outcome: AgentMessageOutcome =
        verdict === 'gone' ? { kind: 'targetGone' } : await this.deps.deliver(entry.req)
      // T228③: the TARGET's provider cooldown is a clock, not a turn. Nothing will report "idle"
      // when it ends, so this branch re-offers on a timer, with the ladder's own bound. It is
      // checked BEFORE the generic requeue below, which would wait for an idle event that a
      // rate-limited target has no reason to send.
      if (outcome.kind === 'rateLimited' && outcome.rateLimitedUntil !== undefined) {
        await this.holdForCooldown(nodeId, entry, outcome.retryAfterMs)
        return
      }
      if (REQUEUE_ON.has(outcome.kind)) {
        // Not ready yet (busy again, still unverified, or rate-limited): keep it, TTL counting from
        // its ORIGINAL enqueue, and stop draining — the target is evidently not idle after all.
        this.requeueFront(nodeId, entry)
        return
      }
      // Terminal: delivered, or a refusal waiting will not fix (notPermitted from a revoked grant,
      // targetGone, targetNotAgentPane…). The entry is done; tell the sender and move to the next.
      if (this.queues.get(nodeId)?.length === 0) this.queues.delete(nodeId)
      this.persist()
      this.deps.onFlushed?.(entry.req, outcome)
    }
  }

  /**
   * T228③ — put a rate-limited entry back and re-offer it on an exponential ladder seeded by the
   * provider's own `retryAfter`, or END it as a dead letter once the ladder's bound is reached.
   *
   * Both caps are the ticket's: `RATE_LIMIT_MAX_ATTEMPTS` re-offers, and `RATE_LIMIT_MAX_WAIT_MS` of
   * total waiting (a much shorter reading can ladder past five attempts within the attempt count —
   * whichever runs out first is the end). The end is `reportExpired`, the SAME leg every other
   * queued ending takes, so the durable board line, the in-band dead letter and the receipt all say
   * the one thing (`EXPIRY_REASON_TEXT`) rather than this path inventing a second notice.
   */
  private async holdForCooldown(nodeId: string, entry: QueueEntry, retryAfterMs: number): Promise<void> {
    const attempts = (entry.rateLimitAttempts ?? 0) + 1
    const waited = this.deps.now() - entry.enqueuedAt
    if (attempts >= RATE_LIMIT_MAX_ATTEMPTS || waited >= RATE_LIMIT_MAX_WAIT_MS) {
      const list = this.queues.get(nodeId)
      const i = list?.indexOf(entry) ?? -1
      if (list && i >= 0) {
        list.splice(i, 1)
        if (list.length === 0) this.queues.delete(nodeId)
      }
      entry.cancelTimer()
      this.persist()
      await this.reportExpired(entry, 'rate-limit-exhausted')
      return
    }
    entry.rateLimitAttempts = attempts
    const backoff = Math.min(
      Math.max(0, retryAfterMs) * 2 ** (attempts - 1),
      RATE_LIMIT_MAX_BACKOFF_MS
    )
    entry.holdUntil = this.deps.now() + backoff
    this.requeueFront(nodeId, entry)
    this.retryAfter(nodeId, backoff)
  }

  /**
   * Re-offer a target's queue after `ms` — for an entry held by a CLOCK (the pair window) rather than
   * by the target's turn. A busy target emits `done` when its turn ends, which is what flushes the
   * queue; a pair window ending emits nothing, so an entry waiting only on it (the target idle all
   * along, or its `done` having landed inside the window) would otherwise sit until its TTL expired.
   *
   * One pending nudge per target: a second request while one is armed is dropped, and a nudge that
   * fires too early simply meets the same refusal, whose caller arms the next. Bounded by the TTL — an
   * expired or delivered entry leaves an empty queue, and a nudge on an empty queue does nothing — and
   * cheap: a refusal on the pair window is decided before any pane probe.
   */
  retryAfter(nodeId: string, ms: number): void {
    if (this.nudges.has(nodeId)) return
    const cancel = this.schedule(Math.max(0, ms), () => {
      this.nudges.delete(nodeId)
      void this.onTargetIdle(nodeId)
    })
    this.nudges.set(nodeId, cancel)
  }

  /** Put an entry back at the front with its TTL re-armed for the time it has LEFT (never reset to a
   *  full TTL — the wait it has already served counts). A lapsed remainder expires it immediately. */
  private requeueFront(nodeId: string, entry: QueueEntry): void {
    const remaining = Math.max(0, entry.ttlMs - (this.deps.now() - entry.enqueuedAt))
    entry.cancelTimer = this.schedule(remaining, () => void this.expire(nodeId, entry))
    const list = this.queues.get(nodeId) ?? []
    list.unshift(entry)
    this.queues.set(nodeId, list)
    this.persist()
  }

  /**
   * A queued message waited out its TTL. Remove it, trace `expired`, and tell the sender — both
   * legs, because a dropped message with no record anywhere is the failure this module refuses to
   * have. Idempotent against a flush that already removed the entry (the timer can fire in the seam
   * before its cancel runs).
   */
  /**
   * Ask the host about the target's session, as a tri-state. An unwired probe, a throwing probe or
   * an answer that is none of the three words is `unknown` — never `gone`. Fail-closed here means
   * "do not claim to know", which is the opposite of the old boolean's fail-closed, and it is the
   * fix: a probe that could not answer was being reported as a death certificate.
   */
  private async liveness(nodeId: string): Promise<SessionLiveness> {
    if (!this.deps.sessionLiveness) return 'unknown'
    try {
      return await this.deps.sessionLiveness(nodeId)
    } catch {
      return 'unknown'
    }
  }

  private async expire(nodeId: string, entry: QueueEntry): Promise<void> {
    const list = this.queues.get(nodeId)
    if (!list) return
    const i = list.indexOf(entry)
    if (i < 0) return // already delivered/re-queued with a fresh timer — this fire is stale
    // T205: a LIVE target never lets its entries expire. A busy turn can easily outlive the 5-minute
    // TTL (agents routinely run 10-20 minutes), and expiring a reachable message is the silent loss
    // this queue exists to refuse. Re-arm instead: the entry stays queued and the target's next
    // `done` flushes it. An ERRORED last turn is still a live, waitable state — the CLI sits at its
    // prompt, the turn's own end posted a done, and typing reaches it. Only a session the host says
    // is GONE expires without another wait, with the sender told (the dead-letter below).
    //
    // T207b: the probe's `unknown` is not `gone` — an expiry it causes still happens (nothing else
    // can end the wait, and the message cannot be typed into a pane the host cannot find), but the
    // sender hears "I could not confirm", never "it died".
    //
    // T237: the re-arm's PREMISE is reachability — it exists so that a message which could still be
    // typed into a live target is not expired under it. An entry whose binding to a conversation is
    // unproven is NOT reachable (the flush refused to type it, and nothing will make the record
    // provable again), so the premise fails and the entry reaches its honest ending instead of
    // being held against a clock forever.
    //
    // The ledger is consulted HERE too, not only at flush time: an entry whose target simply never
    // emits another idle event would otherwise never be evaluated at all, and the honest ending this
    // disposition owes would never arrive. Cheap (a mirror lookup) and it decides the REASON only —
    // nothing is delivered from this path.
    const liveness = await this.liveness(nodeId)
    const verdict = entry.restored
      ? restoredBindingVerdict(entry.binding, this.deps.bindingOf?.(nodeId))
      : 'deliver'
    const unproven =
      entry.bindingUnproven === true ||
      verdict === 'unprovable' ||
      // A record that DISAGREES is only a death when the host also says the session is gone; on a
      // live or unanswered probe it is the same non-death as an unprovable one (T237①).
      (verdict === 'gone' && liveness !== 'gone')
    if (liveness === 'live' && !unproven) {
      entry.cancelTimer()
      entry.cancelTimer = this.schedule(DELIVERY_QUEUE_TTL_MS, () =>
        void this.expire(nodeId, entry)
      )
      return
    }
    list.splice(i, 1)
    if (list.length === 0) this.queues.delete(nodeId)
    entry.cancelTimer()
    this.persist()
    await this.reportExpired(
      entry,
      unproven ? 'binding-unproven' : liveness === 'gone' ? 'session-gone' : 'session-unknown'
    )
  }

  /** Trace `expired` and tell the sender — the two legs every expiry owes, `reason` included so
   *  neither says more than the host knows. */
  private async reportExpired(entry: QueueEntry, reason: QueueExpiryReason): Promise<void> {
    const queuedForMs = this.deps.now() - entry.enqueuedAt
    const t = await this.deps.trace({
      sourceNodeId: entry.req.sourceNodeId,
      sourceTitle: entry.req.sourceTitle,
      targetNodeId: entry.req.targetNodeId,
      outcome: 'expired',
      // The durable line carries WHY, as words rather than a token: a reader of the board history
      // is a person (or an agent) deciding whether to re-send, and the old line left them with the
      // same unproven death claim this change removed from the receipts.
      reason: EXPIRY_REASON_TEXT[reason],
      bodyChars: entry.req.body.length
    }, entry.req)
    this.deps.onExpired?.(entry.req, {
      traceId: t.traceId,
      queuedForMs,
      reason,
      bodyOmitted: entry.bodyOmitted === true
    })
  }

  /** Every queued entry as it is written to disk, oldest first per target. */
  snapshot(): PersistedQueueEntry[] {
    const out: PersistedQueueEntry[] = []
    // The file is set aside WHOLE at load past DURABLE_STATE_MAX_BYTES, so the write is budgeted:
    // once the full entries reach QUEUE_PERSIST_BYTES_BUDGET (JSON bytes, oldest first per target),
    // the rest are written REDUCED — no body, only short fields — which restore turns into an
    // expiry the sender hears about. Never a file the next boot throws away with every message in it.
    let used = 0
    for (const list of this.queues.values()) {
      for (const e of list) {
        const base = {
          enqueuedAt: e.enqueuedAt,
          ttlMs: e.ttlMs,
          queuedTraceId: e.queuedTraceId,
          ...(e.binding ? { binding: e.binding } : {})
        }
        const full: PersistedQueueEntry = { req: e.req, ...base }
        const size = e.req.body.length > QUEUE_PERSIST_BODY_MAX ? Infinity : JSON.stringify(full).length
        if (used + size <= QUEUE_PERSIST_BYTES_BUDGET) {
          used += size
          out.push(full)
          continue
        }
        const reduced: PersistedQueueEntry = { req: reducedRequest(e.req), ...base, bodyOmitted: true }
        used += JSON.stringify(reduced).length
        out.push(reduced)
      }
    }
    return out
  }

  /**
   * Bring back entries an earlier process queued (boot, after every listener is wired). Each one is
   * announced through `onQueued` like a fresh enqueue; one whose wall-clock TTL lapsed while the app
   * was down — or that may not flush after a restart at all — is then EXPIRED at once (traced, and
   * the sender told). The rest wait for their target's next `done` with the TTL they have LEFT.
   * Capacity still applies per target; an entry past it is expired rather than dropped.
   */
  async restore(entries: readonly PersistedQueueEntry[]): Promise<void> {
    const now = this.deps.now()
    const lapsed: { entry: QueueEntry; reason: QueueExpiryReason }[] = []
    for (const p of entries) {
      // A clock that went backwards must not stretch the wait past one full TTL.
      const age = Math.max(0, now - p.enqueuedAt)
      const remaining = Math.min(p.ttlMs, p.ttlMs - age)
      const entry: QueueEntry = {
        req: p.req,
        enqueuedAt: Math.min(p.enqueuedAt, now),
        ttlMs: p.ttlMs,
        queuedTraceId: p.queuedTraceId,
        cancelTimer: () => {},
        restored: true,
        ...(p.binding ? { binding: p.binding } : {}),
        // T240④: a reduced entry's end must be traceable to "nothing was on disk" — the in-band
        // leg reads this to keep a bodyless notice from spawning another notice.
        ...(p.bodyOmitted ? { bodyOmitted: true } : {})
      }
      this.deps.onQueued?.(entry.req)
      // Capacity counts only what is really re-queued: a lapsed entry never takes a slot.
      const restorable =
        !p.bodyOmitted &&
        RESTORABLE_VERBS.has(String(p.req.verb)) &&
        this.depth(p.req.targetNodeId) < this.capacity
      if (!restorable) {
        // Never inserted into the live lists: a flush running during one of the expiries below
        // must not be able to deliver a board comment or an empty (body-omitted) entry. Its end is
        // NOT a session fact — say only what is true of the entry itself.
        lapsed.push({ entry, reason: 'not-restorable' })
        continue
      }
      // T205 + T207b. The probe comes FIRST, before the deadline decides anything: the TTL running
      // out while the app was down says NOTHING about the target's session, and the old order
      // expired a clock-lapsed entry without asking at all — which is how a hand-resumed pane whose
      // tmux session was alive got a dead letter saying its session was gone. A lapsed deadline on
      // a LIVE target re-queues with a fresh TTL (its delivery path is intact); a lapsed one the
      // host says is gone expires; a lapsed one the host cannot speak for expires AS UNCERTAIN.
      const liveness = await this.liveness(p.req.targetNodeId)
      if (liveness === 'live' || remaining > 0) {
        const live = liveness === 'live'
        const ttl = live ? DELIVERY_QUEUE_TTL_MS : remaining
        const list = this.queues.get(p.req.targetNodeId) ?? []
        list.push(entry)
        this.queues.set(p.req.targetNodeId, list)
        entry.cancelTimer = this.schedule(ttl, () => void this.expire(p.req.targetNodeId, entry))
        continue
      }
      lapsed.push({ entry, reason: liveness === 'gone' ? 'session-gone' : 'session-unknown' })
    }
    // The lapsed entries' ends are reported BEFORE the file drops them: a crash in between reports
    // one twice at the next boot, never not at all.
    for (const { entry, reason } of lapsed) await this.reportExpired(entry, reason)
    this.persist()
  }

  private persist(): void {
    this.deps.persist?.(this.snapshot())
  }

  /** Test seam / shutdown: cancel every timer and drop every queue WITHOUT tracing (a teardown is
   *  not an expiry the sender needs to hear about). */
  resetForTests(): void {
    for (const list of this.queues.values()) for (const e of list) e.cancelTimer()
    this.queues.clear()
    for (const cancel of this.nudges.values()) cancel()
    this.nudges.clear()
  }
}
