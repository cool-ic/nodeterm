import { describe, expect, it } from 'vitest'
import { qoderComposerSettled, qoderEmptyComposer } from './qoder-startup-ready'

export const QODER_EMPTY = 'Previous response\n────────────────────\n >   Type your message or @path/to/file\n────────────────────\n Performance Model · ctx ▓░░░░░░░░░ 18% · ~/project\n'

describe('Qoder startup composer evidence', () => {
  it('recognizes the measured empty composer, including CRLF', () => {
    expect(qoderEmptyComposer(QODER_EMPTY)).toBe(true)
    expect(qoderEmptyComposer(QODER_EMPTY.replace(/\n/g, '\r\n'))).toBe(true)
  })
  it.each([null, '', '$ ', 'Permission Required\nAllow this command to run?\n1. Allow once',
    QODER_EMPTY.replace('Type your message or @path/to/file', 'unfinished user draft'),
    QODER_EMPTY + 'Select an option'])('rejects nonempty/unknown/modal surfaces: %s', (screen) => {
    expect(qoderEmptyComposer(screen)).toBe(false)
  })
  it('requires stable frames and cancels if a state hook arrives during capture', async () => {
    let count = 0
    expect(await qoderComposerSettled(async () => { count++; return QODER_EMPTY }, async () => {}, () => true)).toBe(true)
    expect(count).toBe(3)
    let starting = true
    expect(await qoderComposerSettled(async () => { starting = false; return QODER_EMPTY }, async () => {}, () => starting)).toBe(false)
  })
  it('bounds unstable rendering instead of accepting an early frame', async () => {
    let count = 0
    expect(await qoderComposerSettled(async () => `${count++}\n${QODER_EMPTY}`, async () => {}, () => true)).toBe(false)
    expect(count).toBe(20)
  })
})
