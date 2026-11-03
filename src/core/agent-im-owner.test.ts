import { expect, it, vi } from 'vitest'
import { ImOwnerProofs } from './agent-im-owner'
const identity = { project: 'p', node: 'n', session: 's', cli: 'codex', generation: 'g' }
const proof = { pid: 111, pane: '%1', tty: '/dev/ttys1', boot: 100 }
it('refreshes a restarted CLI with the same session, but not every tool callback', async () => {
  const read = vi.fn().mockResolvedValueOnce(proof).mockResolvedValueOnce({ ...proof, pid: 222 })
  const remember = vi.fn()
  const owners = new ImOwnerProofs(read, remember)
  await owners.refresh(identity)
  await owners.refresh(identity)
  expect(read).toHaveBeenCalledTimes(1)
  await owners.refresh(identity, true)
  expect(remember.mock.calls.map((call) => call[1].pid)).toEqual([111, 222])
  await owners.refresh(identity)
  expect(read).toHaveBeenCalledTimes(2)
})
it('fences old in-flight proof on restart and end; failures remain retryable', async () => {
  let release!: (value: typeof proof) => void
  const read = vi.fn().mockImplementationOnce(() => new Promise((r) => { release = r }))
    .mockResolvedValueOnce({ ...proof, pid: 222 }).mockRejectedValueOnce(Error('gone')).mockResolvedValue(proof)
  const remember = vi.fn()
  const owners = new ImOwnerProofs(read, remember)
  const old = owners.refresh(identity)
  await owners.refresh(identity, true)
  release(proof); await old
  expect(remember).toHaveBeenCalledTimes(1)
  expect(remember.mock.calls[0][1].pid).toBe(222)
  owners.forget(identity.node)
  await owners.refresh(identity)
  await owners.refresh(identity)
  expect(remember).toHaveBeenCalledTimes(2)
  let finish!: (value: typeof proof) => void
  read.mockImplementationOnce(() => new Promise((r) => { finish = r }))
  const ended = owners.refresh(identity, true)
  owners.forget(identity.node)
  finish(proof); await ended
  expect(remember).toHaveBeenCalledTimes(2)
})
it('recovered owners avoid re-probing until the next native SessionStart', async () => {
  const read = vi.fn().mockResolvedValue(proof), remember = vi.fn()
  const owners = new ImOwnerProofs(read, remember)
  owners.recovered(identity)
  await owners.refresh(identity)
  expect(read).not.toHaveBeenCalled()
  await owners.refresh(identity, true)
  expect(remember).toHaveBeenCalledWith(identity, proof)
})
it('persists the refreshed proof through the real mailbox runtime and app generation change', async () => {
  const { ImRuntime } = await import('../../scripts/agent-mail/runtime.mjs')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'owner-proof-'))
  const runtime = new ImRuntime(join(dir, 'mail.sqlite'))
  let pid = 111
  const owners = new ImOwnerProofs(async () => ({ ...proof, pid }), (id, owner) => runtime.rememberOwner(id, owner))
  try {
    runtime.attach(identity)
    await owners.refresh(identity, true)
    pid = 222
    await owners.refresh(identity, true)
    const restored = { ...identity, generation: 'next-app' }
    expect(runtime.recover(restored, proof)).toBe(false)
    expect(runtime.recover(restored, { ...proof, pid })).toBe(true)
    expect(runtime.recover({ ...restored, session: 'other' }, { ...proof, pid })).toBe(false)
  } finally { runtime.close(); rmSync(dir, { recursive: true, force: true }) }
})
