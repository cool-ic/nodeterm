// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EditorState, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdownInk, markdownInkField } from './markdown-ink'
let view: EditorView
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect() })
})
afterEach(() => { view?.destroy(); document.body.replaceChildren(); delete (Range.prototype as any).getClientRects; delete (Range.prototype as any).getBoundingClientRect; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
const count = () => view.state.field(markdownInkField).size
it('does not decorate preedit DOM, then decorates committed text and expires at idle', async () => {
  const host = document.createElement('div'); document.body.append(host)
  view = new EditorView({ parent: host, state: EditorState.create({ extensions: [markdownInk()] }) })
  view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  expect(view.compositionStarted).toBe(true)
  // CM's composing is false before the first native DOM mutation. Started is the safe guard.
  view.dispatch({ changes: { from: 0, insert: '拼音' }, userEvent: 'input.type.compose' })
  await vi.advanceTimersByTimeAsync(40); expect(count()).toBe(0)
  view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '拼音' }))
  await vi.advanceTimersByTimeAsync(40); expect(count()).toBeGreaterThan(0)
  await vi.advanceTimersByTimeAsync(450); expect(count()).toBe(0)
})
it('does not animate paste, initial content, history or a programmatic redraw', async () => {
  view = new EditorView({ state: EditorState.create({ doc: 'old', extensions: [markdownInk()] }) })
  for (const event of ['input.paste', 'undo', 'redo', undefined]) {
    view.dispatch({ changes: { from: view.state.doc.length, insert: 'new' }, annotations: event ? Transaction.userEvent.of(event) : undefined })
    await vi.advanceTimersByTimeAsync(40); expect(count()).toBe(0)
  }
})
