import { describe, it, expect, vi } from 'vitest'
import { PtyManager } from './pty-manager'
import { ImRuntime } from '../../scripts/agent-mail/runtime.mjs'
import { ImWakeOutputRetry } from './agent-im-wake-retry'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const empty = 'done\n› Ask Codex to do anything\nGPT-6-Astra high · Context 40% left\n? for shortcuts\n'
const owner = { panePid: 1, paneId: '%1', tty: '/dev/ttys1', command: 'codex', argv: ['/usr/bin/codex'], pids: [2] }
const qoderOwner = { ...owner, command: 'qodercli', argv: ['/usr/bin/qodercli'], pids: [3] }
const QODER_FAST_EMPTY = 'Previous response\n────────────────────\n *   Type your message or @path/to/file\n────────────────────\n Fast · 400K · ctx ▓░░░░░░░░░ 18% · ~/project\n'
function fixture() {
  const mgr = new PtyManager()
  const userWrite = vi.fn()
  const fakeSession = { nodeId: 'n', proc: { write: userWrite }, daReplies: { filterInput: (x: string) => x } }
  const send = vi.fn(async () => true)
  Object.assign(mgr, { sessionByPersistKey: () => fakeSession, sessions: new Map([['s', fakeSession]]), sendEnvelopeNow: send })
  const capture = vi.spyOn(mgr, 'captureSnapshot').mockResolvedValue(empty)
  const paneOwner = vi.spyOn(mgr, 'paneOwner').mockResolvedValue(owner)
  return { mgr, send, capture, userWrite, paneOwner }
}
describe('mailbox wake uses an empty, unchanged Codex composer', () => {
  it('claims exactly once and delivers a notice', async () => {
    const { mgr, send } = fixture(); const claim = vi.fn(() => true)
    expect(await mgr.wakeMailbox('n','mail',()=>true,claim)).toBe('sent')
    expect(claim).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1)
  })
  it('never claims or writes into a draft or an interrupted turn', async () => {
    const { mgr, send, capture } = fixture(); const claim = vi.fn(() => true)
    capture.mockResolvedValue(empty.replace('Ask Codex to do anything','draft'))
    expect(await mgr.wakeMailbox('n','mail',()=>true,claim)).toBe('held:codex-composer-not-empty-or-unknown')
    expect(await mgr.wakeMailbox('n','mail',()=>false,claim)).toBe('held:lifecycle-or-session-changed')
    expect(claim).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled()
  })
  it('typing during observation cancels wake and preserves user bytes', async () => {
    const { mgr, send, capture, userWrite } = fixture(); let reads = 0
    capture.mockImplementation(async () => { if (++reads === 2) mgr.write(null,'s','hello'); return empty })
    expect(await mgr.wakeMailbox('n','mail',()=>true,()=>true)).toBe('held:user-input-raced')
    expect(send).not.toHaveBeenCalled(); expect(userWrite).toHaveBeenCalledWith('hello')
  })
  it('typing in the commit window is preserved after the notice', async () => {
    const { mgr, send, userWrite } = fixture()
    send.mockImplementation(async () => { mgr.write(null,'s','draft'); expect(userWrite).not.toHaveBeenCalled(); return true })
    expect(await mgr.wakeMailbox('n','mail',()=>true,()=>true)).toBe('sent')
    expect(userWrite).toHaveBeenCalledWith('draft')
  })
})

function qoderFixture() {
  const f = fixture()
  f.paneOwner.mockResolvedValue(qoderOwner)
  f.capture.mockResolvedValue(QODER_FAST_EMPTY)
  return f
}

