import { describe, it, expect } from 'vitest'
import {
  hudGeometry,
  hudPlacement,
  HUD_DOCK_TOP_GAP,
  HUD_DOCK_WINDOW_HEIGHT,
  HUD_DOCK_WINDOW_HEIGHT_BOTTOM_RIGHT,
  HUD_DOCK_WINDOW_WIDTH,
  HUD_EDGE_MARGIN,
  HUD_PANEL_WIDTH,
  HUD_WINDOW_HEIGHT,
  NOTCH_BAR_FLOOR,
  PILL_TOP_GAP,
  type HudGeometryInput,
  type HudPlacementInput,
  type Rect
} from './notch-hud-geometry'
import {
  CANVAS_MINIMAP_HEIGHT,
  CANVAS_MINIMAP_MARGIN,
  HUD_BOTTOM_RIGHT_INSET,
  HUD_DOCK_CLEARANCE,
  type NotchAlign
} from '../shared/notch-hud'

/** A display, described the way Electron reports one: full bounds plus a menu-bar-shortened workArea. */
function display(width: number, height: number, menuBar: number, internal: boolean): HudGeometryInput {
  return {
    bounds: { x: 0, y: 0, width, height },
    workArea: { x: 0, y: menuBar, width, height: height - menuBar },
    internal,
    notchWidth: 168,
    offsetY: 0
  }
}

describe('hudGeometry — notch detection across scaling modes (issue #508)', () => {
  // The regression: every one of these is the SAME notched panel, and the absolute-32px predecessor
  // answered true only for the first. The reporter's setting is 1440x932.
  it.each([
    ['15" Air, default 1710x1112', 1710, 1112, 37],
    ['15" Air, scaled 1440x932', 1440, 932, 31],
    ['15" Air, scaled 1280x829', 1280, 829, 28],
    ['14" MBP, default 1512x982', 1512, 982, 37],
    ['16" MBP, default 1728x1117', 1728, 1117, 37]
  ])('detects the notch on %s', (_label, w, h, bar) => {
    expect(hudGeometry(display(w, h, bar, true)).hasNotch).toBe(true)
  })

  it.each([
    ['1080p external', 1920, 1080, 24],
    ['1440p external', 2560, 1440, 24],
    ['scaled 4K external', 3008, 1692, 24],
    ['pre-notch 13" MacBook internal', 1440, 900, 24],
    ['pre-notch MacBook, scaled up', 1680, 1050, 24]
  ])('reports notchless on %s', (_label, w, h, bar) => {
    expect(hudGeometry(display(w, h, bar, false)).hasNotch).toBe(false)
  })

  it('never reports a notch on an external display, whatever its menu bar measures', () => {
    // An external at an unusually low resolution clears the ratio on its own; `internal` is what
    // stops it. Notches do not exist on external panels.
    expect(hudGeometry(display(1024, 640, 24, false)).hasNotch).toBe(false)
  })

  it('reports notchless when the menu bar is hidden entirely', () => {
    expect(hudGeometry(display(1710, 1112, 0, true)).hasNotch).toBe(false)
  })
})

describe('hudGeometry — window placement', () => {
  it('spans the display full width from its very top edge, not the work area', () => {
    const g = hudGeometry({ ...display(1710, 1112, 37, true), bounds: { x: -1710, y: -100, width: 1710, height: 1112 } })
    expect({ x: g.x, y: g.y, width: g.width }).toEqual({ x: -1710, y: -100, width: 1710 })
  })

  it('reserves the top strip ON TOP of the expanded box, so neither layout clips', () => {
    // Both layouts start below the strip: the fused capsule pads it, the pill clears it.
    expect(hudGeometry(display(1710, 1112, 37, true)).height).toBe(37 + HUD_WINDOW_HEIGHT)
  })

  it('never exceeds the display height', () => {
    expect(hudGeometry(display(1024, 300, 24, false)).height).toBe(300)
  })

  it('grows the window by a DOWNWARD offset so a lowered panel is not clipped, and by nothing else', () => {
    const base = hudGeometry(display(1710, 1112, 37, true)).height
    expect(hudGeometry({ ...display(1710, 1112, 37, true), offsetY: 120 }).height).toBe(base + 120)
    // Raising needs no extra room; the historical height is kept bit-for-bit.
    expect(hudGeometry({ ...display(1710, 1112, 37, true), offsetY: -30 }).height).toBe(base)
    // The display edge still wins.
    expect(hudGeometry({ ...display(1024, 300, 24, false), offsetY: 240 }).height).toBe(300)
  })

  it('floors a short menu bar so the mascots always have room', () => {
    expect(hudGeometry(display(1920, 1080, 12, false)).bar).toBe(NOTCH_BAR_FLOOR)
  })

  it('centres the notch anchor on the display', () => {
    expect(hudGeometry(display(1711, 1112, 37, true)).notchCenterX).toBe(856)
  })

  it('passes the sanitized notch width through untouched', () => {
    expect(hudGeometry({ ...display(1710, 1112, 37, true), notchWidth: 220 }).notchWidth).toBe(220)
  })
})

