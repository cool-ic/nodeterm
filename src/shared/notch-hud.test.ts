import { describe, it, expect } from 'vitest'
import {
  CANVAS_MINIMAP_HEIGHT,
  CANVAS_MINIMAP_MARGIN,
  CANVAS_MINIMAP_WIDTH,
  HUD_BOTTOM_RIGHT_INSET,
  HUD_DOCK_CLEARANCE,
  NOTCH_ALIGNS,
  NOTCH_ALIGN_DEFAULT,
  NOTCH_OFFSET_MAX,
  NOTCH_OFFSET_MIN,
  NOTCH_WIDTH_DEFAULT,
  NOTCH_WIDTH_MAX,
  NOTCH_WIDTH_MIN,
  sanitizeNotchAlign,
  sanitizeNotchOffsetY,
  sanitizeNotchWidth
} from './notch-hud'

// settings.json is hand-editable: every one of these is a value a user (or a future build) can put
// there, and none may reach the window as anything but a value the layout can draw.

describe('sanitizeNotchAlign', () => {
  it('passes every side in the shared vocabulary through, the dock included', () => {
    // T227: this used to be three assertions naming left/center/right. Derived from `NOTCH_ALIGNS`
    // now, so a side added to the vocabulary is covered here without editing this list — the point
    // of the change being that the SET is main's, not this test's.
    for (const align of NOTCH_ALIGNS) expect(sanitizeNotchAlign(align)).toBe(align)
    expect(sanitizeNotchAlign('bottom-right')).toBe('bottom-right')
  })

  it.each([
    ['a typo', 'centre'],
    ['a case mismatch', 'Left'],
    ['a future value', 'top'],
    // The dock's own name with a case or spelling slip is still not a side: it must not half-work.
    ['a mis-cased dock', 'Bottom-Right'],
    ['a snake-cased dock', 'bottom_right'],
    ['a number', 1],
    ['null', null],
    ['undefined', undefined],
    ['an object with a matching key', { left: true }]
  ])('falls back to the DEFAULT for %s', (_label, v) => {
    // T227 changed what the default IS (upstream `center`, this fork `bottom-right`), and this
    // assertion is deliberately written against the constant rather than the literal: the rule
    // under test is "an unknown value means the default", not "an unknown value means center". A
    // corrupt settings.json now lands the pill out of the way instead of in the notch strip.
    expect(NOTCH_ALIGN_DEFAULT).toBe('bottom-right')
    expect(sanitizeNotchAlign(v)).toBe(NOTCH_ALIGN_DEFAULT)
  })
})

describe('sanitizeNotchOffsetY', () => {
  it('keeps an in-range integer, and rounds a fractional one', () => {
    expect(sanitizeNotchOffsetY(12)).toBe(12)
    expect(sanitizeNotchOffsetY(-12)).toBe(-12)
    expect(sanitizeNotchOffsetY(7.6)).toBe(8)
    expect(sanitizeNotchOffsetY(0)).toBe(0)
  })

  it('clamps an out-of-range value to the nearest bound, keeping its direction', () => {
    expect(sanitizeNotchOffsetY(10_000)).toBe(NOTCH_OFFSET_MAX)
    expect(sanitizeNotchOffsetY(-10_000)).toBe(NOTCH_OFFSET_MIN)
  })

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['a numeric string', '20'],
    ['null', null],
    ['undefined', undefined],
    ['a boolean', true]
  ])('falls back to 0 for %s', (_label, v) => {
    expect(sanitizeNotchOffsetY(v)).toBe(0)
  })
})

describe('sanitizeNotchWidth (moved here from notch-hud.ts, behaviour pinned)', () => {
  it('clamps to the slider bounds and rounds', () => {
    expect(sanitizeNotchWidth(50)).toBe(NOTCH_WIDTH_MIN)
    expect(sanitizeNotchWidth(900)).toBe(NOTCH_WIDTH_MAX)
    expect(sanitizeNotchWidth(180.4)).toBe(180)
  })
  it('falls back to the field-tuned default for a non-number', () => {
    expect(sanitizeNotchWidth(NaN)).toBe(NOTCH_WIDTH_DEFAULT)
    expect(sanitizeNotchWidth('168')).toBe(NOTCH_WIDTH_DEFAULT)
    expect(sanitizeNotchWidth(undefined)).toBe(NOTCH_WIDTH_DEFAULT)
  })
})

// T243: the minimap footprint the docked capsule avoids. These were @xyflow/react's defaults and
// the canvas never declared them — the pin says the avoidance value is BUILT from them, so a
// change to any piece has to be looked at, and the +2 (the dock's own 1px borders) is spelled out
// rather than folded into a magic number.
describe('the minimap footprint the bottom-right dock avoids (T243)', () => {
  it('is the library defaults we adopted, plus the canvas edge margin', () => {
    expect(CANVAS_MINIMAP_WIDTH).toBe(200)
    expect(CANVAS_MINIMAP_HEIGHT).toBe(150)
    expect(CANVAS_MINIMAP_MARGIN).toBe(22) // canvas's --float-gap
    expect(HUD_DOCK_CLEARANCE).toBe(12)
  })
  it('the inset clears the minimap with the stated clearance', () => {
    expect(HUD_BOTTOM_RIGHT_INSET).toBe(
      CANVAS_MINIMAP_MARGIN + (CANVAS_MINIMAP_HEIGHT + 2) + HUD_DOCK_CLEARANCE
    )
    expect(HUD_BOTTOM_RIGHT_INSET).toBe(186)
  })
})