describe('Qoder 1.1.81 mailbox wake (issue #1)', () => {
  it('delivers from the star/Fast layout only after rechecking the same process and screen', async () => {
    const { mgr, paneOwner, capture, send } = qoderFixture()
    const claim = vi.fn(() => true)
    expect(await mgr.wakeMailbox('n', 'mail', () => true, claim, 'qoder')).toBe('sent')
    expect(paneOwner).toHaveBeenCalledTimes(2)
    expect(capture).toHaveBeenCalledTimes(2)
    expect(claim).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['draft', QODER_FAST_EMPTY.replace('Type your message or @path/to/file', 'unfinished draft'), 'held:qoder-composer-not-empty'],
    ['approval', QODER_FAST_EMPTY + 'Permission Required\nAllow once?', 'held:qoder-composer-structure-unknown'],
    ['unknown footer', QODER_FAST_EMPTY.replace('Fast · 400K', 'Unknown layout'), 'held:qoder-composer-footer-unknown']
  ])('does not claim or send for %s', async (_kind, screen, reason) => {
    const { mgr, capture, send } = qoderFixture()
    capture.mockResolvedValue(screen)
    const claim = vi.fn(() => true)
    expect(await mgr.wakeMailbox('n', 'mail', () => true, claim, 'qoder')).toBe(reason)
    expect(claim).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects a changed process identity or native lifecycle before claiming', async () => {
    const { mgr, paneOwner, send } = qoderFixture()
    paneOwner.mockResolvedValueOnce(qoderOwner).mockResolvedValueOnce({ ...qoderOwner, pids: [4] })
    const claim = vi.fn(() => true)
    expect(await mgr.wakeMailbox('n', 'mail', () => true, claim, 'qoder')).toBe('held:pane-identity-changed')
    expect(await mgr.wakeMailbox('n', 'mail', () => false, claim, 'qoder')).toBe('held:lifecycle-or-session-changed')
    expect(claim).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('preserves user bytes and cancels if typing races with the new layout observation', async () => {
    const { mgr, capture, send, userWrite } = qoderFixture()
    let reads = 0
    capture.mockImplementation(async () => {
      if (++reads === 2) mgr.write(null, 's', '用户草稿')
      return QODER_FAST_EMPTY
    })
    const claim = vi.fn(() => true)
    expect(await mgr.wakeMailbox('n', 'mail', () => true, claim, 'qoder')).toBe('held:user-input-raced')
    expect(userWrite).toHaveBeenCalledWith('用户草稿')
    expect(claim).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('holds unstable frames without claiming, and preserves input arriving during a committed Qoder wake', async () => {
    const { mgr, capture, send, userWrite } = qoderFixture()
    capture.mockResolvedValueOnce(QODER_FAST_EMPTY).mockResolvedValueOnce('redraw\n' + QODER_FAST_EMPTY)
    const claim = vi.fn(() => true)
    expect(await mgr.wakeMailbox('n', 'mail', () => true, claim, 'qoder')).toBe('held:screen-changed')
    expect(claim).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    send.mockImplementation(async () => {
      mgr.write(null, 's', 'new draft')
      expect(userWrite).not.toHaveBeenCalled()
      return true
    })
    expect(await mgr.wakeMailbox('n', 'mail', () => true, claim, 'qoder')).toBe('sent')
    expect(userWrite).toHaveBeenCalledWith('new draft')
  })

  it('re-evaluates the same persisted mail after safe redraw, without a sender resend or duplicate wake', async () => {
    const { mgr, capture, send } = qoderFixture()
    const dir = mkdtempSync(join(tmpdir(), 'im-qoder-retry-'))
    const runtime = new ImRuntime(join(dir, 'mail.db'))
    const sender = { project: 'p', node: 'sender', session: 's1', cli: 'codex', generation: 'g' }
    const receiver = { ...sender, node: 'n', session: 's2', cli: 'qoder' }
    let changed: (() => void) | undefined
    const schedule = vi.fn()
    const retry = new ImWakeOutputRetry((_node, cb) => { changed = cb; return () => { changed = undefined } }, schedule)
    try {
      runtime.attach(sender); runtime.attach(receiver)
      runtime.observe(receiver, { sequence: 1, event: 'idle' })
      runtime.dispatch(sender, 'send', [], { to: 'n', thread: 'job', key: 'once', body: 'persisted task' })
      const attempt = async () => {
        retry.begin('n')
        const result = await runtime.wake(receiver,
          (text, ready, claim) => mgr.wakeMailbox('n', text, ready, claim, 'qoder'), 'im')
        retry.finish('n', result)
        return result
      }
      capture.mockResolvedValue(QODER_FAST_EMPTY.replace('Type your message or @path/to/file', 'draft'))
      expect(await attempt()).toBe('held:qoder-composer-not-empty')
      expect(runtime.dispatch(receiver, 'status')).toMatchObject({ unread: 1, lastWake: 'held:qoder-composer-not-empty' })
      capture.mockResolvedValue(QODER_FAST_EMPTY)
      changed!()
      expect(schedule).toHaveBeenCalledTimes(1)
      expect(await attempt()).toBe('sent')
      expect(await attempt()).toBe('empty')
      expect(send).toHaveBeenCalledTimes(1)
      // A wake neither consumes the body nor acknowledges it for the agent.
      expect(runtime.dispatch(receiver, 'read')).toMatchObject({ messages: [expect.objectContaining({ body: 'persisted task' })] })
    } finally {
      retry.dispose(); runtime.close(); rmSync(dir, { recursive: true })
    }
  })
})
