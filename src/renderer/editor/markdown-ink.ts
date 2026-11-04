import { StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'

type Span = { from: number; to: number }
export const wetInk = StateEffect.define<Span[]>()
export const dryInk = StateEffect.define<void>()
const MAX_INK = 512
const DURATION = 420
let stamp = 0

// Inline marks use the real text layout, including proportional CJK and wrapped lines.
// No glyph copies, character-width arithmetic, output delay, or scroll repaint animation.
export const markdownInkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(dryInk)) value = Decoration.none
      if (e.is(wetInk)) {
        const batch = String(++stamp)
        const additions = e.value.filter(r => r.to > r.from).map(r =>
          // Distinct attributes stop adjacent keystrokes merging into an older animation span.
          Decoration.mark({ class: 'paper-md-ink', attributes: { 'data-paper-ink': batch } }).range(r.from, r.to))
        value = value.update({ add: additions, sort: true })
        // A long uninterrupted typing session must not accumulate unbounded marks.
        let budget = MAX_INK
        const cutoff = Math.max(0, tr.state.selection.main.head - MAX_INK)
        value = value.update({ filter: (from, to) => {
          if (to < cutoff || budget <= 0) return false
          budget -= to - from
          return true
        } })
      }
    }
    return value
  },
  provide: field => EditorView.decorations.from(field)
})

export function markdownInk(): Extension {
  return [markdownInkField, ViewPlugin.fromClass(class {
    pending: Span[] = []
    frame = 0
    expiry: ReturnType<typeof setTimeout> | undefined
    constructor(readonly view: EditorView) {}
    update(u: ViewUpdate) {
      if (!u.docChanged) return
      for (const tr of u.transactions) {
        this.pending = this.pending.map(r => ({ from: tr.changes.mapPos(r.from, -1), to: tr.changes.mapPos(r.to, 1) }))
        if (tr.isUserEvent('input.type')) tr.changes.iterChanges((_a, _b, from, to) => {
          if (to > from) this.pending.push({ from: Math.max(from, to - MAX_INK), to })
        })
      }
      this.pending = this.pending.filter(r => r.to > r.from).slice(-MAX_INK)
      this.queue()
    }
    queue() {
      if (this.frame || !this.pending.length) return
      this.frame = requestAnimationFrame(() => {
        this.frame = 0
        // Decorating an active IME composition can replace its DOM node. Wait for commit.
        if (this.view.compositionStarted) return
        const spans: Span[] = []
        for (const span of this.pending.sort((a, b) => a.from - b.from)) {
          const last = spans.at(-1)
          if (last && span.from <= last.to) last.to = Math.max(last.to, span.to)
          else spans.push({ ...span })
        }
        this.pending = []
        this.view.dispatch({ effects: wetInk.of(spans) })
        clearTimeout(this.expiry)
        const dry = () => {
          if (this.view.compositionStarted) { this.expiry = setTimeout(dry, 60); return }
          this.view.dispatch({ effects: dryInk.of() })
        }
        this.expiry = setTimeout(dry, DURATION)
      })
    }
    destroy() { cancelAnimationFrame(this.frame); clearTimeout(this.expiry) }
  }, { eventHandlers: { compositionend() { this.queue() } } })]
}
