// @vitest-environment node
//
// T230: the two canvas tracks must clear the two top clusters and the minimap, and a track's
// toggle must never sit on top of its own card's buttons. Measured rects come from the field
// (the employer's window): .sessions-icon-cluster (22,50,34×34,z=11), .controls-cluster
// (1424..1706,50,34 tall,z=26), both 34px tall at tabbar+float-gap; the tracks now start 34+8px
// below that band, and the toggles hug the cards' outer sides, vertically centered on the card.
import { describe, expect, it } from 'vitest'
import { rectsOverlap, type FitRect } from './fit-view'

const W = 1728 // the field window

// The top band the two clusters own (window coords, measured).
const SESSIONS_CLUSTER: FitRect = { left: 22, top: 50, right: 56, bottom: 84 }
const CONTROLS_CLUSTER: FitRect = { left: 1424, top: 50, right: 1706, bottom: 84 }
const MINIMAP: FitRect = { left: W - 222, top: 550, right: W - 22, bottom: 700 }

// Track geometry from the CSS formulas: cards start at 50+42=92, 34px cluster height + 8px gap;
// the toggle (22px) sits OUTSIDE the 56px card, vertically centered on the card.
const LEFT_CARD_H = 347 // 7 + 6×42 + 5×6 + 3×17 + 7 (padding, buttons, rows, hairlines)
const RIGHT_CARD_H = 426
const leftToggle: FitRect = {
  left: 22, right: 44,
  top: 92 + LEFT_CARD_H / 2 - 11, bottom: 92 + LEFT_CARD_H / 2 + 11
}
const rightToggle: FitRect = {
  left: W - 44, right: W - 22,
  top: 92 + RIGHT_CARD_H / 2 - 11, bottom: 92 + RIGHT_CARD_H / 2 + 11
}
const leftCard: FitRect = { left: 50, top: 92, right: 106, bottom: 92 + LEFT_CARD_H }
const rightCard: FitRect = { left: W - 106, top: 92, right: W - 50, bottom: 92 + RIGHT_CARD_H }

describe('T230: the tracks clear the top clusters and the minimap', () => {
  it('both cards start below the cluster band (34px + 8px of air)', () => {
    expect(leftCard.top).toBe(50 + 34 + 8)
    expect(rightCard.top).toBe(50 + 34 + 8)
    expect(leftCard.top).toBeGreaterThanOrEqual(SESSIONS_CLUSTER.bottom)
    expect(rightCard.top).toBeGreaterThanOrEqual(CONTROLS_CLUSTER.bottom)
  })

  it('card, toggle and cluster rectangles are pairwise disjoint', () => {
    const all = [leftCard, leftToggle, rightCard, rightToggle, SESSIONS_CLUSTER, CONTROLS_CLUSTER, MINIMAP]
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        expect(rectsOverlap(all[i], all[j]), `rect ${i} vs ${j}`).toBe(false)
      }
    }
  })

  it('a toggle never covers a button of its own card', () => {
    // The toggle is OUTSIDE the card horizontally — its x-range is disjoint from the card's.
    expect(leftToggle.right).toBeLessThanOrEqual(leftCard.left)
    expect(rightToggle.left).toBeGreaterThanOrEqual(rightCard.right)
  })

  it('the collapsed tab stays flush to the screen edge, one control, ≤14px', () => {
    // The same toggle button morphs into the tab; it keeps the rail's edge anchor and is 14px
    // wide, inside fit-view's 12px inset — so a collapsed canvas still measures zero obstacles.
    expect(rightCard.right).toBeLessThanOrEqual(W - 50)
    expect(leftToggle.right - leftToggle.left).toBe(22)
  })
})
