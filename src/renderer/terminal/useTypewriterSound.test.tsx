// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useSettings } from '../state/settings'
import { useTypewriterSound } from './useTypewriterSound'
const audio = vi.hoisted(() => ({ created: 0, play: vi.fn(), close: vi.fn(), dispose: vi.fn(), strike: null as null | ((kind: string) => void), remove: vi.fn() }))
vi.mock('./typewriter-sound', () => ({
  TypewriterSound: class { constructor() { audio.created++ } play = audio.play; close = audio.close; dispose = audio.dispose },
  typewriterVolume: (v: number) => v / 100,
  installTypewriterSound: (_doc: Document, play: (kind: string) => void) => { audio.strike = play; return audio.remove }
}))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => vi.restoreAllMocks())
it('volume drags reuse buffers/listeners; mute and unmount clean up; blur only releases the device', async () => {
  const host = document.createElement('div'), root = createRoot(host)
  const before = useSettings.getState().settings
  const settings = (volume: number, enabled = true) => useSettings.setState({ settings: { ...before, terminalTypewriterSound: enabled, terminalTypewriterVolume: volume } })
  function Probe() { useTypewriterSound(); return null }
  settings(25)
  try {
    await act(async () => root.render(<Probe />))
    for (const n of [30, 40, 50, 60, 75]) await act(async () => settings(n))
    expect(audio.created).toBe(1)
    expect(audio.dispose).not.toHaveBeenCalled()
    expect(audio.remove).not.toHaveBeenCalled()
    audio.strike?.('key'); expect(audio.play).toHaveBeenLastCalledWith('key', .75)
    window.dispatchEvent(new Event('blur'))
    expect(audio.close).toHaveBeenCalledTimes(1)
    expect(audio.dispose).not.toHaveBeenCalled()
    await act(async () => settings(0))
    expect(audio.dispose).toHaveBeenCalledTimes(1)
    expect(audio.remove).toHaveBeenCalledTimes(1)
    await act(async () => settings(50, false))
    expect(audio.created).toBe(1)
    await act(async () => settings(50))
    expect(audio.created).toBe(2)
  } finally {
    await act(async () => root.unmount())
    useSettings.setState({ settings: before })
  }
  expect(audio.dispose).toHaveBeenCalledTimes(2)
})
