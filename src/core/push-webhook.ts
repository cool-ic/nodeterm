// Desktop client for the push webhook's management routes (mint / status / revoke).
//
// The backend accepts these only from the holder of this machine's relay host SECRET key, proved
// per request without the key leaving this process: the server answers a challenge with an
// ephemeral X25519 public key, and we return HMAC-SHA256(X25519(hostSecret, ephemeral), context),
// where context binds the challenge, the action and our device id. The public identity
// (hostDeviceId + host public key) is known to every paired phone, so it is deliberately NOT
// enough on its own to mint, read or revoke a durable credential.
//
// The context string is the wire contract with nodeterm-server's `src/lib/host-proof.ts`
// (`proofContext`). Change one, change both.
//
// Electron-free (core): the desktop wires it with the relay host key. The Server Edition has no
// relay host identity and no paired-phone registry, so it does not construct this (its bridge
// answers E_UNSUPPORTED and the Settings row is hidden) — the same degrade as `push-notify.ts`.

import { createHmac } from 'node:crypto'
import nacl from 'tweetnacl'
import {
  PUSH_WEBHOOK_DEFAULT_API_BASE,
  type PushWebhookApi,
  type PushWebhookError,
  type PushWebhookMinted,
  type PushWebhookResult,
  type PushWebhookTokenInfo
} from '../shared/push-webhook'

const FETCH_TIMEOUT_MS = 10_000
const PROOF_DOMAIN = 'nodeterm-push-webhook-proof-v1'

export type PushWebhookAction = 'mint' | 'status' | 'revoke'

export interface PushWebhookHost {
  hostDeviceId: string
  publicKey: Uint8Array
  secretKey: Uint8Array
  /** Shown on the phone as "Webhook · <label>". */
  label: string
}

export interface PushWebhookClientDeps {
  fetch?: typeof fetch
  apiBase?: string
  /** Throws when the key cannot be read (keyring locked). */
  loadHost: () => Promise<PushWebhookHost>
  /** Is a phone paired with this machine at all? Asked BEFORE anything else: with no phone there
   *  is nobody to push to, and neither the host key (whose first read CREATES it) nor the backend
   *  (which would receive our device id and public key) is touched just because a page was viewed. */
  hasPairedPhone: () => Promise<boolean>
  /** false ⇒ the call is refused as 'dev-build' unless an api base override is configured. */
  isPackaged: () => boolean
  env?: Record<string, string | undefined>
}

export function webhookProofContext(challenge: string, action: PushWebhookAction, hostDeviceId: string): string {
  return `${PROOF_DOMAIN}\n${challenge}\n${action}\n${hostDeviceId}`
}

/** HMAC over the X25519 shared secret. `scalarMult` is raw X25519 — the same function the server
 *  runs with Node's `diffieHellman`. */
export function webhookProof(input: {
  secretKey: Uint8Array
  serverPublicKeyB64: string
  challenge: string
  action: PushWebhookAction
  hostDeviceId: string
}): string {
  const serverPub = Uint8Array.from(Buffer.from(input.serverPublicKeyB64, 'base64'))
  if (serverPub.length !== 32) throw new Error('bad server key')
  const shared = nacl.scalarMult(input.secretKey, serverPub)
  return createHmac('sha256', Buffer.from(shared))
    .update(webhookProofContext(input.challenge, input.action, input.hostDeviceId))
    .digest('base64')
}

function isTokenInfo(v: unknown): v is PushWebhookTokenInfo {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    typeof o.tokenId === 'string' &&
    typeof o.tokenPrefix === 'string' &&
    typeof o.createdAt === 'string' &&
    (o.lastUsedAt === null || typeof o.lastUsedAt === 'string')
  )
}

function errorFor(status: number, body: unknown): PushWebhookError {
  const code = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined
  if (status === 409 && code === 'no_paired_phone') return 'no-paired-phone'
  if (status === 400) return 'bad-request'
  if (status === 403) return 'refused'
  if (status === 429) return 'rate-limited'
  return 'unreachable'
}

export function createPushWebhookClient(deps: PushWebhookClientDeps): PushWebhookApi { return { async status() { return { ok: false, error: 'refused' } }, async mint() { return { ok: false, error: 'refused' } }, async revoke() { return { ok: false, error: 'refused' } } } }
