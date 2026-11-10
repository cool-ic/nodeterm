// Official mobile push is removed; local inbox notifications use their own pipeline.
import type { InboxEvent, NodeStateChange, NodeNowChange } from './agent-status-mirror'
import type { PushGrant } from './push-grants'
import type { PopProver } from './relay/relay-pop'
export interface PushHostIdentity {
  hostDeviceId: string
  hostPublicKeyB64: string
  hostLabel: string
  hasPairedPhone: boolean
  /** Proves possession of the host key for a PoP-enabled backend (relay-pop.ts). The secret stays in
   *  the prover's closure; absent ⇒ host-mode push stays legacy. */
  prove?: PopProver
}
export interface PushNotifyEvent {
  kind: 'approval' | 'question' | 'done'
  /** The mirror inbox event id (`InboxEvent.id`, `${ts}-${seq}`), so a phone can claim the exact
   *  Inbox card. The backend forwards it to FCM only; the APNs payload never carries it. */
  eventId?: string
  title: string
  detail?: string
  nodeId: string
  agentId?: string
  /** The node's human display title (canvas header / sessions sidebar name), clipped to 80 chars.
   *  Optional: the backend renders the alert title as "<Needs you|Completed> — <nodeTitle>" when
   *  present, and falls back to a generic title when absent. */
  nodeTitle?: string
  /** question only: the AskUserQuestion choices (≤4 labels, each ≤60 chars). The backend renders
   *  them as numbered notification actions + appends them to the body (spec:
   *  interactive-push-live-activities). Absent for approvals + plain questions. */
  options?: string[]
  /** question only: the AskUserQuestion `multiSelect` flag — the picker accepts multiple choices.
   *  Rides the `nt` block so the phone renders multi-select. Omitted when absent/false. */
  multiSelect?: boolean
  /** Unix **MILLISECONDS** — see `TS_UNIT` below. Forwarded verbatim from `InboxEvent.ts`
   *  (`Date.now()` in agent-status-mirror); never divided, never re-stamped here. */
  ts: number
}
export interface HostAuthCache {
  /** The session token to attach, undefined for legacy (no prover, or an old backend), or 'drop'
   *  when a failure means this batch must not go out unproven. Never '' — the backend reads an
   *  empty `hostAuth` as present-but-invalid. Never rejects: a proof that throws is a failure like
   *  any other ('drop', and the backoff). */
  get(identity: PushHostIdentity): Promise<string | undefined | 'drop'>
  /** Whether `get` would answer from the cache right now, without asking the backend. */
  onFile(identity: PushHostIdentity): boolean
  /** Forget the session (or the old-backend verdict): the next batch proves again. */
  invalidate(): void
}
export interface PushNotifyDeps {
  /** Subscribe to actionable inbox events. In production this is `onInboxActionable`. */
  subscribe: (cb: (e: InboxEvent) => void) => () => void
  /** The standing relay host identity, or null when none is configured/available. */
  getHostIdentity: () => PushHostIdentity | null
  /** Granted mode (SSH-possession push grants; spec: 2026-07-21-push-grants). The batch is POSTed
   *  once PER grant with `Authorization: Bearer <grant>` (no host identity fields) — the Server
   *  Edition's only path, and the desktop's route to any phone that reaches it over plain SSH.
   *  Sent ALONGSIDE host mode when both are live, never instead of it: see `resolveSendTarget` for
   *  why the exclusion cannot be done per device here, and what that costs. */
  getGrants?: () => PushGrant[]
  /** Mark a grant dead after a 401/403 (dropped until its file changes). Paired with `getGrants`. */
  markGrantDead?: (grant: string) => void
  /** The SSH host (`sshHostKey`, `user@host`) a node's project lives on, or undefined for a node on
   *  THIS machine. Drives the granted leg's per-host routing: an event goes only under the grants
   *  swept from its node's host (`PushGrant.host`), never under another host's — each grant is
   *  signed for one host's connectionId, the scope the phone's per-host mute is keyed by (issue
   *  #435). Absent (the Server Edition) ⇒ every node is local and every grant is local: the legacy
   *  fan-out. In production this is `workspaceStore.sshProjectIdForNode` → the project's host key. */
  grantHostFor?: (nodeId: string) => string | undefined
  /** `os.hostname()`, passed in to keep core pure — the granted-mode `hostLabel` (a granted send
   *  carries no host identity, so this is the only host label the backend sees). */
  hostLabel?: () => string
  /** The `settings.mobilePushEnabled` gate (default on) — the master switch. */
  mobilePushEnabled: () => boolean
  /** The `settings.mobilePushNeedsYou` sub-gate (default on): approval + question kinds. */
  mobilePushNeedsYou: () => boolean
  /** The `settings.mobilePushDone` sub-gate (default on): the done kind. */
  mobilePushDone: () => boolean
  /** `app.isPackaged` — dev never hits the prod API unless a local base is targeted. */
  isPackaged: () => boolean
  /** Resolve a node's human display title (canvas/sidebar name) for the push `nodeTitle`. In
   *  production this is `workspaceStore.getNodeTitle`. Optional / may return undefined — the field
   *  is then simply omitted from the payload. */
  getNodeTitle?: (nodeId: string) => string | undefined
  /** Presence-aware alert deferral (owner UX call): pushing an ALERT to the phone while the user is
   *  actively at the desktop is noise; when they go idle/lock it's exactly right. When this returns
   *  true at send time, the batched event goes to an in-memory HOLD queue instead of POSTing. Absent
   *  (or always-false, the Server Edition's headless case) ⇒ every event sends immediately, i.e.
   *  exact legacy behavior. Alerts only — the live-update stream (createLiveUpdatePush) is ambient
   *  and never deferred. */
  isUserPresent?: () => boolean
  /** Poke on the present→away transition to flush the hold queue. In production the desktop shell
   *  detects the edge (powerMonitor idle poll + lock-screen) and fires `cb`. Returns an unsubscribe.
   *  Paired with `isUserPresent`; absent ⇒ nothing is ever held so nothing needs flushing. */
  subscribePresence?: (cb: () => void) => () => void
  /** On the away-flush, drop a held event that got resolved in the mirror while it waited (an
   *  approval/question the node has since left, or a `done` the desktop user already read). In
   *  production this is `agent-status-mirror.isEventUnresolved`. Absent ⇒ all held events flush
   *  unfiltered. */
  isEventUnresolved?: (nodeId: string, eventId: string) => boolean
  /** Override base URL. Unused compatibility field in the local build. */
  apiBase?: string
  /** Injectable env (DNT guards + local-dev base). Defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** Injectable fetch (tests mock it). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number
  batchWindowMs?: number
  throttleMs?: number
}
export interface PushNotifyHandle {
  /** Unsubscribe + cancel any pending flush. */
  stop(): void
  /** Test-only: force any buffered events to POST now. */
  _flushNow(): Promise<void>
}
export interface LiveUpdateItem {
  nodeId: string
  nodeTitle?: string
  agentId?: string
  event: 'start' | 'update' | 'end'
  state: 'working' | 'needsYou' | 'done'
  activity?: string
  contextPercent?: number
  message?: string
  /** working START edge only: the first line of the user prompt that opened the turn — rendered as
   *  `You: …`, the same line the notch capsule shows. Omitted on every other event. */
  prompt?: string
  /** needsYou only (spec: interactive-push-live-activities addendum): 'approval' | 'question'.
   *  Omitted otherwise — the backend also forces null on non-needsYou content-state. */
  kind?: 'approval' | 'question'
  /** question needsYou only: the AskUserQuestion choices (≤4 × ≤60), for Live Activity buttons. */
  options?: string[]
  /** question needsYou only: the AskUserQuestion `multiSelect` flag. Omitted when absent/false. */
  multiSelect?: boolean
  /** approval needsYou only: the deterministic hook-reply ticket, letting an intent answer. */
  pendingId?: string
  /** done only: the turn ended because the user INTERRUPTED it (Esc/Ctrl-C), not because it
   *  finished. Omitted when false/absent, and never sent off a done edge — the backend also forces
   *  it null on non-done content-state. Without it the phone had only the `message` STRING
   *  ('Stopped' vs 'Finished') to tell the two apart, so a wording change silently altered
   *  behaviour. A consumer that CELEBRATES a completion must skip this (same rule as the notch
   *  HUD's `doneSeen`) — nothing was accomplished, so there is nothing to go and read. */
  interrupted?: boolean
  /** done only: this end came from the stale-working SWEEP (nobody heard from the session for
   *  WORKING_STALE_MS, so it is presumed gone), NOT from the session itself. Same omission rules and
   *  the same "never celebrate it" contract as `interrupted` — but a DIFFERENT fact: `interrupted`
   *  is "you stopped it", `stale` is "we lost the host". The mirror sends message:'Stopped' for
   *  both, which is exactly why the phone cannot infer this from the text. */
  stale?: boolean
  /** true on a state EDGE (start / needsYou / end, and the working update that follows an answered
   *  needs-you) — a user-visible state change. Absent on the ≥20s activity/context coalesced ticks.
   *  The backend uses it for APNs priority: an edge is priority 10, a tick priority 5 (iOS delays
   *  priority-5 liveactivity pushes, which was leaving the island up minutes after an answer). */
  edge?: boolean
  /** Unix **MILLISECONDS** (`TS_UNIT`) — the mirror's `Date.now()`, forwarded verbatim. This is the
   *  field the iOS Live Activity reads as `ContentState.ts`; it is ms on both producers (the push
   *  below and the phone's own foreground poll), so it is compared, never mixed with seconds. */
  ts: number
}
export interface LiveUpdateDeps {
  /** Subscribe to main-state edges. In production this is `onNodeStateChange`. */
  subscribeStateChange: (cb: (c: NodeStateChange) => void) => () => void
  /** Subscribe to per-node activity/context changes. In production this is `onNodeNowChange`. */
  subscribeNowChange: (cb: (c: NodeNowChange) => void) => () => void
  /** The standing relay host identity, or null when none is configured/available. */
  getHostIdentity: () => PushHostIdentity | null
  /** Granted mode (SSH-possession push grants; spec: 2026-07-21-push-grants). See the identical
   *  field on `PushNotifyDeps`: one POST per grant, Bearer-authorized, no host fields, sent
   *  ALONGSIDE host mode when both are live (`resolveSendTarget`). */
  getGrants?: () => PushGrant[]
  /** Mark a grant dead after a 401/403 (dropped until its file changes). Paired with `getGrants`. */
  markGrantDead?: (grant: string) => void
  /** See the identical field on `PushNotifyDeps`: the node → SSH host resolver behind the granted
   *  leg's per-host routing. Absent ⇒ every node and every grant is local. */
  grantHostFor?: (nodeId: string) => string | undefined
  /** `os.hostname()`, passed in to keep core pure — the granted-mode `hostLabel`. */
  hostLabel?: () => string
  /** The `settings.mobilePushEnabled` master switch. */
  mobilePushEnabled: () => boolean
  /** The `settings.mobileLiveActivities` sub-gate (default on). */
  mobileLiveActivities: () => boolean
  /** `app.isPackaged` — dev never hits the prod API unless a local base is targeted. */
  isPackaged: () => boolean
  /** Resolve a node's human display title. In production this is `workspaceStore.getNodeTitle`. */
  getNodeTitle?: (nodeId: string) => string | undefined
  apiBase?: string
  env?: Record<string, string | undefined>
  fetchImpl?: typeof fetch
  now?: () => number
  batchWindowMs?: number
  coalesceMs?: number
}
export interface LiveUpdateHandle {
  stop(): void
  _flushNow(): Promise<void>
}
export const TS_UNIT = 'unix-ms' as const
export function createPushNotify(_deps: PushNotifyDeps): PushNotifyHandle { return { stop() {}, async _flushNow() {} } }
export function createLiveUpdatePush(_deps: LiveUpdateDeps): LiveUpdateHandle { return { stop() {}, async _flushNow() {} } }
export function createHostAuthCache(_deps: unknown): HostAuthCache { return { async get() { return 'drop' }, onFile() { return false }, invalidate() {} } }
