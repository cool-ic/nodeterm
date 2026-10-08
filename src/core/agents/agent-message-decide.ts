import type { MirrorEntry } from '../agent-status-mirror'
import type { AgentPaneVerdict } from '../../shared/agents/pane-owner-predicate'
import type { QueueExpiryReason } from './delivery-queue'
import { MIN_TOKEN_AWARE_REVISION } from './hooks/managed-script'

/**
 * THE PURE DECIDER — every reason a delivery may not happen, decided without a single side effect.
 *
 * The control surface is a boolean all the way down today: `sendText` returns `Promise<boolean>`,
 * the handler turns it into `{ ok, 'sent' | 'failed' }`, the route into 200/400, the shim into
 * exit 1. The caller here is a LANGUAGE MODEL, and an agent that cannot tell "not allowed" from
 * "target busy" retries the wrong one — with a per-pair rate limiter in front of it (PR 4), that is
 * a busy-loop that burns tokens and produces nothing.
 *
 * So the result is a discriminated union, and whether to retry is DATA (`RETRYABLE`), not prose.
 *
 * Nothing in this module reads the clock, the filesystem, a pane or a socket. Every fact arrives in
 * `DeliveryFacts`, which is what lets Task 3.3 test the sequencing without a pty and this file test
 * the policy without either.
 */

/**
 * `unaddressable-node-id` is deliberately its own word rather than a shade of `cross-project`: an
 * id outside `isSafeNodeId` may well be listed in the sender's OWN project file (nothing validates
 * ids on the load path), so calling it a project-scope failure would be a false statement about
 * why it was refused — and it needs a different action from the human. See `agent-message-scope.ts`.
 */
export type NotPermittedReason =
  | 'switch-off'
  | 'cross-project'
  | 'self-send'
  | 'unsupported-edition'
  | 'unaddressable-node-id'
  /** Server Edition's process-local creator ledger says the sender did not spawn this target in
   *  the current server run. This is separate from pane/project ownership: proving which project
   *  spawned a pane does not prove which agent is allowed to control it. */
  | 'caller-not-owner'
  /** The target id names nodes in MORE THAN ONE project while panes are keyed by the bare id —
   *  one global pane, several possible owners, and one of them may be ungranted. Refused because
   *  the per-project grant cannot be attributed (PR #237 review I-1); its own word because the
   *  human's fix is de-duplicating ids, not moving nodes. See `agent-message-scope.ts`. */
  | 'ambiguous-target-node-id'
  /** No RUNTIME proof of which project spawned the target pane: the ledger has no entry (never
   *  spawned this run, or only re-attached after a restart), or its owner disagrees with the sole
   *  store claimant (a project.json listing a pane it did not spawn). The store's node-set is
   *  attacker-writable, so ownership is proven at spawn, not read from the file (PR #237 fix
   *  round 2 — the confused deputy driven end-to-end); unprovable ⇒ refuse. Not retryable: the
   *  pane must be freshly (re)spawned by its real owner before it can be messaged. */
  | 'unproven-target-owner'

/** Which signal satisfied the delivery receipt (Task 3.4). */
export type ReceiptSignal = 'newTurn' | 'working'

/** Where a delivery's trace landed. `memory` is a bounded ring, not a durable log — see Task 3.5. */
export type TraceKind = 'board-log' | 'memory'

