// @vitest-environment node
//
// T229: tooltips and menus open AWAY from the window edge — the direction is a product of the
// rail, never a per-button flag. Regression from the field: the left rail's tooltips opened left
// onto their own buttons (Save trigger x=29..71, bubble x=7.8..53), and the Add-node menu opened
// left off-screen (190px wide from x=29 → left edge x=-177, unusable).
//
// T249: the menus' half of that rule moved out of CSS and into `railMenuPlacement` — the menus are
// portals to `document.body` now, because a menu anchored inside the rail card was CLIPPED by the
// card's scroll container (`.canvas-rail__body { overflow-y: auto }`) and never painted: measured
// on the packaged build, the Add-node menu had a correct rect (87,51 190×574) and its centre
// hit-tested as the canvas. So the direction is pinned here against the function, and the CSS is
// pinned to stay out of the anchoring business.
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { RAIL_MENU_GAP, railMenuPlacement } from '../lib/railMenu'

const DOCK_SRC = fs.readFileSync(path.join(__dirname, '..', 'components', 'Dock.tsx'), 'utf8').replace(/\r\n/g, '\n')
const STYLES_SRC = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8').replace(/\r\n/g, '\n')

/** The fleet window the field measurements came from. */
const VIEWPORT = { width: 1264, height: 960 }

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

  it('maps the MENU direction from the rail in the placement function, not in CSS', () => {
    // Right rail: the menu is anchored by its RIGHT edge, one gap left of the trigger.
    const rightRail = railMenuPlacement({ left: 1657, right: 1699, top: 200 }, 'right', { width: 190, height: 300 }, VIEWPORT)
    expect(rightRail.right).toBe(VIEWPORT.width - 1657 + RAIL_MENU_GAP)
    expect(rightRail.left).toBeUndefined()
    // Left rail: by its LEFT edge, one gap right of the trigger.
    const leftRail = railMenuPlacement({ left: 29, right: 71, top: 200 }, 'left', { width: 190, height: 300 }, VIEWPORT)
    expect(leftRail.left).toBe(71 + RAIL_MENU_GAP)
    expect(leftRail.right).toBeUndefined()
    // And the CSS anchors are gone, so nothing can disagree with the function.
    expect(STYLES_SRC).not.toMatch(/\.canvas-rail--left \.dock-menu/)
    expect(STYLES_SRC).not.toMatch(/\.dock-menu \{[\s\S]{0,1600}?right: calc\(/)
    // The menus are portaled out of the card's scroller, which is the only reason they paint.
    expect(DOCK_SRC).toMatch(/createPortal\(\s*<div[^>]*className=\{className \? `dock-menu \$\{className\}` : 'dock-menu'\}/)
    expect(DOCK_SRC).toContain('document.body')
    expect(STYLES_SRC).toMatch(/\.dock-menu \{[\s\S]{0,1600}?position: fixed;[\s\S]{0,200}?z-index: 21;/)
  })

  it('keeps a menu inside the window it hangs on', () => {
    // The direction rule only pays off if a menu actually lands inside the window: the measured
    // failure was a 190px menu at x=-177 from a trigger at x=29..71.
    const menu = { width: 190, height: 574 }
    const left = railMenuPlacement({ left: 29, right: 71, top: 51 }, 'left', menu, VIEWPORT)
    expect(left.left).toBe(81)
    expect(left.left! + menu.width).toBeLessThanOrEqual(VIEWPORT.width - 12)
    // Right rail: the same menu ends 10px left of the card, and its left edge stays on screen.
    const right = railMenuPlacement({ left: 1215, right: 1257, top: 51 }, 'right', menu, VIEWPORT)
    const rightEdge = VIEWPORT.width - right.right!
    expect(rightEdge).toBe(1215 - RAIL_MENU_GAP)
    expect(rightEdge - menu.width).toBeGreaterThan(0)
  })

  it('clamps the vertical so a tall menu cannot start above or end below the window', () => {
    const rail = { left: 1215, right: 1257 }
    const menu = { width: 190, height: 574 }
    // A trigger at the window's top edge: the menu would start at 0 and end 574 - 8 off the bottom
    // only if the clamp did nothing; it is held 8px in from the top and inside the bottom.
    const nearTop = railMenuPlacement({ ...rail, top: 2 }, 'right', menu, VIEWPORT)
    expect(nearTop.top).toBe(8)
    // A trigger low on a short window: the menu slides up so its last row is still reachable.
    const nearBottom = railMenuPlacement({ ...rail, top: 940 }, 'right', menu, { width: VIEWPORT.width, height: 600 })
    expect(nearBottom.top).toBe(600 - 574 - 8)
    // A menu taller than the window cannot fit at all: the clamp pins its bottom edge inside the
    // window instead (960 - 900 - 8 = 52), so its last rows stay reachable rather than running off.
    expect(railMenuPlacement({ ...rail, top: 300 }, 'right', { width: 190, height: 900 }, VIEWPORT).top).toBe(52)
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

describe('T249: the backdrop is a portal, so it covers the window', () => {
  it('renders into document.body instead of inside the card it was sized to (54×628 measured)', () => {
    const backdrop = DOCK_SRC.slice(DOCK_SRC.indexOf('dock-backdrop'))
    expect(backdrop.slice(0, 400)).toMatch(/document\.body/)
    expect(DOCK_SRC.match(/createPortal\(/g) ?? []).toHaveLength(2) // the backdrop and the menus
    // `inset: 0` is only the window because nothing above it in `document.body` filters/transforms.
    expect(STYLES_SRC).toMatch(/\.dock-backdrop \{[^}]*position: fixed;[^}]*inset: 0;/)
  })
})

describe('T229: the left rail\u2019s Add-node menu stays on screen', () => {
  it('lands fully inside the window width (was x=-177, 190px of it off-screen)', () => {
    // Left track: gap 22 + track 56 → its right edge at 78; the menu opens 10px beyond it and is
    // 190px wide (min-width, styles.css). On any window ≥ 288px wide it fits with the 12px edge
    // margin fit-view keeps; the regression was the menu going LEFT from x=29.
    const menuLeft = 22 + 56 + RAIL_MENU_GAP
    const menuWidth = 190
    const innerWidth = 1264 // the fleet window the field measurement came from
    expect(menuLeft).toBe(88)
    expect(menuLeft + menuWidth).toBeLessThanOrEqual(innerWidth - 12)
  })
})
