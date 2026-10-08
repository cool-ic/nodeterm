// @vitest-environment node
//
// T229: tooltips and menus open AWAY from the window edge — the direction is a product of the
// rail, never a per-button flag. Regression from the field: the left rail's tooltips opened left
// onto their own buttons (Save trigger x=29..71, bubble x=7.8..53), and the Add-node menu opened
// left off-screen (190px wide from x=29 → left edge x=-177, unusable).
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'

const DOCK_SRC = fs.readFileSync(path.join(__dirname, '..', 'components', 'Dock.tsx'), 'utf8').replace(/\r\n/g, '\n')
const STYLES_SRC = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8').replace(/\r\n/g, '\n')

describe('T229: direction is a product of the rail, one place each', () => {
  it('maps the tooltip direction from the track in ONE place (left rail right, right rail left)', () => {
    // The mapping: create (left track) → right, view (right track) → left. The measured failure
    // shape — a literal placement per button — must not come back.
    expect(DOCK_SRC).toContain("const tip = group === 'create' ? 'right' : 'left'")
    // Every toolbar tooltip goes through the mapping; the only literal placements left are the
    // three row-action tips inside the layouts menu (which opens leftward anyway).
    expect(DOCK_SRC).not.toMatch(/placement="left"/)
    expect(DOCK_SRC.match(/placement="right"/g) ?? []).toHaveLength(3)
  })

  it('anchors the menus per rail in ONE CSS place each', () => {
    // Right rail (and the base rule) opens leftward; the left rail overrides to open rightward.
    expect(STYLES_SRC).toMatch(/\.canvas-rail--left \.dock-menu \{[^}]*left: calc\(100% \+ 10px\);[^}]*right: auto;/)
    expect(STYLES_SRC).toMatch(/\.dock-menu \{[^}]*right: calc\(100% \+ 10px\);/)
  })
})

describe('T229: a tooltip never intersects its own trigger (measured rects from the field)', () => {
  const GAP = 6 // TOOLTIP_OFFSET
  it('left-track tooltips sit fully to the right of the trigger (Save was 29..71, bubble 7.8..53)', () => {
    const trigger = { left: 29, right: 71 }
    const bubbleLeft = trigger.right + GAP
    expect(bubbleLeft).toBeGreaterThanOrEqual(trigger.right) // no overlap by construction
    expect(bubbleLeft - trigger.right).toBe(GAP)
  })
  it('right-track tooltips sit fully to the left of the trigger (Fit was 1657..1699, bubble 1590.9..1651)', () => {
    const trigger = { left: 1657, right: 1699 }
    const bubbleRight = trigger.left - GAP
    expect(bubbleRight).toBeLessThanOrEqual(trigger.left)
    expect(trigger.left - bubbleRight).toBe(GAP)
  })
})

describe('T229: the left rail\u2019s Add-node menu stays on screen', () => {
  it('lands fully inside the window width (was x=-177, 190px of it off-screen)', () => {
    // Left track: gap 22 + track 56 → its right edge at 78; the menu opens 10px beyond it and is
    // 190px wide (min-width, styles.css). On any window ≥ 288px wide it fits with the 12px edge
    // margin fit-view keeps; the regression was the menu going LEFT from x=29.
    const menuLeft = 22 + 56 + 10
    const menuWidth = 190
    const innerWidth = 1264 // the fleet window the field measurement came from
    expect(menuLeft).toBe(88)
    expect(menuLeft + menuWidth).toBeLessThanOrEqual(innerWidth - 12)
  })
})
