import { EditorState } from '@codemirror/state'
import { expect, it } from 'vitest'
import { markdownInkField, wetInk, dryInk } from './markdown-ink'

const ranges = (s: EditorState) => {
  const out: [number, number][] = []
  s.field(markdownInkField).between(0, s.doc.length, (a, b) => { out.push([a, b]) })
  return out
}
it('keeps ink on the same real text through inserts/deletes and dries without changing content', () => {
  let s = EditorState.create({ doc: '旧字中文Hello', extensions: [markdownInkField] })
  expect(ranges(s)).toEqual([])
  s = s.update({ effects: wetInk.of([{ from: 2, to: 4 }]) }).state
  s = s.update({ changes: { from: 0, insert: 'new\n' } }).state
  expect(ranges(s)).toEqual([[6, 8]])
  s = s.update({ changes: { from: 6, to: 8 } }).state
  expect(ranges(s)).toEqual([])
  s = s.update({ effects: dryInk.of() }).state
  expect(s.doc.toString()).toBe('new\n旧字Hello')
})
it('bounds marks even during continuous typing', () => {
  let s = EditorState.create({ extensions: [markdownInkField] })
  for (let i = 0; i < 800; i++) {
    s = s.update({ changes: { from: i, insert: 'a' }, selection: { anchor: i + 1 } }).state
    s = s.update({ effects: wetInk.of([{ from: i, to: i + 1 }]) }).state
  }
  expect(ranges(s).length).toBeLessThanOrEqual(512)
  expect(s.doc.length).toBe(800)
})
