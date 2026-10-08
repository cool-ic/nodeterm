/**
 * RATE-LIMIT TEXT — reading "the provider said 429" out of a pane, as data.
 *
 * The field report behind this (T228): the same station was killed twice in one night by
 * `TooManyRequests: Requests are too frequent`, and BOTH times the orchestrator only found out by
 * `tmux capture-pane` afterwards. Worse, the retry timing was guesswork (120 s once, 180 s the
 * next) — guess early and a whole turn burns for nothing. The hook payloads cannot answer this:
 * they carry `errored` (a fact about the turn) and never the PROVIDER's words, which is exactly the
 * half that says how long to wait.
 *
 * So this module is the classifier for the OTHER half: given the text in a pane, is this a rate
 * limit, and how long did the provider ask us to wait? It is pure — no clock, no pane, no store —
 * so the table below can be extended with a measured example and a test in one commit.
 *
 * ── WHAT IT MAY AND MAY NOT DECIDE ──────────────────────────────────────────────────────────────
 *
 * It is consulted ONLY where a turn has already died (`errored`), which is what keeps the loose
 * shapes (`429`, `overloaded`) honest: inside an errored turn's tail, a bare 429 is the provider's
 * status. It never asserts a rate limit about a healthy turn, and a plain error (a 500, a
 * TypeError, a tool failure) must fall through as `null` — the "normal error" nail.
 *
 * The TEXT is never propagated. What leaves here is an id and a LABEL from OUR table (so a notice
 * can name the reason without quoting a station's output — the rule `shared/station-notice.ts`
 * states), plus the parsed wait.
 */

/** What we say when the provider did not say. Conservative on purpose: too long costs one idle
 *  minute, too short costs a burnable turn (the field's own complaint). */
export const RATE_LIMIT_DEFAULT_RETRY_MS = 60_000

/** The longest wait a pane text can claim. A hand-written or hallucinated `retry after 99999s` must
 *  not park a station's mail for a day; the queue's own TTL bounds the real wait anyway. */
export const RATE_LIMIT_MAX_RETRY_MS = 30 * 60_000

/**
 * THE TABLE — matched in order, first hit wins, ids are stable strings (they ride the durable
 * trace and the `list` column, so renaming one is a wire change).
 *
 * Ordered most-specific first: a pane that says `TooManyRequests: Requests are too frequent` gets
 * the provider's own name, not the generic word row.
 */
export interface RateLimitSignature {
  /** Stable id, from OUR vocabulary — never pane text. */
  id: string
  re: RegExp
  /** The sentence a reader gets. Also ours: nothing here quotes the pane. */
  label: string
}

export const RATE_LIMIT_SIGNATURES: readonly RateLimitSignature[] = [
  {
    id: 'too-many-requests',
    re: /TooManyRequests/i,
    label: 'the provider is rate limiting (TooManyRequests)'
  },
  {
    id: 'requests-too-frequent',
    re: /requests? (?:are|is) too frequent/i,
    label: 'the provider is rate limiting (requests are too frequent)'
  },
  {
    id: 'resource-exhausted',
    re: /\bRESOURCE_EXHAUSTED\b|resource_exhausted/,
    label: 'the provider is rate limiting (RESOURCE_EXHAUSTED)'
  },
  {
    id: 'usage-limit',
    re: /\busage limit\b/i,
    label: 'a usage limit was hit (the plan’s allowance, not this machine)'
  },
  {
    id: 'quota-exceeded',
    re: /\binsufficient_quota\b|\bquota exceeded\b|exceeded your current quota/i,
    label: 'a quota was exceeded (the plan’s allowance, not this machine)'
  },
  {
    id: 'overloaded',
    re: /\boverloaded(?:_error)?\b/i,
    label: 'the provider is overloaded (a capacity limit, same wait-and-retry policy)'
  },
  {
    id: 'rate-limit-words',
    re: /\brate[\s_-]?limit(?:ed|ing)?\b/i,
    label: 'the provider is rate limiting'
  },
  {
    // Last, because it is the loosest. Consulted only on an already-errored turn's tail, where a
    // bare 429 is the provider's status. The lookahead is the one thing that keeps a LINE NUMBER
    // out of the table: `bar.js:429:12` is a stack frame, `error: 429` and `429: Too Many Requests`
    // are the status (a colon followed by digits is what a location looks like, and nothing else).
    id: 'http-429',
    re: /\b429\b(?![.:]\d)/,
    label: 'the provider answered 429 (too many requests)'
  }
]

/**
 * The wait hints, in the order they are trusted. Deliberately few and explicit: a bare number near
 * the words "rate limit" is NOT a retry hint (the field's own text — `TooManyRequests: Requests are
 * too frequent` — carries none, and inventing 30 s out of a stray number would be worse than the
 * default).
 */
const RETRY_HINTS: readonly RegExp[] = [
  /retry[-\s]?after[:\s]+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)?/i,
  /try again in\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)?/i,
  /\bwait\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)/i,
  /\bin\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)\b/i
]

export interface RateLimitVerdict {
  /** Matches the status shape the delivery layer already uses: `{ kind: 'rateLimited', … }`. */
  kind: 'rateLimited'
  /** The signature id from the table above. */
  signature: string
  /** Our words for it (never the pane's). */
  detail: string
  /** How long to wait before trying again. */
  retryAfterMs: number
  /** True when the provider gave no hint and `retryAfterMs` is our conservative default. */
  defaulted: boolean
}

function unitMs(unit: string | undefined): number {
  if (!unit) return 1000 // a bare number is seconds: every provider that prints one means seconds
  const u = unit.toLowerCase()
  if (u.startsWith('ms') || u.startsWith('milli')) return 1
  if (u.startsWith('m')) return 60_000
  return 1000
}

/** The first parseable wait hint, clamped. `undefined` when the text carries none. */
export function parseRetryAfterMs(text: string): number | undefined {
  for (const re of RETRY_HINTS) {
    const m = re.exec(text)
    if (!m) continue
    const n = Number(m[1])
    if (!Number.isFinite(n) || n < 0) continue
    const ms = Math.round(n * unitMs(m[2]))
    return Math.min(ms, RATE_LIMIT_MAX_RETRY_MS)
  }
  return undefined
}

/**
 * Classify a pane text. `null` = "not a rate limit" — the answer for every ordinary error, and the
 * reason this module can be consulted without fear of swallowing a different failure class.
 */
export function parseRateLimit(text: string | null | undefined): RateLimitVerdict | null {
  if (typeof text !== 'string' || !text) return null
  const sig = RATE_LIMIT_SIGNATURES.find((row) => row.re.test(text))
  if (!sig) return null
  const hinted = parseRetryAfterMs(text)
  return {
    kind: 'rateLimited',
    signature: sig.id,
    detail: sig.label,
    retryAfterMs: hinted ?? RATE_LIMIT_DEFAULT_RETRY_MS,
    defaulted: hinted === undefined
  }
}