// ---- Capsule + panel placement ------------------------------------------------------------

/** A placement query over a 1710-wide notched display with a 37 px strip (15" Air default). */
function place(over: Partial<HudPlacementInput> = {}): HudPlacementInput {
  return {
    width: 1710,
    bar: 37,
    notchWidth: 168,
    notchCenterX: 855,
    hasNotch: true,
    align: 'center',
    offsetY: 0,
    ...over
  }
}

describe('hudPlacement — the shape (fused vs pill) per display × side × offset', () => {
  it('center on a notched display at offset 0 is the historical fused layout, bit-for-bit', () => {
    const p = hudPlacement(place())
    expect(p.fused).toBe(true)
    expect(p.capsuleTop).toBe(0)
    // Right edge pinned to the notch's right edge, as the old CSS computed it.
    expect(p.anchor).toBe('right')
    expect(p.capsuleX).toBe(855 + 84)
    // Expanded: centered under the notch.
    expect(p.panelLeft).toBe(855 - HUD_PANEL_WIDTH / 2)
    expect(p.panelWidth).toBe(HUD_PANEL_WIDTH)
  })

  it('a negative offset cannot raise the fused capsule above the top edge — it stays fused at 0', () => {
    const p = hudPlacement(place({ offsetY: -48 }))
    expect(p.fused).toBe(true)
    expect(p.capsuleTop).toBe(0)
  })

  it('a positive offset detaches the centered capsule into a pill hanging below the notch', () => {
    // A detached surface with square top corners is the "black box below the menu bar" field bug.
    const p = hudPlacement(place({ offsetY: 20 }))
    expect(p.fused).toBe(false)
    expect(p.anchor).toBe('center')
    expect(p.capsuleX).toBe(855)
    expect(p.capsuleTop).toBe(37 + PILL_TOP_GAP + 20)
  })

  it.each<NotchAlign>(['left', 'right'])('%s on a notched display is a pill at that edge, never fused', (align) => {
    const p = hudPlacement(place({ align }))
    expect(p.fused).toBe(false)
    expect(p.anchor).toBe(align)
    expect(p.capsuleX).toBe(align === 'left' ? HUD_EDGE_MARGIN : 1710 - HUD_EDGE_MARGIN)
    expect(p.capsuleTop).toBe(37 + PILL_TOP_GAP)
  })

  it('on a notchless display every side is a pill below the strip, and center is a centered pill', () => {
    const p = hudPlacement(place({ hasNotch: false, bar: 24 }))
    expect(p.fused).toBe(false)
    expect(p.anchor).toBe('center')
    expect(p.capsuleX).toBe(855)
    expect(p.capsuleTop).toBe(24 + PILL_TOP_GAP)
    expect(hudPlacement(place({ hasNotch: false, bar: 24, align: 'left' })).anchor).toBe('left')
    expect(hudPlacement(place({ hasNotch: false, bar: 24, align: 'right' })).anchor).toBe('right')
  })
})

describe('hudPlacement — vertical offset', () => {
  it('moves a pill down by the offset and up by a negative one', () => {
    expect(hudPlacement(place({ align: 'left', offsetY: 100 })).capsuleTop).toBe(37 + PILL_TOP_GAP + 100)
    expect(hudPlacement(place({ align: 'left', offsetY: -20 })).capsuleTop).toBe(37 + PILL_TOP_GAP - 20)
  })

  it('never raises a pill above the display top edge (there is nothing above it)', () => {
    expect(hudPlacement(place({ align: 'left', offsetY: -48 })).capsuleTop).toBe(0)
    expect(hudPlacement(place({ hasNotch: false, bar: 24, offsetY: -48 })).capsuleTop).toBe(0)
  })

  it('does not change the horizontal anchor', () => {
    const a = hudPlacement(place({ align: 'right' }))
    const b = hudPlacement(place({ align: 'right', offsetY: 150 }))
    expect([b.anchor, b.capsuleX, b.panelLeft]).toEqual([a.anchor, a.capsuleX, a.panelLeft])
  })
})