export type AgentMessageOutcome =
  | { kind: 'delivered'; traceId: string; traced: TraceKind; receipt: 'observed'; signal: ReceiptSignal }
  /**
   * `queuedBecause` is the gate that held the message, in the sender's terms; `liveWait` says the
   * queue can probe the target's session, so a LIVE one re-arms instead of expiring (T205) and
   * `ttlMs` is a floor for a dead session rather than a deadline. T207: a bare position and TTL
   * told the sender nothing about why its mail was parked or when it would end.
   */
  | {
      kind: 'queued'
      traceId: string
      position: number
      ttlMs: number
      queuedBecause?: string
      liveWait?: boolean
    }
  | { kind: 'stalled'; traceId: string; traced: TraceKind; waitedMs: number }
  | {
      kind: 'deliveredToReplacedTarget'
      traceId: string
      traced: TraceKind
      wasPane: string
      nowPane: string
    }
  /** `reason` (T207b) is WHY it ended, from the queue's own table: `session-gone` is the host's
   *  answer that nothing is there, `session-unknown` is a probe that could not say (never a death),
   *  `not-restorable` is an entry that did not survive a restart with enough to deliver it. */
  | { kind: 'expired'; traceId: string; queuedForMs: number; reason?: QueueExpiryReason }
  /**
   * Two different limits, ONE outcome (T228).
   *
   *  - `retryAfterMs` alone is THIS SENDER's pair window: the per-pair limiter (PR 4) says the two
   *    nodes have been talking too fast. The caller is a language model; it retries when it likes.
   *  - `rateLimitedUntil` present means the TARGET's own provider is rate limiting IT — an absolute
   *    epoch, read off the target's pane and carried on its status mirror. Sending now would open a
   *    turn that dies on the same text, so the shell HOLDS the message (the durable queue, a clock,
   *    not the target's turn) rather than spending a delivery on it.
   *
   * They share a kind deliberately: `RETRYABLE`, `DECISION_ORDER` and every caller that already
   * understands "rate limited" keep working unchanged, and the queue tells them apart by the one
   * field that only the target's cooldown can set.
   */
  | { kind: 'rateLimited'; retryAfterMs: number; rateLimitedUntil?: number }
  | { kind: 'queueFull'; capacity: number }
  | { kind: 'targetBusy'; state: string }
  | { kind: 'targetNotIdleUnknown'; reason: string }
  | { kind: 'targetStatusUnverified'; note: string } // no token file — needs a human. NOT retryable.
  | { kind: 'targetStatusStale' } // token file exists, no verified event yet. Retryable.
  | { kind: 'targetHookScriptStale'; note: string; observedRevision?: number } // Finding F2. NOT retryable.
  | { kind: 'targetPaneUnreadable' } // the pane probe failed/timed out — says NOTHING about the pane
  | { kind: 'targetNotAgentPane'; observed: string }
  | { kind: 'targetNotPasteAware' }
  | { kind: 'targetGone' }
  /**
   * T234 — the pane WRITE never went out, after the delivery's bounded retry, while the host still
   * sees the target's session (`SessionLiveness === 'live'`). Terminal and loud: the target is
   * there and the bytes still will not go, which is a real fault to report rather than a death to
   * assert. `attempts` is how many writes were tried; `reason` is the last failure, in words
   * (`WRITE_FAILURE_TEXT`), so the trace, the receipt and the sender's in-band notice agree.
   *
   * Before T234 a single `!wrote` was refused as `targetGone`, and the queue dropped the message in
   * silence — the T233 dispatch died that way, on a write that a plain retry delivered.
   */
  | { kind: 'targetWriteFailed'; attempts: number; reason: WriteFailureReason }
  /**
   * T234 — the pane write did not go out and the target may NOT be called dead: the shell is
   * tearing down (an app quit — the pane is unreachable because WE are going away), or the session
   * probe could not answer (T207b's third state). HELD, never dropped: the queue keeps the entry
   * (TTL/liveness rules unchanged) and a first attempt parks it there instead of refusing.
   */
  | { kind: 'targetWriteHeld'; attempts: number; reason: WriteFailureReason }
  | { kind: 'targetNotStarted' } // launch held, never spawned yet — queued when a queue is wired. Retryable.
  | { kind: 'notPermitted'; reason: NotPermittedReason }

/** Why a pane write ended without the bytes going out. The words live in ONE table
 *  (`WRITE_FAILURE_TEXT`) so the receipt, the durable trace line and the sender's in-band notice
 *  cannot drift into three different claims about the same failure. */
