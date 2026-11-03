// Canvas's agent-status listener after the reducer split: the store writes live in
// `state/applyAgentEvent.ts` (behaviour-tested there, against real stores), and what stays in the
// listener is this window's own business — the unread mark and its ack, the sound, the OS
// notification and the handoff fold. Pinned over the source because the listener lives inside one
// of Canvas.tsx's effects and no harness can dispatch an event at it.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const read = (rel: string): string => readFileSync(resolve(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n')

/** The local status listener shares the effect with the fork's independent rate-limit push. */
function listenerBody(src: string): string {
  const start = src.indexOf('const offStatus = api.onAgentStatus(')
  expect(start, 'Canvas must still subscribe to agent:status').toBeGreaterThan(-1)
  const end = src.indexOf('\n    })\n    return () => {', start)
  expect(end, 'the listener must still close its own effect').toBeGreaterThan(start)
  expect(src.slice(end, end + 100)).toContain('offStatus()')
  expect(src.slice(end, end + 100)).toContain('offRateLimited?.()')
  return src.slice(start, end + '\n    })'.length)
}

/** The body of the listener's `alert` closure: everything before the reducer call. */
function alertBody(body: string): string {
  const start = body.indexOf('const alert = (')
  expect(start, 'the listener must still build its alert closure').toBeGreaterThan(-1)
  const end = body.indexOf('const r = applyAgentEvent(', start)
  expect(end).toBeGreaterThan(start)
  return body.slice(start, end)
}

describe('Canvas agent-status listener — reducer split', () => {
  it('the Canvas listener delegates its store writes to applyAgentEvent', () => {
    const body = listenerBody(read('canvas/Canvas.tsx'))
    expect(body).toContain('applyAgentEvent(useAgentStatus, useAgentNodes, e, {')
    expect(body).not.toMatch(/\.setState\(e\.nodeId/) // no store write left inline
    expect(body).not.toMatch(
      /cs\.(setSessionId|setAccount|setSession|setLoop|bumpLoop|markBackgroundTask|setHibernated|setPaused|setSessionEnded)\(/
    )
    expect(body).not.toContain('useAgentNodes.getState()')
    expect(body).toContain('suppressDoneAfterHandoff') // local-only side effects stay here
  })

  it('asks whether an observation is remote only for an event that carries an account', () => {
    // The reducer reads `observationRemote` for `setAccount` and nothing else
    // (applyAgentEvent.test.ts pins that), so the node/project lookup behind it runs only then.
    const body = listenerBody(read('canvas/Canvas.tsx'))
    expect(body).toContain('observationRemote: e.account ? observationIsRemote(originOf(e.nodeId)) : false')
  })

  it('persists the verified local CLI binding after the reducer updates the observed session', () => {
    const body = listenerBody(read('canvas/Canvas.tsx'))
    expect(body.indexOf('const bindingData')).toBeGreaterThan(body.indexOf('const r = applyAgentEvent('))
    expect(body).toContain('verifyObservedBinding(bindingNode, e, () => api.pty.paneOwner(e.nodeId)')
    expect(body).toContain('useAgentStatus.getState().byId[e.nodeId]?.sessionId === e.sessionId')
    expect(body).toContain('observedBindingPatch(current, e)')
  })

  it('alert still marks unread only when not watching, then acks, sounds and notifies locally', () => {
    const alertFn = alertBody(listenerBody(read('canvas/Canvas.tsx')))
    expect(alertFn).toMatch(/!watching[\s\S]*markUnread/)
    expect(alertFn).toContain('ackDone')
    expect(alertFn).toContain('playSfx')
  })
})
