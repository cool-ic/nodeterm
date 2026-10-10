// `PtyManager.sendChatPrompt` — the ⌘M chat view's send. For an agent whose screen we can read
// (claude), the pane's screen is checked BEFORE anything is written: Claude Code's own dialogs fire
// no hook, and a paste into one swallowed the text while its Enter answered the dialog. The screen
// reader itself is tested in shared/agents/claude-screen.test.ts; this file pins the dispatch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'

vi.mock('node-pty', () => ({ spawn: () => ({}) }))

const NODE = 'node-1'
const RULE = '─'.repeat(80)
const IDLE = [RULE, '❯ ', RULE, '  ? for shortcuts'].join('\n')
const TRUST = [RULE, ' Accessing workspace:', ' ❯ No, exit', '   Yes, I trust this folder', ' Enter to confirm · Esc to cancel'].join('\n')

async function manager(screen: string) {
  const { PtyManager } = await import('./pty-manager')
  const mgr = new PtyManager()
  const captureSession = vi.spyOn(mgr, 'captureSession').mockResolvedValue(screen)
  const sendText = vi.spyOn(mgr, 'sendText').mockResolvedValue(true)
  return { mgr, captureSession, sendText }
}

describe('PtyManager.sendChatPrompt', () => {
  beforeEach(() => {
    vi.resetModules()
    initPlatform(fakePlatform())
  })
  afterEach(() => {
    resetPlatformForTests()
  })

  it('sends a claude prompt when its input box is on screen', async () => {
    const { mgr, sendText } = await manager(IDLE)

    const result = await mgr.sendChatPrompt(NODE, 'hello', 'claude')

    expect(result).toBe(true)
    // Typed, not pasted (core/typed-input.ts): decided here from the agent id, not by the renderer.
    expect(sendText).toHaveBeenCalledWith(NODE, 'hello', { typedFor: 'claude' })
  })

  it('refuses before writing anything when a claude dialog owns the screen, and returns its text', async () => {
    const { mgr, sendText } = await manager(TRUST)

    const result = await mgr.sendChatPrompt(NODE, 'hello', 'claude')

    expect(sendText).not.toHaveBeenCalled()
    expect(result).toEqual({ blocked: 'screen', dialog: expect.stringContaining('No, exit') })
  })

  it('refuses with no dialog text when the input box is gone (a shell owns the pane)', async () => {
    const { mgr, sendText } = await manager('user@host ~ % ')

    const result = await mgr.sendChatPrompt(NODE, 'hello', 'claude')

    expect(sendText).not.toHaveBeenCalled()
    expect(result).toEqual({ blocked: 'screen', dialog: null })
  })

  it('an empty capture is not evidence of a dialog: the prompt is sent as before', async () => {
    const { mgr, sendText } = await manager('')

    const result = await mgr.sendChatPrompt(NODE, 'hello', 'claude')

    expect(result).toBe(true)
    expect(sendText).toHaveBeenCalledWith(NODE, 'hello', { typedFor: 'claude' })
  })

  it('never reads the screen of an agent without a measured reader', async () => {
    const { mgr, captureSession, sendText } = await manager(TRUST)

    const result = await mgr.sendChatPrompt(NODE, 'hello', 'codex')

    expect(captureSession).not.toHaveBeenCalled()
    expect(result).toBe(true)
    expect(sendText).toHaveBeenCalledWith(NODE, 'hello')
  })
})

describe('PtyManager — one write into a pane at a time', () => {
  beforeEach(() => {
    vi.resetModules()
    initPlatform(fakePlatform())
  })
  afterEach(() => {
    resetPlatformForTests()
  })

  // A typed chat prompt takes seconds; a paste (an agent message, dictation) arriving meanwhile
  // would land between its lines and be submitted as part of it.
  it('a send into a pane waits for the one already writing there; another pane does not', async () => {
    const { PtyManager } = await import('./pty-manager')
    const mgr = new PtyManager()
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const now = vi
      .spyOn(mgr as unknown as { sendTextNow: (k: string, t: string) => Promise<boolean> }, 'sendTextNow')
      .mockImplementation(async (key: string, text: string) => {
        order.push(`start ${key} ${text}`)
        if (text === 'slow') await gate
        order.push(`end ${key} ${text}`)
        return true
      })
    vi.spyOn(mgr as unknown as { sendEnvelopeNow: (k: string, e: string) => Promise<boolean> }, 'sendEnvelopeNow')
      .mockImplementation(async (key: string, env: string) => {
        order.push(`envelope ${key} ${env}`)
        return true
      })

    const first = mgr.sendText(NODE, 'slow')
    const second = mgr.sendText(NODE, 'after')
    const envelope = mgr.sendEnvelope(NODE, 'msg')
    const other = mgr.sendText('node-2', 'elsewhere')
    await other
    expect(order).toEqual(['start node-1 slow', 'start node-2 elsewhere', 'end node-2 elsewhere'])

    release()
    await Promise.all([first, second, envelope])
    expect(order.slice(3)).toEqual(['end node-1 slow', 'start node-1 after', 'end node-1 after', 'envelope node-1 msg'])
    expect(now).toHaveBeenCalledTimes(3)
  })

  it('a failed write does not block the next one', async () => {
    const { PtyManager } = await import('./pty-manager')
    const mgr = new PtyManager()
    vi.spyOn(mgr as unknown as { sendTextNow: (k: string, t: string) => Promise<boolean> }, 'sendTextNow')
      .mockImplementationOnce(async () => {
        throw new Error('boom')
      })
      .mockImplementationOnce(async () => true)

    await expect(mgr.sendText(NODE, 'a')).rejects.toThrow('boom')
    await expect(mgr.sendText(NODE, 'b')).resolves.toBe(true)
  })
})