export type WriteFailureReason =
  /** Every bounded attempt reported failure, and the host says the session is still there. */
  | 'retries-exhausted'
  /** The shell was shutting down (an app quit) while the write ran. NOT a statement about the
   *  target: the pane is unreachable because this process is going away. */
  | 'shell-teardown'
  /** The session probe could not say whether the target is still there. NOT a death (T207b). */
  | 'session-unconfirmed'

export const WRITE_FAILURE_TEXT: Record<WriteFailureReason, string> = {
  'retries-exhausted':
    'the pane write reported failure on every attempt, and the target’s session is still live',
  'shell-teardown': 'nodeterm was shutting down, so the pane could not be written',
  'session-unconfirmed': 'nodeterm could not confirm whether the target’s session is still there'
}

export type AgentMessageOutcomeKind = AgentMessageOutcome['kind']

/**
 * The retry column, as data.
 *
 * The caller is a LANGUAGE MODEL: an outcome that is not retryable must SAY so, or it will try
 * again — and with a per-pair rate limiter in front of it, "try again" on a permanent refusal is a
 * busy-loop that burns tokens and produces nothing. A boolean return could not carry this, which is
 * the whole reason the surface stopped being a boolean.
 *
 * `Record<AgentMessageOutcomeKind, boolean>` makes the table exhaustive BY THE TYPE: a new union
 * member that is not listed here is a compile error, not a runtime `undefined` that reads as
 * "not retryable" and silently strands a whole class of caller.
 */
export const RETRYABLE: Record<AgentMessageOutcomeKind, boolean> = {
  delivered: false,
  queued: false,
  stalled: false,
  deliveredToReplacedTarget: false,
  expired: true,
  rateLimited: true,
  queueFull: true,
  targetBusy: true,
  targetNotIdleUnknown: true,
  targetStatusUnverified: false,
  targetStatusStale: true,
  targetHookScriptStale: false,
  targetPaneUnreadable: true,
  targetNotAgentPane: false,
  targetNotPasteAware: false,
  targetGone: false,
  // T234. Both are retryable for the SENDER (a retry is exactly what delivered the T233 dispatch
  // after the first write failed). The queue reads this table for its own requeue rule and
  // DELIBERATELY subtracts `targetWriteFailed` there: a write failure that burned every bounded
  // attempt is a terminal verdict, not a "come back at the next idle".
  targetWriteFailed: true,
  targetWriteHeld: true,
  targetNotStarted: true,
  notPermitted: false
}

/**
 * Order is load-bearing, and it is cheapest-and-most-permanent first.
 *
 * A caller that cannot be helped is told so WITHOUT a pane round-trip and WITHOUT burning
 * rate-limit budget. The two identity refusals sit ahead of the idle gate because an identity a
 * node cannot present is a more permanent fact than a turn it happens to be in the middle of.
 */
export const DECISION_ORDER = [
  'notPermitted',
  'rateLimited',
  'targetGone',
  'targetHookScriptStale',
  'targetStatusUnverified',
  'targetStatusStale',
  'targetNotIdleUnknown',
  'targetBusy',
  'targetPaneUnreadable',
  'targetNotAgentPane',
  'targetNotPasteAware'
] as const

/**
 * Where the free/paid line falls, and it is NOT a style choice.
 *
 * Everything before `targetNotAgentPane` is decidable from a map lookup and a local `existsSync`.
 * Everything from it on costs a tmux round-trip — and on an SSH project, an `ssh` one over a
 * ControlMaster that may be dead, in which case `-o ControlMaster=auto` makes it a real LOGIN.
 *
 * The plan's draft order put the pane verdict ahead of the identity and idle refusals. That reads
 * well and costs badly: `targetBusy` is the most common refusal in an orchestration session and one
 * of only four retryable outcomes, so under the draft order every retry of a busy target paid for a
 * probe. A message sent to a working agent every few seconds would then be the 72k-logins/day shape
 * this codebase already survived once. Free-before-paid wins, and the reported reason for a target
 * that is both busy AND on a stranger's pane changes from `targetNotAgentPane` to `targetBusy` —
 * accepted deliberately: it is retryable, so the caller comes back and learns the rest.
 */