describe('hudPlacement — the expanded panel stays on screen', () => {
  const inside = (p: { panelLeft: number; panelWidth: number }, width: number): boolean =>
    p.panelLeft >= 0 && p.panelLeft + p.panelWidth <= width

  it('opens flush with the margin on the left, and ends at the margin on the right', () => {
    expect(hudPlacement(place({ align: 'left' })).panelLeft).toBe(HUD_EDGE_MARGIN)
    expect(hudPlacement(place({ align: 'right' })).panelLeft).toBe(1710 - HUD_EDGE_MARGIN - HUD_PANEL_WIDTH)
  })

  it.each<NotchAlign>(['left', 'center', 'right'])('is fully visible at %s on every display width we ship to', (align) => {
    for (const width of [1024, 1280, 1440, 1512, 1710, 1728, 2560, 3008]) {
      const p = hudPlacement(place({ align, width, notchCenterX: Math.round(width / 2) }))
      expect(inside(p, width), `${align} @ ${width}`).toBe(true)
      expect(inside(hudPlacement(place({ align, width, notchCenterX: Math.round(width / 2), hasNotch: false })), width)).toBe(true)
    }
  })

  it('on a display narrower than the panel plus its margin, hugs the CHOSEN edge rather than running off it', () => {
    const width = HUD_PANEL_WIDTH + 10
    // A bare clamp would have dropped the margin on the far side (left panel flush RIGHT).
    expect(hudPlacement(place({ align: 'left', width, notchCenterX: 205 })).panelLeft).toBe(0)
    expect(hudPlacement(place({ align: 'right', width, notchCenterX: 205 })).panelLeft).toBe(10)
    // Narrower than the panel itself: still on screen at 0, never negative.
    expect(hudPlacement(place({ align: 'right', width: 300, notchCenterX: 150 })).panelLeft).toBe(0)
    expect(hudPlacement(place({ align: 'center', width: 300, notchCenterX: 150 })).panelLeft).toBe(0)
  })
})

// ---- T227: the bottom-right dock ----------------------------------------------------------

/** The dock is about the WORK AREA, so every case here names one explicitly — including a Dock-sized
 *  inset at the bottom and an offset menu bar, which is what the layout must dodge. */
function docked(over: Partial<HudGeometryInput> = {}): HudGeometryInput {
  return {
    bounds: { x: 0, y: 0, width: 1710, height: 1112 },
    // A 37 px menu bar above and a 90 px Dock below: `workArea` is what keeps us off both.
    workArea: { x: 0, y: 37, width: 1710, height: 1112 - 37 - 90 },
    internal: true,
    notchWidth: 168,
    offsetY: 0,
    align: 'bottom-right',
    ...over
  }
}

const insideRect = (inner: Rect, outer: Rect): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height

