/**
 * T228 — WHERE THE READING IS TAKEN. One function, both shells.
 *
 * The provider's rate-limit words live in exactly one place at turn end: the PANE. The hook payload
 * that tells us a turn errored (`errored`) carries no cause and no wait — so a shell that wants the
 * `retryAfter` has to look at the screen, which only the shell can do (`captureSession` is a pty
 * capability). This module is that step, kept out of either shell so the desktop and the Server
 * Edition cannot drift into two different readings of the same event, and out of
 * `rate-limit-text.ts` so the PARSER stays a pure function of a string.
 *
 * It deliberately answers THREE ways, not two:
 *
 *  - `read` + a verdict — the pane named a limit, with whatever wait the provider wrote down.
 *  - `read` + `null` — the pane was read and named no limit. A real, useful answer: an errored turn
 *    that is NOT a rate limit must RETIRE a standing reading, or a node limited an hour ago would
 *    keep claiming to be limited and keep holding its senders' mail.
 *  - `no-evidence` — nothing to read (no tmux, a session that is already gone, a backend that cannot
 *    capture: `captureSession` answers '' for every one of those). NOT a statement about the turn,
 *    so the caller leaves the standing reading exactly as it was rather than inventing an answer.
 *
 * Pure but for the two injected effects (the capture and the clock), so a test drives all three
 * branches without a pty.
 */
import { parseRateLimit } from './rate-limit-text'
import type { RateLimitReading } from '../../shared/agents/agent-messaging'

export type RateLimitScan =
  | { kind: 'read'; verdict: RateLimitReading | null }
  | { kind: 'no-evidence' }

/** Scan one node's pane for the provider's rate-limit words. See the module docblock for why an
 *  empty capture is `no-evidence` rather than "read, no limit". */
export async function scanPaneForRateLimit(
  nodeId: string,
  capture: (nodeId: string) => Promise<string>,
  now: () => number
): Promise<RateLimitScan> {
  let text: string
  try {
    text = await capture(nodeId)
  } catch {
    return { kind: 'no-evidence' }
  }
  if (typeof text !== 'string' || text.trim() === '') return { kind: 'no-evidence' }
  const verdict = parseRateLimit(text)
  return { kind: 'read', verdict: verdict ? { ...verdict, at: now() } : null }
}