export const FIRST_PAID_DECISION = 'targetNotAgentPane'

export interface DeliveryFacts {
  /** The sender. Compared to `targetNodeId` for the self-send backstop; absent skips that check. */
  sourceNodeId?: string
  targetNodeId?: string
  /** Set by PR 5/PR 6 (the verbs and the per-project switch). Cheapest gate: pure caller state. */
  notPermitted?: NotPermittedReason
  /** Set by PR 4's per-pair limiter. `> 0` means refuse now and say when. */
  retryAfterMs?: number
  /**
   * T228 — the TARGET's provider is rate limiting it, from the reading the shell took off its pane
   * when its last turn died (`MirrorEntry.rateLimited`). `until` is the epoch the cooldown ends and
   * `retryAfterMs` is how much of it is left; the decider folds BOTH limits into ONE `rateLimited`
   * decision (the later of the two wins) so `DECISION_ORDER` keeps a single entry for it, and the
   * `until` rides through to the outcome — its presence is what tells the shell to HOLD the message
   * instead of refusing it.
   *
   * A reading, not an authorization: nothing here may branch on it beyond declining to open a turn
   * the provider would refuse anyway.
   */
  cooldown?: { until: number; retryAfterMs: number }
  /** Is there a live session for this node at all? False ⇒ `targetGone`. */
  targetLive: boolean
  /**
   * Gate 1, from `isAgentPane` over `PtyManager.paneOwner` — kernel truth, three-valued.
   *
   * ── WHAT THIS VERDICT DOES NOT PROVE (carried from `pane-owner-predicate.ts` deliberately) ────
   *
   * `agent` proves the agent is IN the pane's foreground process group. It does NOT prove the agent
   * is the thing READING the tty. `sh -c "sleep 600 | claude"` answers `agent`, correctly — claude
   * really is in the group — but claude's stdin is the PIPE, so bytes written to the pane sit in
   * the tty buffer until the shell reads them after the pipeline exits. That is the
   * "rename splice = lost launch" shape: the write succeeds and the payload surfaces later,
   * somewhere else. The delivery RECEIPT (Task 3.4) is what makes that case observable rather than
   * silent — it is the only thing in this feature that can tell "B read it" from "the bytes are
   * sitting in a buffer" — and it is why a `stalled` outcome exists at all.
   *
   * Two false negatives are expected here and are NOT papered over: an agent script path containing
   * a SPACE (the argv split cannot tell it from two tokens) and a differently-named SYMLINK to the
   * agent binary (argv carries the name it was invoked as, not the target). Both answer `not-agent`
   * ⇒ `targetNotAgentPane`, a refusal, which is the safe direction. Do not "fix" either by matching
   * a substring of the command line: `vim /etc/claude.conf` would then be a claude pane.
   */
  pane: AgentPaneVerdict
  /** `#{pane_current_command}` (or 'unknown'), reported back so a refusal names what was seen. */
  paneObserved?: string
  /** The target's mirror entry — gate 2's entire input. `undefined` = this node has never posted. */
  target: MirrorEntry | undefined
  /** `nodeTokenFilePresent(targetNodeId)` — injected, so the decider stays pure. */
  tokenFilePresent: boolean
  /** Is the target on an SSH project? Only affects which ACTION a stale-script note names. */
  targetIsRemote?: boolean
  /**
   * T190: the caller is the target's RECORDED OPENER (`stationRecipient`'s rule — persisted
   * `openedBy` + visible rope + single project; the same trust level T187's ownership exception
   * uses). When set, the two "no observation this run" refusals (`targetStatusStale`, and the
   * restored / never-posted `targetNotIdleUnknown`) are WAIVED for this delivery: a live pane the
   * app itself re-attached will never post its first hook until something types into it, so the
   * opener's envelope IS the wake. Deliberately NOT waived: `targetBusy` (a VERIFIED busy turn is
   * queued, never interrupted), `idleInferred` (the target may be sitting on an approval — typing
   * there answers it), `stateExpired` / between-sessions (the CLI crossed a boundary mid-run).
   */
  mayWakeTarget?: boolean
  /**
   * Did the target's pane request bracketed paste? Deliberately OPTIONAL and deliberately last.
   *
   * `deliverAgentMessage` probes this only AFTER the gate passes, because the probe is a second
   * tmux round-trip and there is no point paying for it to tell a rate-limited caller something it
   * cannot act on. `undefined` therefore means "not asked yet", not "no".
   */
  pasteAware?: boolean
}

