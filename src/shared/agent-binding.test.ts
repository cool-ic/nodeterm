import { describe, it, expect } from 'vitest'
import { observedBindingPatch, verifyObservedBinding } from './agent-binding'
import type { NormalizedAgentEvent } from './agents/normalize'

const start: NormalizedAgentEvent = {
  nodeId: 'term-test', agentId: 'qoder', sessionId: 'session-1',
  kind: 'session', sessionPhase: 'start', verified: true
}
describe('verified terminal agent binding', () => {
  it('adopts a plain terminal and retains the exact conversation', () => {
    expect(observedBindingPatch({}, start)).toEqual({ agentId: 'qoder', agentSessionId: 'session-1' })
  })
  it('learns Codex from a verified first turn when no start arrived', () => {
    expect(observedBindingPatch({}, { ...start, agentId: 'codex', kind: 'state', state: 'working', newTurn: true }))
      .toEqual({ agentId: 'codex', agentSessionId: 'session-1' })
  })
  it('refreshes a conversation id, and is otherwise idempotent', () => {
    const data = { agentId: 'qoder', agentSessionId: 'old' }
    expect(observedBindingPatch(data, start)?.agentSessionId).toBe('session-1')
    expect(observedBindingPatch({ ...data, agentSessionId: 'session-1' }, start)).toBeNull()
  })
  it('does not adopt unverified, incomplete, ending or unrelated claims', () => {
    for (const ev of [
      { ...start, verified: false }, { ...start, sessionId: undefined },
      { ...start, sessionPhase: 'end' as const },
      { ...start, kind: 'state' as const, state: 'done' as const },
      { ...start, agentId: 'claude' as const }
    ]) expect(observedBindingPatch({}, ev)).toBeNull()
    expect(observedBindingPatch({ agentId: 'codex' }, start)).toBeNull()
    expect(observedBindingPatch({ pendingLaunch: {} }, start)).toBeNull()
  })
})

it('requires the claimed CLI to own the foreground and rejects a changed conversation', async () => {
  const own = { panePid: 1, tty: '/dev/test', command: 'qodercli', argv: ['/bin/qodercli'], pids: [2] }
  expect(await verifyObservedBinding({}, start, async () => own, () => true)).not.toBeNull()
  expect(await verifyObservedBinding({}, start, async () => ({ ...own, command: 'zsh', argv: ['zsh'] }), () => true)).toBeNull()
  expect(await verifyObservedBinding({}, start, async () => own, () => false)).toBeNull()
  expect(await verifyObservedBinding({}, start, async () => null, () => true)).toBeNull()
  expect(await verifyObservedBinding({}, start, async () => { throw Error('offline') }, () => true)).toBeNull()
})
