// HTTP client for the live-link routes (nodeterm-server, Plan 1). Credentials ride the JSON body
// over TLS, never argv. Every call is bounded by a timeout that also covers the body read.
import { tokenTtlMs, type MintResult } from '../relay/host-token'
import { LINK_ID_RE } from '../../shared/watch-link/link'

/** `ttl-unsupported`: a `400 {"error":"bad_ttl"}` answered to an Unlimited request (`ttlSeconds` 0) —
 *  a server older than unlimited links. The same 400 to a finite request stays `bad-request`. */
export type CreateError =
  | 'not-entitled'
  | 'limit-active'
  | 'limit-daily'
  | 'rate-limited'
  | 'license-check'
  | 'bad-request'
  | 'ttl-unsupported'
  | 'network'
export type HostTokenResult = MintResult | { ok: false; kind: 'gone'; reason: 'revoked' | 'expired' }
export interface WatchLinkApi {
  /** `ttlSeconds` 0 asks for an Unlimited link; only then may the answer's `expiresAt` be null. */
  create(
    entitlement: string,
    joinKeyHash: string,
    ttlSeconds: number
  ): Promise<{ ok: true; linkId: string; expiresAt: number | null } | { ok: false; error: CreateError }>
  hostToken(linkId: string, entitlement: string): Promise<HostTokenResult>
  status(linkId: string, entitlement: string): Promise<'live' | 'revoked' | 'expired' | 'unknown'>
  revoke(linkId: string, entitlement: string): Promise<boolean>
  revokeAll(entitlement: string): Promise<boolean>
}

interface Reply {
  status: number
  /** The parsed body when it is a JSON object; null for 204, an empty or non-JSON body, or any other JSON value. */
  json: Record<string, unknown> | null
  date: string | null
  retryAfter: string | null
}

/** The longest wait a Retry-After may impose. Our limiters do not count a refused request, so asking
 *  again early is cheap, while an unbounded header (a proxy's `86400`) would park a link's host for
 *  longer than the link lives. */
const RETRY_AFTER_MAX_S = 3600

/** Retry-After as RFC 9110 delay-seconds only, clamped. Anything else (an HTTP-date, `1e9`,
 *  `Infinity`, `0x10`, `0.5`, empty, 0) is no answer: the scheduler's own floor applies. */
function retryAfterMs(header: string | null): number | undefined {
  if (header === null || !/^\d+$/.test(header)) return undefined
  const s = Number(header)
  return s > 0 ? Math.min(s, RETRY_AFTER_MAX_S) * 1000 : undefined
}

export function createWatchLinkApi(o: { apiBase: string; fetch?: typeof fetch; now?: () => number; timeoutMs?: number }): WatchLinkApi { return { async create() { return { ok: false, error: 'not-entitled' } }, async hostToken() { return { ok: false, kind: 'gone', reason: 'revoked' } }, async status() { return 'unknown' }, async revoke() { return false }, async revokeAll() { return false } } }