describe('hudGeometry — the bottom-right dock (T227)', () => {
  it('is a small box in the WORK AREA’s corner, never a full-width top strip', () => {
    const g = hudGeometry(docked())
    expect(g.docked).toBe(true)
    expect(g.width).toBe(HUD_DOCK_WINDOW_WIDTH)
    // T244: taller than the top strip's own window, by exactly the avoidance inset — the raised
    // capsule must not be allowed to cost the panel its budget.
    expect(g.height).toBe(HUD_DOCK_WINDOW_HEIGHT_BOTTOM_RIGHT)
    expect(HUD_DOCK_WINDOW_HEIGHT_BOTTOM_RIGHT).toBe(
      HUD_WINDOW_HEIGHT + (HUD_BOTTOM_RIGHT_INSET - HUD_EDGE_MARGIN)
    )
    // Right/bottom edges flush with the work area's — the Dock and the menu bar are dodged by using
    // `workArea` at all, which is the load-bearing part: `bounds` would put us UNDER the Dock.
    expect(g.x + g.width).toBe(1710)
    expect(g.y + g.height).toBe(37 + 985)
    expect(g.x).toBe(1710 - HUD_DOCK_WINDOW_WIDTH)
    // The window top stays inside the work area even at the taller height.
    expect(g.y).toBeGreaterThanOrEqual(37)
    // The top strip is still reported (the renderer draws the same mascots) but is not used.
    expect(g.bar).toBe(37)
    expect(g.hasNotch).toBe(true)
  })

  it('stays inside the work area on every display we ship to, Dock or no Dock', () => {
    for (const [w, h, bar, dock] of [
      [1710, 1112, 37, 90],
      [1440, 932, 31, 0],
      [1024, 768, 24, 60],
      [1280, 800, 24, 0]
    ] as const) {
      const input = docked({
        bounds: { x: 0, y: 0, width: w, height: h },
        workArea: { x: 0, y: bar, width: w, height: h - bar - dock }
      })
      const g = hudGeometry(input)
      expect(insideRect(g, input.workArea), `${w}x${h} dock ${dock}`).toBe(true)
    }
  })

  it('never exceeds a SHORT work area (a small window, so the panel is bounded rather than clipped)', () => {
    const g = hudGeometry(docked({ workArea: { x: 0, y: 24, width: 900, height: 300 } }))
    // The height gives way (300 < 634); the width does not, because a 900-wide work area has room
    // for the standard box and the panel needs its own width to stay legible.
    expect(g.height).toBe(300)
    expect(g.width).toBe(HUD_DOCK_WINDOW_WIDTH)
    expect(g.y).toBe(24)
    expect(g.y + g.height).toBe(324)
  })

  it('follows a work area that is not at the origin, and one on a second display', () => {
    const g = hudGeometry(
      docked({ workArea: { x: -1710, y: 37, width: 1710, height: 985 } })
    )
    expect(g.x).toBe(-HUD_DOCK_WINDOW_WIDTH)
    expect(g.x + g.width).toBe(0)
  })

  it('ignores the vertical offset — the corner is the position, so the window never grows for one', () => {
    // The top-strip layout grows the window by a downward offset so a lowered panel is not clipped.
    // There is nothing below the dock's resting place to lower it into, and the spec pins the capsule
    // to the minimap ledge (`HUD_BOTTOM_RIGHT_INSET`) above the work area's bottom edge.
    const base = hudGeometry(docked())
    const lowered = hudGeometry(docked({ offsetY: 200 }))
    expect({ x: lowered.x, y: lowered.y, width: lowered.width, height: lowered.height }).toEqual({
      x: base.x,
      y: base.y,
      width: base.width,
      height: base.height
    })
  })

  it('is opt-in: omitting the side is the top strip, bit-for-bit what this function always returned', () => {
    // Every existing caller/test constructs an input without `align`; nothing about those may move.
    const { align: _drop, ...noAlign } = docked()
    const g = hudGeometry(noAlign)
    expect(g.docked).toBe(false)
    expect({ x: g.x, y: g.y, width: g.width }).toEqual({ x: 0, y: 0, width: 1710 })
    expect(g.height).toBe(37 + HUD_WINDOW_HEIGHT)
  })
})