/** The one non-refusal. Kept out of `AgentMessageOutcome` so no caller can return it as a result. */
export interface Proceed {
  kind: 'proceed'
}

/** The shape of a standing rate-limit reading — `MirrorEntry.rateLimited` and `MirrorRateLimit`
 *  satisfy it structurally, so this module needs no dependency on the mirror to read one. */
export interface RateLimitReading {
  retryAfterMs: number
  /** When the reading was taken; the cooldown runs from here. */
  at: number
}

/**
 * T228 — a standing rate-limit reading as a live cooldown, or `null`.
 *
 * `null` for a node with no reading and for one whose cooldown has already run out: the second case
 * is why this is a function of `now` rather than a field. The reading is deliberately NOT deleted
 * when it lapses — it still describes the turn that ended, which is what `list` reports — so the
 * gate must judge the deadline itself. Pure; the clock arrives as an argument.
 */
export function rateLimitCooldown(
  reading: RateLimitReading | undefined,
  now: number
): { until: number; retryAfterMs: number } | null {
  if (!reading) return null
  const until = reading.at + reading.retryAfterMs
  const retryAfterMs = until - now
  return retryAfterMs > 0 ? { until, retryAfterMs } : null
}

/**
 * Gate 2 — the target must be KNOWN idle on a VERIFIED status, and unknown is NOT idle.
 *
 * Modelled on `hibernation-policy.planHibernation` (`c.state === 'done'`, plus a never-seen node
 * being permanently ineligible), NOT on `restartEligibility`, whose `BUSY_STATES` is only
 * `{working, blocked}` — so `waiting` and `undefined` pass it. That is acceptable for a
 * user-initiated restart with a human watching the pane. It is not acceptable for an autonomous
 * write into somebody else's session.
 *
 * Refused, each with its own reason:
 *  - `undefined` (post-relaunch, or right after a `sessionPhase:'start'` reset — a CLI that has
 *    just launched is the most fragile moment a pane has),
 *  - `working` / `blocked` / `waiting` (busy, and retryable),
 *  - a RESTORED entry: 6-hour-old evidence off disk about a pane that has since done anything at
 *    all, including being replaced,
 *  - a `done` inferred from `idle_prompt` (`idleInferred`): a node blocked on an approval is also
 *    "idle at the prompt",
 *  - any `done` whose evidence was `stateVerified: false` — handled EARLIER, by the three identity
 *    refusals, because an unprovable identity is the more permanent fact.
 */
function idleRefusal(e: MirrorEntry | undefined, mayWakeTarget = false): AgentMessageOutcome | null {
  if (!e) {
    // T190: nothing has EVER been observed for a live pane — the same restart blindness the
    // `targetStatusStale` branch above serves. The opener's envelope wakes the node.
    if (mayWakeTarget) return null
    return { kind: 'targetNotIdleUnknown', reason: 'no status has ever been posted for this node' }
  }
  if (e.restored)
    return mayWakeTarget
      ? null
      : {
          kind: 'targetNotIdleUnknown',
          reason: 'the last known status was restored from disk at startup, not observed this run'
        }
  // An identity-only entry: the mirror kept the session id past EXPIRE_MS but threw the state away.
  if (e.stateExpired)
    return {
      kind: 'targetNotIdleUnknown',
      reason: 'the last known status expired (no hook event for over 6 hours)'
    }
  if (e.state === undefined)
    return { kind: 'targetNotIdleUnknown', reason: 'the node is between sessions (no current state)' }
  if (e.state !== 'done') return { kind: 'targetBusy', state: e.state }
  if (e.idleInferred)
    return {
      kind: 'targetNotIdleUnknown',
      reason: 'the last `done` was inferred from the CLI going idle at its prompt, which a node ' +
        'waiting on an approval also does'
    }
  return null
}

