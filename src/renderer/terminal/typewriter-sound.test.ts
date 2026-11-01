import { describe, expect, it, vi } from 'vitest'
import { strikeForKey, typewriterVolume, TypewriterSound } from './typewriter-sound'

const key = (value: string, rest = {}) => ({ key: value, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...rest })
describe('typewriter input policy', () => {
  it('distinguishes mechanical strikes without consuming input', () => {
    expect(strikeForKey(key('a'))).toBe('key')
    expect(strikeForKey(key(' '))).toBe('space')
    expect(strikeForKey(key('Enter'))).toBe('return')
    expect(strikeForKey(key('Backspace'))).toBe('backspace')
  })
  it('does not sonify paste shortcuts, interrupts, navigation or in-progress IME', () => {
    for (const e of [key('v', { metaKey: true }), key('c', { ctrlKey: true }), key('a', { altKey: true }),
      key('Process', { isComposing: true }), key('a', { isComposing: true }), key('ArrowLeft'), key('Shift'), key('Escape')]) {
      expect(strikeForKey(e)).toBeNull()
    }
  })
  it('clamps hand-edited volume, including non-finite values', () => {
    expect(typewriterVolume(-1)).toBe(0)
    expect(typewriterVolume(150)).toBe(1)
    expect(typewriterVolume(NaN)).toBe(0.25)
    expect(typewriterVolume('100')).toBe(0.25)
  })
  it('is inert when muted and degrades when audio cannot start', () => {
    const ctor = vi.fn(function () { throw Error('device unavailable') })
    vi.stubGlobal('AudioContext', ctor)
    try {
      const audio = new TypewriterSound()
      audio.play('key', 0)
      expect(ctor).not.toHaveBeenCalled()
      expect(() => audio.play('key', 0.25)).not.toThrow()
      expect(() => audio.dispose()).not.toThrow()
    } finally { vi.unstubAllGlobals() }
  })
})
