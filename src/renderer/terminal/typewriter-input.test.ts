// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installTypewriterSound } from './typewriter-sound'

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })
describe('passive local terminal sound', () => {
  it('shares the existing sound engine with the focused Markdown source, not arbitrary editable fields', () => {
    const host = document.createElement('div'); host.className = 'paper-markdown__source'
    const source = document.createElement('div'); source.className = 'cm-content'; source.setAttribute('contenteditable', 'true'); source.tabIndex = 0
    host.append(source); document.body.append(host)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const add = vi.spyOn(document, 'addEventListener'), play = vi.fn()
    const dispose = installTypewriterSound(document, play)
    const key = add.mock.calls.find(([name]) => name === 'keydown')![1] as (e: unknown) => void
    const event = { target: source, key: 'a', isTrusted: true, ctrlKey: false, altKey: false, metaKey: false, isComposing: false }
    source.focus(); key(event); expect(play).toHaveBeenCalledExactlyOnceWith('key')
    host.className = ''; key(event); expect(play).toHaveBeenCalledTimes(1)
    dispose()
  })
  it('routes only trusted focused-terminal keys and removes both observers', () => {
    const a = document.createElement('textarea'), b = document.createElement('textarea')
    a.className = b.className = 'xterm-helper-textarea'
    const input = document.createElement('input')
    document.body.append(a, b, input)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const add = vi.spyOn(document, 'addEventListener'), remove = vi.spyOn(document, 'removeEventListener')
    const play = vi.fn(), dispose = installTypewriterSound(document, play)
    const key = add.mock.calls.find(([name]) => name === 'keydown')![1] as (e: unknown) => void
    const compose = add.mock.calls.find(([name]) => name === 'compositionend')![1] as (e: unknown) => void
    const preventDefault = vi.fn(), stopPropagation = vi.fn()
    const event = { target: a, key: 'a', isTrusted: true, ctrlKey: false, altKey: false, metaKey: false,
      isComposing: false, preventDefault, stopPropagation }
    a.focus()
    key(event)
    expect(play).toHaveBeenCalledExactlyOnceWith('key')
    key({ ...event, target: b })
    key({ ...event, isTrusted: false })
    key({ ...event, metaKey: true, key: 'v' })
    key({ ...event, isComposing: true })
    expect(play).toHaveBeenCalledTimes(1)
    compose({ target: a, isTrusted: true, data: '你好' })
    expect(play).toHaveBeenCalledTimes(2)
    input.focus(); key({ ...event, target: input })
    expect(play).toHaveBeenCalledTimes(2)
    expect(preventDefault).not.toHaveBeenCalled()
    expect(stopPropagation).not.toHaveBeenCalled()
    expect(add.mock.calls.find(([name]) => name === 'keydown')![2]).toEqual({ capture: true, passive: true })
    dispose()
    expect(remove).toHaveBeenCalledWith('keydown', key, true)
    expect(remove).toHaveBeenCalledWith('compositionend', compose, true)
  })
})
