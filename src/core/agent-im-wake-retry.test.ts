import { describe, expect, it, vi } from 'vitest'
import { ImWakeOutputRetry } from './agent-im-wake-retry'

function fixture() {
  const outputs = new Map<string, () => void>()
  const schedule = vi.fn()
  const subscribe = vi.fn((node: string, changed: () => void) => {
    outputs.set(node, changed)
    return () => { outputs.delete(node) }
  })
  return { outputs, schedule, subscribe, retry: new ImWakeOutputRetry(subscribe, schedule) }
}

describe('IM output-driven re-evaluation', () => {
  it('retries held mail when the composer redraws, including output during observation', () => {
    const { retry, outputs, schedule, subscribe } = fixture()
    retry.begin('qoder')
    outputs.get('qoder')!()
    expect(schedule).toHaveBeenCalledTimes(1)
    retry.finish('qoder', 'held:qoder-composer-structure-unknown')
    outputs.get('qoder')!()
    expect(schedule).toHaveBeenCalledTimes(2)
    retry.begin('qoder')
    expect(subscribe).toHaveBeenCalledTimes(1)
    retry.dispose()
    expect(outputs.size).toBe(0)
  })

  it.each(['sent', 'empty', 'uncertain', 'held', 'held:wake-already-claimed'])('does not retry %s from later output', (result) => {
    const { retry, outputs, schedule } = fixture()
    retry.begin('qoder')
    const lateOutput = outputs.get('qoder')!
    retry.finish('qoder', result)
    lateOutput()
    expect(outputs.size).toBe(0)
    expect(schedule).not.toHaveBeenCalled()
  })
})
