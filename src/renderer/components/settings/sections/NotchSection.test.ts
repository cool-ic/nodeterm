import { describe, it, expect } from 'vitest'
import { NOTCH_ALIGNS, NOTCH_ALIGN_DEFAULT } from '@shared/notch-hud'
import { NOTCH_SIDE_OPTIONS } from './NotchSection'

/**
 * T227 — the Capsule-side control is DERIVED from the shared vocabulary rather than hand-listed, so
 * this asserts the derivation instead of a rendered DOM: the set and the order on screen are main's
 * own. Before T227 the options were a literal three-item array, which is exactly how a side added to
 * `NOTCH_ALIGNS` could go missing from Settings with nothing to catch it.
 */
describe('the Capsule-side control', () => {
  it('offers every side main accepts, in main’s order', () => {
    expect(NOTCH_SIDE_OPTIONS.map((o) => o.value)).toEqual([...NOTCH_ALIGNS])
    expect(NOTCH_SIDE_OPTIONS).toHaveLength(NOTCH_ALIGNS.length)
  })

  it('offers the bottom-right dock, under the label the owner asked for', () => {
    const dock = NOTCH_SIDE_OPTIONS.find((o) => o.value === 'bottom-right')
    expect(dock?.label).toBe('右下角')
    // The three upstream sides keep the labels they always had.
    expect(NOTCH_SIDE_OPTIONS.filter((o) => o.value !== 'bottom-right').map((o) => o.label)).toEqual([
      'Left',
      'Center',
      'Right'
    ])
  })

  it('every option carries a non-empty label, and values are unique', () => {
    for (const o of NOTCH_SIDE_OPTIONS) expect(o.label.length).toBeGreaterThan(0)
    expect(new Set(NOTCH_SIDE_OPTIONS.map((o) => o.value)).size).toBe(NOTCH_SIDE_OPTIONS.length)
  })

  it('the default side is one of them — the control can always show what is in force', () => {
    expect(NOTCH_SIDE_OPTIONS.some((o) => o.value === NOTCH_ALIGN_DEFAULT)).toBe(true)
  })
})