describe('PtyManager — Qoder paste and separate submit', () => {
  const owner = {
    panePid: 100, paneId: '%7', tty: '/dev/ttys007', command: 'qodercli',
    argv: ['/Users/f/.local/bin/qodercli'], pids: [200]
  }
  beforeEach(() => {
    vi.resetModules()
    initPlatform(fakePlatform())
  })
  afterEach(() => resetPlatformForTests())

  it('submits only after the pasted Qoder text is visible and the same process still owns the pane', async () => {
    const { PtyManager } = await import('./pty-manager')
    const mgr = new PtyManager()
    const capture = vi.spyOn(mgr, 'captureSession')
      .mockResolvedValueOnce('idle')
      .mockResolvedValue('idle\n/model performance')
    vi.spyOn(mgr, 'paneOwner').mockResolvedValue(owner)
    const writes = vi.spyOn(mgr as unknown as {
      sendTextNow(k: string, t: string, opts: { enter: boolean }): Promise<boolean>
    }, 'sendTextNow').mockResolvedValue(true)
    const internal = mgr as unknown as {
      qoderSettledText(k: string, t: string, expected: typeof owner): Promise<unknown>
    }
    expect(await internal.qoderSettledText(NODE, '/model performance', owner)).toBe(true)
    expect(capture).toHaveBeenCalledTimes(4)
    expect(writes.mock.calls).toEqual([
      [NODE, '/model performance', { enter: false }],
      [NODE, '', { enter: true }]
    ])
  })

  it('does not send Enter to a replaced process, and tells write the text remains unsubmitted', async () => {
    const { PtyManager } = await import('./pty-manager')
    const mgr = new PtyManager()
    vi.spyOn(mgr, 'captureSession').mockResolvedValueOnce('idle').mockResolvedValue('idle\nhello')
    vi.spyOn(mgr, 'paneOwner').mockResolvedValue({ ...owner, pids: [201] })
    const writes = vi.spyOn(mgr as unknown as {
      sendTextNow(k: string, t: string, opts: { enter: boolean }): Promise<boolean>
    }, 'sendTextNow').mockResolvedValue(true)
    const internal = mgr as unknown as {
      qoderSettledText(k: string, t: string, expected: typeof owner): Promise<unknown>
    }
    expect(await internal.qoderSettledText(NODE, 'hello', owner)).toBe('pasted-not-submitted')
    expect(writes.mock.calls).toEqual([[NODE, 'hello', { enter: false }]])
  })

  it('does not retry an envelope that was pasted but could not be submitted', async () => {
    const { PtyManager } = await import('./pty-manager')
    const mgr = new PtyManager()
    vi.spyOn(mgr as unknown as {
      qoderSettledText(k: string, t: string, expected: typeof owner): Promise<'pasted-not-submitted'>
    }, 'qoderSettledText').mockResolvedValue('pasted-not-submitted')
    const internal = mgr as unknown as {
      sendEnvelopeNow(k: string, t: string, expected: typeof owner): Promise<boolean>
    }
    expect(await internal.sendEnvelopeNow(NODE, 'envelope', owner)).toBe(true)
  })

  it('confirms a slash command only after it leaves the Qoder composer', async () => {
    const { PtyManager } = await import('./pty-manager')
    const mgr = new PtyManager()
    vi.spyOn(mgr, 'captureSession').mockResolvedValue([
      ' > /model performance',
      ' ● Model set to Performance (persisted)',
      '────────────────────────────────',
      ' >   Type your message or @path/to/file',
      '────────────────────────────────'
    ].join('\n'))
    const internal = mgr as unknown as {
      qoderSlashCommandLeftComposer(k: string, t: string): Promise<boolean>
    }
    expect(await internal.qoderSlashCommandLeftComposer(NODE, '/model performance')).toBe(true)
  })
})
