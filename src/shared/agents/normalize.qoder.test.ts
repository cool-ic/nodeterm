// Behavioural pin over Qoder CLI (`qodercli` 1.1.67) hook payloads.
//
// FIXTURE PROVENANCE: two entries in `__fixtures__/qoder/hook-payloads.json` are LIVE captures
// (a hook written into a scratch config dir's settings.json, the CLI run in a tmux pane, the hook's
// stdin appended to a file on this host on 2026-10-10). The rest are reconstructed from the shipped
// binary's own emitters and are marked `provenance: 'emitter'`; the file's `_capture` note says which
// is which, so no reader mistakes a reconstructed text field for a captured one.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { normalizeFor, normalizeQoder, type RawHookEnvelope } from './normalize'

interface FixtureEntry {
  event: string
  provenance: 'live' | 'emitter'
  note?: string
  payload: Record<string, unknown>
}

const fixture = JSON.parse(
  readFileSync(path.join(__dirname, '__fixtures__/qoder/hook-payloads.json'), 'utf8')
) as { events: FixtureEntry[] }

const entries = (event: string): FixtureEntry[] => fixture.events.filter((e) => e.event === event)
const one = (event: string, match: (p: Record<string, unknown>) => boolean = () => true): FixtureEntry => {
  const hit = entries(event).filter((e) => match(e.payload))
  if (hit.length !== 1) throw new Error(`fixture must hold exactly one ${event} for this case, got ${hit.length}`)
  return hit[0]
}
const envFor = (payload: Record<string, unknown>): RawHookEnvelope => ({
  nodeId: 'node-1',
  agentId: 'qoder',
  payload
})
const run = (e: FixtureEntry) => normalizeQoder(envFor(e.payload))

describe('normalizeQoder', () => {
  it('carries the session id Qoder hands out — the same value `--resume` takes', () => {
    const e = one('SessionStart')
    // The fixture's transcript_path ends in `<session_id>.jsonl`; that identity is the reason the
    // resume grammar is safe to build from this field.
    const p = e.payload as { session_id: string; transcript_path: string }
    expect(p.transcript_path.endsWith(`${p.session_id}.jsonl`)).toBe(true)
    expect(run(e)).toEqual({
      nodeId: 'node-1',
      agentId: 'qoder',
      sessionId: p.session_id,
      kind: 'session',
      sessionPhase: 'start'
    })
  })

  it('maps the session lifecycle both ways (SESSION_END_CAPABLE depends on the end branch)', () => {
    expect(run(one('SessionEnd'))).toMatchObject({ kind: 'session', sessionPhase: 'end' })
  })

  it('opens a turn on UserPromptSubmit with the prompt as the task label', () => {
    expect(run(one('UserPromptSubmit'))).toEqual({
      nodeId: 'node-1',
      agentId: 'qoder',
      sessionId: 'c87e162b-51d0-422c-9be1-491eb9f65df5',
      kind: 'state',
      state: 'working',
      task: 'fix the failing test',
      newTurn: true
    })
  })

  it('treats every tool event, including a failed one, as still working', () => {
    for (const ev of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
      expect(run(one(ev)), ev).toMatchObject({ kind: 'state', state: 'working' })
    }
  })

  it('ends the turn on Stop, and flags an interrupted one', () => {
    expect(run(one('Stop', (p) => p.is_interrupt === undefined))).toEqual({
      nodeId: 'node-1',
      agentId: 'qoder',
      sessionId: 'c87e162b-51d0-422c-9be1-491eb9f65df5',
      kind: 'state',
      state: 'done',
      interrupted: false,
      lastMessage: 'All tests pass.'
    })
    expect(run(one('Stop', (p) => p.is_interrupt === true))).toMatchObject({
      state: 'done',
      interrupted: true
    })
  })

  it('ends the turn AND marks it errored on StopFailure, which is what it fires instead of Stop', () => {
    expect(run(one('StopFailure'))).toEqual({
      nodeId: 'node-1',
      agentId: 'qoder',
      sessionId: 'c87e162b-51d0-422c-9be1-491eb9f65df5',
      kind: 'state',
      state: 'done',
      errored: true,
      lastMessage: 'partial answer'
    })
  })

  it('maps only the two state-changing notification types', () => {
    expect(run(one('Notification', (p) => p.notification_type === 'permission_prompt'))).toMatchObject({
      kind: 'state',
      state: 'blocked',
      lastMessage: 'Qoder CLI needs your permission to run this command.'
    })
    expect(run(one('Notification', (p) => p.notification_type === 'elicitation_dialog'))).toMatchObject({
      kind: 'state',
      state: 'waiting'
    })
    // idle_prompt is the rescue signal: `done` + idle, which may only move a node still WORKING.
    expect(run(one('Notification', (p) => p.notification_type === 'idle_prompt'))).toEqual({
      nodeId: 'node-1',
      agentId: 'qoder',
      sessionId: 'c87e162b-51d0-422c-9be1-491eb9f65df5',
      kind: 'state',
      state: 'done',
      interrupted: true,
      idle: true
    })
    // Information, not state: the node must be left exactly as it was.
    expect(run(one('Notification', (p) => p.notification_type === 'auth_success'))).toBeNull()
  })

  it('is a no-op for an event it does not map, and for a missing session id forwards none', () => {
    expect(normalizeQoder(envFor({ hook_event_name: 'PreCompact' }))).toBeNull()
    expect(normalizeQoder(envFor({ hook_event_name: 'TeammateIdle', session_id: 7 }))).toBeNull()
    const ev = normalizeQoder(envFor({ hook_event_name: 'SessionEnd' }))
    expect(ev?.sessionId).toBeUndefined()
  })

  it('is reachable through normalizeFor, which is the only entry the hook server uses', () => {
    expect(normalizeFor('qoder', envFor(one('SessionStart').payload))).toMatchObject({
      kind: 'session',
      sessionPhase: 'start'
    })
  })
})
