// T249: where a rail menu hangs, in viewport coordinates.
//
// Not a component: the pure half of `useRailMenu` in Dock.tsx, so the direction rule can be pinned
// by a plain unit test the way `tooltipAnchor` is. Every number here is measured input — the
// trigger's rect, the menu's own box, the viewport.

/** Gap between the rail card's edge and a menu: the same 10px the menus kept as
 *  `right: calc(100% + 10px)` while they were anchored inside the card (T226/T229). */
export const RAIL_MENU_GAP = 10

/** How close a menu may come to an edge of the window before it slides inward. */
export const MENU_EDGE_MARGIN = 8

/** Which rail the trigger sits in — read from the trigger's own ancestors, never a per-button flag. */
export type RailSide = 'left' | 'right'

/** Viewport coordinates for a portaled rail menu: one horizontal edge, and a top. */
export interface RailMenuPlacement {
  left?: number
  right?: number
  top: number
}

/**
 * A rail menu opens AWAY from the window edge: the right rail anchors the menu by its RIGHT edge,
 * the left rail by its LEFT edge, so a 190px menu hanging off a rail 22px from the edge lands
 * inside the window instead of over the screen edge. This is the rule the removed CSS carried
 * (`.dock-menu { right: calc(100% + 10px) }` plus the `.canvas-rail--left` override), moved here
 * because the menus are now portaled to `document.body`: they are anchored to buttons that live
 * inside the rail card's SCROLL container (`.canvas-rail__body { overflow-y: auto }`, T235's cap on
 * a short pane), and a scroll container clips what it holds — measured on the packaged build, the
 * Add-node menu had a correct rect (87,51 190×574) and zero painted pixels.
 *
 * The vertical follows the trigger's rect (so a column that scrolls under a menu does not leave it
 * pointing at nothing) and is clamped so the menu neither starts above the window nor ends below
 * it; `height` is the menu's own measured height, which is why the clamp needs a second look after
 * the menu has rendered.
 */
export function railMenuPlacement(
  trigger: { left: number; right: number; top: number },
  side: RailSide,
  menu: { width: number; height: number },
  viewport: { width: number; height: number }
): RailMenuPlacement {
  const lowest = Math.max(MENU_EDGE_MARGIN, viewport.height - menu.height - MENU_EDGE_MARGIN)
  const top = Math.round(Math.min(Math.max(trigger.top, MENU_EDGE_MARGIN), lowest))
  return side === 'right'
    ? { right: Math.round(viewport.width - trigger.left + RAIL_MENU_GAP), top }
    : { left: Math.round(trigger.right + RAIL_MENU_GAP), top }
}
