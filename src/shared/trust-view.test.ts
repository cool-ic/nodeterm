import { describe, expect, it } from 'vitest'
import { targetsProven, trustReason, trustReasonText } from './trust-view'

describe('trustReason (T201 read-only view)', () => {
  const base = { liveness: 'live', proven: false, wired: true, rowOwner: undefined, entryId: 'E1' } as const

  it('names each state, in the order the view reads them', () => {
    expect(trustReason({ ...base, proven: true })).toBe('proven')
    expect(trustReason({ ...base, liveness: 'gone', proven: true })).toBe('session-gone')
    expect(trustReason(base)).toBe('no-durable-row')
    expect(trustReason({ ...base, rowOwner: 'E2' })).toBe('entry-id-mismatch')
    expect(trustReason({ ...base, rowOwner: 'E1' })).toBe('reproof-pending')
    expect(trustReason({ ...base, wired: false })).toBe('ownership-unwired')
  })

  it('a dead session outranks every other reason — nothing can be delivered there', () => {
    expect(trustReason({ ...base, liveness: 'gone', wired: false })).toBe('session-gone')
    expect(trustReason({ ...base, liveness: 'gone', rowOwner: 'E2' })).toBe('session-gone')
  })

  it('T207b: an UNCONFIRMED session is not a dead one — the column must not claim 会话已亡', () => {
    // The field case: a hand-resumed pane, alive in tmux, unknown to this process. Reporting it as
    // `session-gone` printed 未证明（会话已亡） for a pane that was running.
    expect(trustReason({ ...base, liveness: 'unknown', proven: true })).toBe('session-unconfirmed')
    expect(trustReason({ ...base, liveness: 'unknown' })).toBe('session-unconfirmed')
    expect(trustReasonText('session-unconfirmed')).toContain('无法确认')
    expect(trustReasonText('session-unconfirmed')).not.toContain('已亡')
  })
})

describe('targetsProven (T204 gate-aligned auto-approval)', () => {
  const rows = [
    { nodeId: 'a', proven: true },
    { nodeId: 'b', proven: false },
    { nodeId: 'c', proven: true }
  ]

  it('all targets proven ⇒ auto-approve', () => {
    expect(targetsProven(rows, ['a', 'c'])).toBe(true)
  })

  it('ONE unproven target refuses the whole set — no partial auto-approval', () => {
    expect(targetsProven(rows, ['a', 'b'])).toBe(false)
  })

  it('a target absent from the snapshot (another project’s pane) is not proven', () => {
    expect(targetsProven(rows, ['a', 'zz'])).toBe(false)
  })

  it('an empty target list never auto-approves', () => {
    expect(targetsProven(rows, [])).toBe(false)
  })
})