/** The action a stale hook script needs, named per surface — because they genuinely differ. */
export function hookScriptStaleNote(targetIsRemote: boolean | undefined): string {
  return targetIsRemote
    ? 'the target runs a hook script that predates per-node identity; reconnect the SSH project ' +
        'from the desktop that owns it (RemoteHooks.setup() is the only writer of a remote script)'
    : 'the target runs a hook script that predates per-node identity; restart the nodeterm app on ' +
        'that host (the boot install rewrites the script unconditionally)'
}

/** The action an unmintable node needs — `IDENTITY_RESTART_NOTE`'s shape, never a bare code. */
export const NO_TOKEN_FILE_NOTE =
  'the target has no per-node identity on this host: relaunch the node from the desktop, or open ' +
  'its project so its token is materialised, then try again'

/**
 * The THREE unverified refusals — three populations, three ACTIONS. Collapsing them is worse than a
 * bare refusal, because two of the three would otherwise be told to retry something that can never
 * succeed.
 *
 * 1. STALE SCRIPT (`clientRevision` absent or `< MIN_TOKEN_AWARE_REVISION`). The session runs a
 *    hook script that predates per-node identity and cannot read the token dir at all — the token
 *    file may well be sitting right there. Checked FIRST because it is the OUTER CAUSE: fixing it
 *    is what makes the other two checks mean anything. The action differs by surface — a local
 *    host's script is rewritten unconditionally at every boot (`install-helper.ts`), a remote
 *    host's only inside `RemoteHooks.setup()` on CONNECT, so an already-connected project needs a
 *    reconnect. NOT retryable: no number of retries reinstalls a script.
 * 2. NO TOKEN FILE. The node cannot prove itself at all. NOT retryable — it needs a human.
 * 3. TOKEN FILE PRESENT, CURRENT SCRIPT, no verified event yet. It simply has not posted since the
 *    file appeared. Retryable — wait for its next turn.
 *
 * The trap #1 closes: before the script stamped itself (`X-Nodeterm-Hook-Client`), an old script
 * POSTing `version=2` with no token header was byte-identical on the wire to a current script whose
 * token file was merely missing. A token-file check alone would answer "retry after its next turn"
 * for the old-script case — forever, because the script cannot read the file. A permanently wrong
 * retry is worse than a refusal.
 *
 * Measured 2026-08-15: a PHONE-SPAWNED session lands in NONE of these on a host running nodeterm.
 * It sources the 0600 endpoint file it was handed, reads `$NODETERM_NODE_TOKEN_DIR/$NODETERM_NODE_ID`
 * and presents it, and verifies. rev. 3 of the design claimed the opposite; it was wrong, and the
 * reason it is wrong is the PERSIST-TIME token sweep (`refreshNodeTokens` on `onPersist`), NOT
 * `ptyManager.create` — which a phone-spawned session never touches.
 */