describe('hudPlacement — the bottom-right dock (T227)', () => {
  /** The dock's own window, as `hudGeometry` reports it. */
  const dockPlace = (over: Partial<HudPlacementInput> = {}): HudPlacementInput => ({
    width: HUD_DOCK_WINDOW_WIDTH,
    height: HUD_DOCK_WINDOW_HEIGHT_BOTTOM_RIGHT,
    bar: 37,
    notchWidth: 168,
    notchCenterX: 855,
    hasNotch: true,
    align: 'bottom-right',
    offsetY: 0,
    ...over
  })

  it('is NEVER fused, even on a notched display at a raised offset', () => {
    // `center` + notch + offset ≤ 0 is the fused layout; `bottom-right` must not reach it however
    // the other inputs are set — a square-cornered capsule fused to a notch a screen away is the
    // "black box below the menu bar" bug one step further out.
    for (const offsetY of [-48, 0, 40]) {
      const p = hudPlacement(dockPlace({ offsetY }))
      expect(p.fused, `offsetY ${offsetY}`).toBe(false)
      expect(p.docked).toBe(true)
    }
    expect(hudPlacement(dockPlace({ hasNotch: false })).fused).toBe(false)
  })

  it('hangs by its BOTTOM edge, ABOVE the minimap: HUD_BOTTOM_RIGHT_INSET up, HUD_EDGE_MARGIN in', () => {
    const p = hudPlacement(dockPlace())
    expect(p.anchor).toBe('right')
    expect(p.capsuleX).toBe(HUD_DOCK_WINDOW_WIDTH - HUD_EDGE_MARGIN)
    // T243: the corner's lower reaches belong to the canvas minimap, so the bottom inset is the
    // minimap's footprint + clearance, no longer the edge margin.
    expect(p.capsuleBottom).toBe(HUD_BOTTOM_RIGHT_INSET)
    // `capsuleTop` is meaningless while docked (the renderer uses --capsule-bottom); pinned at 0 so
    // a stale reader cannot position it by a leftover number.
    expect(p.capsuleTop).toBe(0)
    // In display coordinates: the pill's right edge is HUD_EDGE_MARGIN from the work area's; its
    // bottom edge is the inset above the work area's.
    const g = hudGeometry(docked())
    expect(g.x + p.capsuleX).toBe(g.x + g.width - HUD_EDGE_MARGIN)
    expect(g.y + g.height - p.capsuleBottom!).toBe(g.y + g.height - HUD_BOTTOM_RIGHT_INSET)
  })

  it('THE RELATION — the capsule lands on a ledge above the minimap, with the stated clearance', () => {
    // Not a magic number: the inset must clear the minimap's own footprint (its dock margin, its
    // declared height, the dock's 1px borders) by HUD_DOCK_CLEARANCE. If any of those grows, this
    // fails until somebody decides what to do about it — the capsule may not slide back under the
    // map unnoticed.
    expect(HUD_BOTTOM_RIGHT_INSET).toBeGreaterThanOrEqual(
      CANVAS_MINIMAP_MARGIN + CANVAS_MINIMAP_HEIGHT + HUD_DOCK_CLEARANCE
    )
    // …and the placement uses it, so the ledge is real, not a constant only tests know.
    expect(hudPlacement(dockPlace()).capsuleBottom).toBe(HUD_BOTTOM_RIGHT_INSET)
  })

  it('grows the panel UP and LEFT: its right edge is the capsule’s, inside the window', () => {
    const p = hudPlacement(dockPlace())
    expect(p.panelWidth).toBe(HUD_PANEL_WIDTH)
    // Equal margins on both sides of the window — the panel's right edge IS the capsule's right edge.
    expect(p.panelLeft).toBe(HUD_EDGE_MARGIN)
    expect(p.panelLeft + p.panelWidth).toBe(p.capsuleX)
    expect(p.panelLeft).toBeGreaterThanOrEqual(0)
  })

  it('bounds the expanded panel by the WINDOW above the capsule, so it can never leave the work area', () => {
    const p = hudPlacement(dockPlace())
    // T244: the window grew by the avoidance inset (634 = 460 + 174), so the room above the
    // capsule — `height - HUD_BOTTOM_RIGHT_INSET - HUD_DOCK_TOP_GAP` — is 436 again, what the
    // top-strip layout gives. The formula is unchanged from T243; only the height it divides is new.
    expect(p.expandedMaxHeight).toBe(
      HUD_DOCK_WINDOW_HEIGHT_BOTTOM_RIGHT - HUD_BOTTOM_RIGHT_INSET - HUD_DOCK_TOP_GAP
    )
    expect(p.expandedMaxHeight).toBe(436)
    // THE INVARIANT — the panel budget is alignment-independent: whatever the inset is, the panel
    // plus the capsule's ledge always spends the window minus the top gap.
    expect(p.expandedMaxHeight! + p.capsuleBottom!).toBe(
      HUD_DOCK_WINDOW_HEIGHT_BOTTOM_RIGHT - HUD_DOCK_TOP_GAP
    )
    expect(p.capsuleBottom! + p.expandedMaxHeight!).toBeLessThanOrEqual(
      HUD_DOCK_WINDOW_HEIGHT_BOTTOM_RIGHT
    )
    // THE EQUIVALENCE — the same budget the top-strip layout's expanded box has
    // (`HUD_WINDOW_HEIGHT` less its two edge margins), so no alignment is second-class.
    expect(p.expandedMaxHeight).toBe(HUD_WINDOW_HEIGHT - 2 * HUD_EDGE_MARGIN)
    // THE PANEL DOES NOT SCROLL at full rows: a row is 47px tall (`.hud-row` padding 7/8), rows
    // are separated by a 3px hairline, and the panel caps at 6 rows → 6×47 + 5×3 = 297px of rows;
    // the panel's own padding takes 18 (CSS `.dock-bottom-right .hud-panel`), so the usable height
    // must hold the full stack.
    expect(p.expandedMaxHeight! - 18).toBeGreaterThanOrEqual(297)
  })

  it('T244 — a work area of 700 fits the taller window whole, with the top edge inside', () => {
    // The nail's "短 work area 也不溢出" at the height the butler named: 634 < 700, so the window
    // keeps its full height and its top edge (700 - 634 above the bottom) is inside the work area.
    const g = hudGeometry(docked({ workArea: { x: 0, y: 24, width: 900, height: 700 } }))
    expect(g.height).toBe(HUD_DOCK_WINDOW_HEIGHT_BOTTOM_RIGHT)
    expect(g.y).toBe(24 + 700 - HUD_DOCK_WINDOW_HEIGHT_BOTTOM_RIGHT)
    expect(g.y).toBeGreaterThanOrEqual(24)
    const p = hudPlacement(dockPlace({ width: g.width, height: g.height, hasNotch: false, bar: 24 }))
    expect(p.expandedMaxHeight).toBe(
      HUD_DOCK_WINDOW_HEIGHT_BOTTOM_RIGHT - HUD_BOTTOM_RIGHT_INSET - HUD_DOCK_TOP_GAP
    )
    expect(p.expandedMaxHeight!).toBeGreaterThanOrEqual(0)
  })

  it('T244 — the butler’s nail, verbatim: work area 960 → window 634, ledge 186, budget 436', () => {
    const g = hudGeometry(docked({ workArea: { x: 0, y: 30, width: 1728, height: 960 } }))
    expect(g.height).toBe(634)
    expect(g.y).toBe(30 + 960 - 634)
    expect(g.y).toBeGreaterThanOrEqual(30)
    const p = hudPlacement(dockPlace({ width: g.width, height: g.height, hasNotch: false, bar: 30 }))
    expect(g.height).toBe(HUD_DOCK_WINDOW_HEIGHT_BOTTOM_RIGHT)
    expect(p.capsuleBottom).toBe(186)
    expect(p.expandedMaxHeight).toBe(436)
  })

  it('in a SHORT work area the panel is shortened, never allowed to overflow', () => {
    // The nail's "矮工作区先向上顶而不是溢出": the window is as tall as the work area allows, and the
    // panel gets exactly the room left above the capsule — the growth is clamped instead of the
    // panel hanging off the top of the screen (or out of the window, which is inside the work area).
    const g = hudGeometry(docked({ workArea: { x: 0, y: 24, width: 900, height: 300 } }))
    const p = hudPlacement(dockPlace({ width: g.width, height: g.height, hasNotch: false, bar: 24 }))
    expect(g.height).toBe(300)
    expect(p.expandedMaxHeight).toBe(300 - HUD_BOTTOM_RIGHT_INSET - HUD_DOCK_TOP_GAP)
    const topOfExpandedBox = g.height - p.capsuleBottom! - p.expandedMaxHeight!
    expect(topOfExpandedBox).toBe(HUD_DOCK_TOP_GAP)
    // Window coordinates: the expanded box fits the WINDOW with the top gap to spare, and the window
    // itself is inside the work area (asserted above), so the panel cannot leave the work area.
    expect(
      insideRect(
        { x: p.panelLeft, y: topOfExpandedBox, width: p.panelWidth, height: p.expandedMaxHeight! },
        { x: 0, y: 0, width: g.width, height: g.height }
      )
    ).toBe(true)
    // Even a work area shorter than the margin + gap yields a non-negative room, not a negative one.
    expect(hudPlacement(dockPlace({ height: 10 })).expandedMaxHeight).toBe(0)
  })

  it('a window narrower than a panel keeps the panel on screen (never negative, never off the right)', () => {
    const p = hudPlacement(dockPlace({ width: 300 }))
    expect(p.panelLeft).toBe(0)
    expect(p.panelLeft + p.panelWidth).toBeGreaterThan(300)
    // …but the real window is a panel plus two margins, so this is the degenerate case only.
    expect(hudPlacement(dockPlace()).panelLeft).toBe(HUD_EDGE_MARGIN)
  })

  it('leaves the three upstream sides bit-for-bit alone (no dock fields leak into them)', () => {
    for (const align of ['left', 'center', 'right'] as const) {
      const p = hudPlacement(place({ align }))
      expect(p.docked).toBeUndefined()
      expect(p.capsuleBottom).toBeUndefined()
      expect(p.expandedMaxHeight).toBeUndefined()
    }
  })
})
