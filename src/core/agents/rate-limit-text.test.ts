import { describe, it, expect } from 'vitest'
import {
  parseRateLimit,
  parseRetryAfterMs,
  RATE_LIMIT_DEFAULT_RETRY_MS,
  RATE_LIMIT_MAX_RETRY_MS,
  RATE_LIMIT_SIGNATURES
} from './rate-limit-text'

// T228: the provider's rate-limit text is the only place the WAIT is written down, and the hook
// payloads never carry it. These fixtures are the shapes the field actually produced (the two
// deaths that prompted the ticket) plus the waits providers print when they do print one.

describe('parseRateLimit', () => {
  it('classifies the field text and takes the wait from the text', () => {
    const v = parseRateLimit('TooManyRequests: Requests are too frequent. Retry-After: 120')
    expect(v).toMatchObject({
      kind: 'rateLimited',
      signature: 'too-many-requests',
      retryAfterMs: 120_000,
      defaulted: false
    })
    // The label is OURS — the pane's text never travels into a notice.
    expect(v!.detail).not.toContain('Requests are too frequent')
    expect(v!.detail).toMatch(/TooManyRequests/)
  })

  it('falls back to the conservative default and SAYS it is a default', () => {
    const v = parseRateLimit('TooManyRequests: Requests are too frequent')
    expect(v).toMatchObject({
      signature: 'too-many-requests',
      retryAfterMs: RATE_LIMIT_DEFAULT_RETRY_MS,
      defaulted: true
    })
  })

  it('reads the units providers actually print', () => {
    expect(parseRetryAfterMs('retry-after: 30')).toBe(30_000)
    expect(parseRetryAfterMs('Retry-After: 1500ms')).toBe(1500)
    expect(parseRetryAfterMs('try again in 2 minutes')).toBe(120_000)
    expect(parseRetryAfterMs('please wait 45 seconds then retry')).toBe(45_000)
    expect(parseRetryAfterMs('you can retry in 10s')).toBe(10_000)
    // No hint at all is undefined, never a made-up number.
    expect(parseRetryAfterMs('Requests are too frequent')).toBeUndefined()
  })

  it('clamps a wild wait — a pane cannot park mail for a day', () => {
    expect(parseRateLimit('TooManyRequests. retry-after: 99999')!.retryAfterMs).toBe(
      RATE_LIMIT_MAX_RETRY_MS
    )
  })

  it('does NOT swallow an ordinary model error — the nail that keeps this table honest', () => {
    for (const text of [
      'API Error: 500 internal server error',
      'TypeError: x is not a function\n    at foo (bar.js:429:12)',
      'tool failed: exit 1',
      'StopFailure',
      ''
    ]) {
      expect(parseRateLimit(text), text).toBeNull()
    }
    // …and the loose 429 row is real: the same number inside an errored turn's tail IS the status.
    expect(parseRateLimit('Error: 429')).toMatchObject({ signature: 'http-429' })
  })

  it('knows the other providers’ shapes, each with its own id', () => {
    expect(parseRateLimit('RESOURCE_EXHAUSTED: quota')!.signature).toBe('resource-exhausted')
    expect(parseRateLimit('{"error":{"type":"insufficient_quota"}}')!.signature).toBe('quota-exceeded')
    expect(parseRateLimit('Overloaded')!.signature).toBe('overloaded')
    expect(parseRateLimit('rate-limited, retry later')!.signature).toBe('rate-limit-words')
    expect(parseRateLimit('Claude usage limit reached')!.signature).toBe('usage-limit')
  })

  it('every row is a distinct id with a distinct pattern', () => {
    const ids = RATE_LIMIT_SIGNATURES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const row of RATE_LIMIT_SIGNATURES) expect(row.label.length).toBeGreaterThan(0)
  })
})
