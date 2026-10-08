/**
 * The agent-messaging verbs' wire shapes — shared because three projects touch them: the renderer
 * dispatch (Canvas.tsx forwards a control verb to main), the preload bridge, and the main-side
 * delivery service. Everything with behaviour stays in `src/core/agents/agent-message*`; this file
 * is deliberately types + one constant.
 */

export type AgentMessageVerb = 'send' | 'reply' | 'notify'

export const AGENT_MESSAGE_VERBS: ReadonlySet<string> = new Set([
  'send',
  'reply',
  'notify'
] satisfies AgentMessageVerb[])

/** What the renderer forwards to main for one delivery. Deliberately minimal: the source TITLE,
 *  the target's agent id, remoteness, the scope verdict and the switch state are all resolved in
 *  MAIN from its own stores, so nothing that ends up inside the envelope or inside an
 *  authorization decision is renderer-supplied beyond the two node ids and the body. */
export interface AgentMessageDeliverRequest {
  verb: AgentMessageVerb
  sourceNodeId: string
  targetNodeId: string
  /** The sender's text for send/reply. IGNORED for notify — its body is app-owned and composed
   *  in main (`NOTIFY_BODY`), which is the whole point of that verb. */
  body: string
}

/**
 * The app's OWN delivery verb: a station-failure notice (`src/core/agents/station-notice.ts`). It is
 * deliberately NOT in `AGENT_MESSAGE_VERBS` — that set is what the IPC guard and the control shim
 * accept, and a notice must never be something a renderer or an agent can ask for with a body of
 * its choosing. Core composes the body (`stationNoticeBody`, @shared/station-notice) and hands it
 * to the same gate chain every message runs through.
 */
export const STATION_NOTICE_VERB = 'station-notice' as const

/** Every verb the delivery service runs — the control verbs plus the app's own notice. */
export type DeliveryVerb = AgentMessageVerb | typeof STATION_NOTICE_VERB

/**
 * What a host can say about a target's session right now (T207b). Shared because two projects name
 * it: the main-side delivery/queue code that asks, and `TrustRow` (an IPC shape the renderer reads).
 *
 *   - `live`    — a positive answer: a recorded session, or a backend that found it.
 *   - `gone`    — the host ASKED, and the answer was that nothing is there. Only this licenses the
 *                 word "gone" on any sender-facing surface.
 *   - `unknown` — could not ask, or could not understand the answer (no tmux to ask by name, a
 *                 spawn failure, a timeout, no probe wired at all).
 *
 * Three states, not a boolean: the boolean version folded `unknown` into `gone`, which made a dead
 * letter announce the death of a pane whose tmux session was alive and would have printed 会话已亡
 * in the trust column for it.
 */
export type SessionLiveness = 'live' | 'gone' | 'unknown'

/**
 * T228 — a station's standing RATE-LIMIT READING, taken off its own pane when its last turn died
 * with the provider's own words (`TooManyRequests` / `Requests are too frequent` / `429` …).
 *
 * Shared because three layers name it: the main-side status mirror (the authority), the IPC push
 * that carries it to every renderer, and the delivery gate that reads it as a cooldown. The shape
 * is the delivery layer's existing vocabulary (`{ kind: 'rateLimited', … }`), so a caller that
 * already knows a rate limit needs no second concept.
 *
 * `signature` and `detail` are the APP's words for the cause (an id and a sentence from
 * `core/agents/rate-limit-text.ts`), never the pane's text — station output is never quoted on any
 * surface. `at + retryAfterMs` is the cooldown; `defaulted` says the provider named no retry time
 * and a conservative default was used.
 *
 * A READING, not an authorization and not a schedule: no gate may branch on it beyond declining to
 * open a turn the provider would refuse anyway, and nothing counts it down — surfaces compute
 * `remaining = at + retryAfterMs - now` wherever they need it.
 */
export interface RateLimitReading {
  kind: 'rateLimited'
  /** Which row of the classifier's table matched — an id, for logs and tests. */
  signature: string
  /** The cause in one app-authored sentence. Never the pane's text. */
  detail: string
  retryAfterMs: number
  /** The provider named no retry time; `retryAfterMs` is the conservative default. */
  defaulted: boolean
  /** When the reading was taken; the cooldown runs from here. */
  at: number
}

/** A delivery as the SERVICE sees it: the IPC request, or an app-composed notice. */
export interface AgentMessageDeliveryInput extends Omit<AgentMessageDeliverRequest, 'verb'> {
  verb: DeliveryVerb
}

/** The `from:` line of a notice's envelope. The station is named in the body; the frame says who
 *  wrote it, which is the app, never the station. */
export const STATION_NOTICE_FROM = 'nodeterm station notice'

/**
 * `notify`'s entire body — fixed, app-owned, and substituted in MAIN whatever the request
 * carries. Folded in from PR #98, whose design line survives verbatim: "The app owns the entire
 * prompt so the source cannot inject instructions through command arguments." #98's "check your
 * configured inbox" wording is dropped — the product has no inbox concept; the linked context is
 * the thing a notified agent can actually read.
 */
export const NOTIFY_BODY =
  'A linked agent updated shared coordination context. Read the latest linked context ' +
  '(get-linked-context) before continuing.'

/** The rendered control reply for one delivery — the exact shape every other control verb answers
 *  with, so the hook server and the shim need no messaging-specific branch. */
export interface AgentMessageReply {
  ok: boolean
  message?: string
  error?: string
  /** The typed outcome (an `AgentMessageOutcome` from `src/core`), for JSON clients. */
  result?: unknown
}