function identityRefusal(
  f: Pick<DeliveryFacts, 'target' | 'tokenFilePresent' | 'targetIsRemote' | 'mayWakeTarget'>
): AgentMessageOutcome | null {
  const e = f.target
  if (e?.stateVerified === true) return null
  // "Observed this run" is the precondition for reading a client revision at all: a restored entry
  // and a never-seen node carry no observation, so calling their script stale would be an
  // accusation we have no evidence for. They fall through to the token-file question, which is
  // answerable without an event.
  // An identity-only entry (`stateExpired`) is not an observation either: its state and every
  // piece of evidence about that state were stripped when it expired.
  const observed = !!e && e.restored !== true && e.stateExpired !== true
  if (observed && !(typeof e.clientRevision === 'number' && e.clientRevision >= MIN_TOKEN_AWARE_REVISION))
    return {
      kind: 'targetHookScriptStale',
      note: hookScriptStaleNote(f.targetIsRemote),
      ...(typeof e.clientRevision === 'number' ? { observedRevision: e.clientRevision } : {})
    }
  if (!f.tokenFilePresent) return { kind: 'targetStatusUnverified', note: NO_TOKEN_FILE_NOTE }
  // A node that HAS proven itself and whose CLI then crossed a session boundary (started, resumed,
  // ended) is not "stale" — it is between sessions, which is `idleRefusal`'s fact. Reporting it as
  // `targetStatusStale` told the caller the identity was the problem, while the real fact is that
  // no turn has been reported since the boundary.
  if (observed && e.state === undefined && typeof e.verifiedAt === 'number')
    return { kind: 'targetNotIdleUnknown', reason: SESSION_BOUNDARY_REASON }
  // T190: the recorded opener waking its own station. "No verified event this run" for a LIVE pane
  // the app itself re-attached is exactly the restart state — the queue's flush trigger (a first
  // verified `done`) never comes for a CLI sitting idle at its prompt, so the 5-minute TTL turns
  // every opener dispatch into a silent loss. The opener's envelope IS the wake: typing it into
  // the pane starts the turn that posts the hook. Every other identity refusal (no token file,
  // stale script, session boundary) stays put — those need a human or a restart, not a message.
  if (f.mayWakeTarget) return null
  return { kind: 'targetStatusStale' }
}

export const SESSION_BOUNDARY_REASON =
  'the node crossed a session boundary (its CLI started, resumed or exited) and has not reported ' +
  'a turn since'

/**
 * The gates that cost NOTHING to evaluate — decided before any pane is touched.
 *
 * This split is the reason `DECISION_ORDER` is ordered the way it is, made real: everything
 * decidable from a map lookup and a local stat is decided BEFORE anything touches a pane. Without
 * the split the order would be a comment — the refusal text would be right and the round-trip would
 * be paid anyway, which is exactly the kind of gap a source-reading test cannot see.
 *
 * The set is exhaustive as of `FIRST_PAID_DECISION`: `notPermitted`, self-send, `rateLimited` (the
 * sender's pair window AND, since T228, the target's own cooldown — both are a mirror/limiter read),
 * `targetGone`, the three identity refusals and the two idle ones. If a future gate is free, it
 * belongs here; if it needs a probe, it belongs after. The test asserts the boundary by RUNNING a
 * delivery and counting `paneOwner` calls, not by reading this sentence.
 *
 * `null` means "nothing decidable yet"; the caller probes and then calls `decideDelivery`.
 */
