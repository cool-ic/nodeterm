import { describe, it, expect, vi } from 'vitest'
import { PtyManager } from './pty-manager'

const empty = 'done\n› Ask Codex to do anything\nGPT-6-Astra high · Context 40% left\n? for shortcuts\n'
const owner = { panePid: 1, paneId: '%1', tty: '/dev/ttys1', command: 'codex', argv: ['/usr/bin/codex'], pids: [2] }
function fixture() {
  const mgr = new PtyManager()
  const userWrite = vi.fn()
  const fakeSession = { nodeId: 'n', proc: { write: userWrite }, daReplies: { filterInput: (x: string) => x } }
  const send = vi.fn(async () => true)
  Object.assign(mgr, { sessionByPersistKey: () => fakeSession, sessions: new Map([['s', fakeSession]]), sendEnvelopeNow: send })
  const capture = vi.spyOn(mgr, 'captureSnapshot').mockResolvedValue(empty)
  vi.spyOn(mgr, 'paneOwner').mockResolvedValue(owner)
  return { mgr, send, capture, userWrite }
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
    expect(await mgr.wakeMailbox('n','mail',()=>true,claim)).toBe('held')
    expect(await mgr.wakeMailbox('n','mail',()=>false,claim)).toBe('held')
    expect(claim).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled()
  })
  it('typing during observation cancels wake and preserves user bytes', async () => {
    const { mgr, send, capture, userWrite } = fixture(); let reads = 0
    capture.mockImplementation(async () => { if (++reads === 2) mgr.write(null,'s','hello'); return empty })
    expect(await mgr.wakeMailbox('n','mail',()=>true,()=>true)).toBe('held')
    expect(send).not.toHaveBeenCalled(); expect(userWrite).toHaveBeenCalledWith('hello')
  })
  it('typing in the commit window is preserved after the notice', async () => {
    const { mgr, send, userWrite } = fixture()
    send.mockImplementation(async () => { mgr.write(null,'s','draft'); expect(userWrite).not.toHaveBeenCalled(); return true })
    expect(await mgr.wakeMailbox('n','mail',()=>true,()=>true)).toBe('sent')
    expect(userWrite).toHaveBeenCalledWith('draft')
  })
})