export function decidePreProbe(
  f: Pick<
    DeliveryFacts,
    | 'sourceNodeId'
    | 'targetNodeId'
    | 'notPermitted'
    | 'retryAfterMs'
    | 'cooldown'
    | 'targetLive'
    | 'target'
    | 'tokenFilePresent'
    | 'targetIsRemote'
    | 'mayWakeTarget'
  >
): AgentMessageOutcome | null {
  if (f.notPermitted) return { kind: 'notPermitted', reason: f.notPermitted }
  // SELF-SEND, and it is a backstop rather than the only guard.
  //
  // Gate 2 covers it by accident today: a sender is mid-turn, so its own mirror entry says
  // `working` and the delivery refuses as `targetBusy`. "By accident" is the problem — PR 7's
  // deliver-on-idle queue exists precisely to deliver to a node that is NOT mid-turn, and a node
  // messaging itself from its own queue is a loop with a rate limiter for a brake. Two lines here,
  // and no later caller can forget it.
  if (f.sourceNodeId && f.targetNodeId && f.sourceNodeId === f.targetNodeId)
    return { kind: 'notPermitted', reason: 'self-send' }
  // ── THE TWO LIMITS, ONE DECISION (T228) ────────────────────────────────────────────────────────
  //
  // The pair window is the sender's own pacing and the target's cooldown is the provider refusing
  // to run ITS turn. Both mean "do not open a turn now", so they answer with the same kind and the
  // callers' existing retry rules keep working. The LATER deadline wins: reporting the shorter one
  // would invite a retry straight into the other limit. `rateLimitedUntil` is set only for the
  // target's cooldown, and that field is what tells the shell to hold the message in the queue.
  //
  // Cheap by construction: both facts are already in hand (`reserveFlow` and a mirror lookup), so
  // this stays ahead of every pane round-trip and no bytes can reach a doomed turn.
  const pairMs = typeof f.retryAfterMs === 'number' && f.retryAfterMs > 0 ? f.retryAfterMs : 0
  const coolMs = f.cooldown && f.cooldown.retryAfterMs > 0 ? f.cooldown.retryAfterMs : 0
  if (pairMs > 0 || coolMs > 0)
    return {
      kind: 'rateLimited',
      retryAfterMs: Math.max(pairMs, coolMs),
      ...(coolMs > 0 && f.cooldown ? { rateLimitedUntil: f.cooldown.until } : {})
    }
  if (!f.targetLive) return { kind: 'targetGone' }
  // Identity and idleness are BOTH free — a map lookup and a local stat — so they belong here,
  // ahead of anything that touches a pane. See FIRST_PAID_DECISION.
  const identity = identityRefusal(f)
  if (identity) return identity
  return idleRefusal(f.target, f.mayWakeTarget === true)
}

/**
 * Decide whether a delivery may proceed. Pure.
 *
 * The sequence below IS `DECISION_ORDER`, and the ordering test walks it by clearing one fact at a
 * time — asserted by RUNNING this function, never by reading its source.
 */
export function decideDelivery(f: DeliveryFacts): AgentMessageOutcome | Proceed {
  const cheap = decidePreProbe(f)
  if (cheap) return cheap
  // Gate 1, in two honest halves — and BOTH refuse, because the one thing neither may do is admit
  // a pane we could not read. This gate must stay FAIL-CLOSED: `sendEnvelope` types bytes plus an
  // Enter into whatever owns the pane, and an unverified pane can be a bare shell — delivering
  // there EXECUTES the message body ("text into a pane is injection"; the herdr-shaped incidents
  // this module's history records). A probe outage may therefore delay a delivery, never widen it.
  //
  // `unknown` is NOT a shade of `not-agent`, and since issue #460 it is not REPORTED as one
  // either: the field failure was a live, idle claude pane refused as "not running its agent
  // (observed: unknown)" for as long as the host link stayed saturated — a probe that could not
  // answer in its 2s budget (each ssh exec silently becomes a full LOGIN when the master cannot
  // serve a channel; measured in `remotePaneOwnerCombinedArgs`). Telling a language model the
  // pane is "not an agent" when the truth is "we could not look" teaches it a wrong, sticky fact.
  // `targetPaneUnreadable` says the true thing, and it IS retryable — the per-pair rate limiter
  // sits in front of every delivery, so a retry is bounded, and the probe itself is now ONE
  // round-trip, so a retry in the degraded state costs one fallback login, not two. That bound is
  // what the old DO-NOT-RETRY note (a 2s loop stacking ~7 ssh children per pane — the 72k-logins
  // shape, memory: ssh-controlmaster-fallback) was protecting; the limiter + the halved probe are
  // what make honesty affordable now.
  if (f.pane === 'unknown') return { kind: 'targetPaneUnreadable' }
  if (f.pane !== 'agent')
    return { kind: 'targetNotAgentPane', observed: f.paneObserved ?? 'not-agent' }
  // Last, and only when everything else passed: the pane must have ASKED for bracketed paste.
  // herdr :260 — a multi-line envelope on the unframed fallback would be submitted line-by-line as
  // separate turns. It is refused, never sent and hoped for.
  if (f.pasteAware === false) return { kind: 'targetNotPasteAware' }
  return { kind: 'proceed' }
}
