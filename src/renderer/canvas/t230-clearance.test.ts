// @vitest-environment node
//
// T230/T232: the two canvas tracks must clear the two top clusters and the minimap; the collapse
// control is the card's FIRST ROW, in the same family as .dock-btn (42×42, x aligned with the
// buttons), and the collapsed tab stays at its own row's height instead of jumping to the canvas
// center. Measured rects come from the field (the employer's CDP window, 1728×960): the clusters
// are 34px tall at tabbar+float-gap; the tracks start 34+8px below; the card is 56px wide at the
// cluster-band's edge (left 22, right W-22).
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { rectsOverlap, type FitRect } from './fit-view'

const CANVAS_SRC = fs.readFileSync(path.join(__dirname, 'Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')
const STYLES_SRC = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8').replace(/\r\n/g, '\n')

const W = 1728 // the field window

// The top band the two clusters own (window coords, measured).
const SESSIONS_CLUSTER: FitRect = { left: 22, top: 50, right: 56, bottom: 84 }
const CONTROLS_CLUSTER: FitRect = { left: 1424, top: 50, right: 1706, bottom: 84 }
// The minimap is 200×150 at the bottom-right corner, --float-gap from the edges (pane ≈932 tall).
const MINIMAP: FitRect = { left: W - 222, top: 760, right: W - 22, bottom: 910 }

// T232 geometry: cards start at 92 (= 50 + 34 + 8); the toggle is the first ROW inside the card,
// 42×42 at x = card.left + 7 (the card's 7px padding), so it shares .dock-btn's column.
const LEFT_CARD_H = 415 // 7 + 42 + 6 + 6×42 + 5×6 + 3×17 + 7
const RIGHT_CARD_H = 470
const leftCard: FitRect = { left: 22, top: 92, right: 78, bottom: 92 + LEFT_CARD_H }
const rightCard: FitRect = { left: W - 78, top: 92, right: W - 22, bottom: 92 + RIGHT_CARD_H }
const leftToggle: FitRect = { left: 29, top: 99, right: 71, bottom: 141 }
const rightToggle: FitRect = { left: W - 71, top: 99, right: W - 29, bottom: 141 }

describe('T232: the tracks clear the top clusters and the minimap', () => {
  it('both cards start below the cluster band (34px + 8px of air)', () => {
    expect(leftCard.top).toBe(50 + 34 + 8)
    expect(rightCard.top).toBe(50 + 34 + 8)
    expect(leftCard.top).toBeGreaterThanOrEqual(SESSIONS_CLUSTER.bottom)
    expect(rightCard.top).toBeGreaterThanOrEqual(CONTROLS_CLUSTER.bottom)
  })

  it('cards, clusters and minimap are pairwise disjoint', () => {
    const all = [leftCard, rightCard, SESSIONS_CLUSTER, CONTROLS_CLUSTER, MINIMAP]
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        expect(rectsOverlap(all[i], all[j]), `rect ${i} vs ${j}`).toBe(false)
      }
    }
  })

  it('each toggle lives inside its own card and clears the other card and the clusters', () => {
    for (const [card, toggle] of [
      [leftCard, leftToggle],
      [rightCard, rightToggle]
    ] as const) {
      expect(rectsOverlap(toggle, card)).toBe(true) // it IS the card's first row
      expect(toggle.left).toBeGreaterThanOrEqual(card.left)
      expect(toggle.right).toBeLessThanOrEqual(card.right)
      for (const other of [SESSIONS_CLUSTER, CONTROLS_CLUSTER, MINIMAP]) {
        expect(rectsOverlap(toggle, other), 'toggle vs cluster/minimap').toBe(false)
      }
    }
  })

  it('the container holds ONLY the card, 56px wide, outer edge == cluster edge', () => {
    expect(STYLES_SRC).toMatch(/\.canvas-rail \{[\s\S]*?width: 56px;/)
    expect(STYLES_SRC).toMatch(/\.canvas-rail \{[\s\S]*?flex-direction: column;/)
    // The card sits at the cluster band's edge: left card's left == the sessions cluster's left,
    // right card's right == the controls cluster's right.
    expect(leftCard.left).toBe(SESSIONS_CLUSTER.left)
    expect(rightCard.right).toBe(CONTROLS_CLUSTER.right)
    expect(leftCard.right - leftCard.left).toBe(56)
  })

  it('the collapse control is the card\u2019s first row, in the .dock-btn column (42×42, same x and width)', () => {
    // JSX: the toggle is the body's FIRST child (children[0]) in both rails — it sits right
    // after the body's opening tag, before the Dock.
    const bodies = CANVAS_SRC.split('data-canvas-chrome={railCollapsed ? undefined : \'\'}>')
    expect(bodies.length).toBeGreaterThanOrEqual(3)
    expect(bodies[1]).toMatch(/^\s*<button\b[\s\S]*?className="canvas-rail__toggle[^"]*"/)
    expect(bodies[2]).toMatch(/^\s*<button\b[\s\S]*?className="canvas-rail__toggle[^"]*"/)
    // CSS: 42×42 at the card's 7px padding, radius 10 — same family as .dock-btn.
    expect(STYLES_SRC).toMatch(/\.canvas-rail__toggle \{[^}]*width: 42px;[^}]*height: 42px;[^}]*border-radius: 10px;/)
    expect(STYLES_SRC).toMatch(/\.canvas-rail__toggle:hover:not\(:disabled\) \{[^}]*background: var\(--panel-header\);/)
    // Same column as .dock-btn: same x (card.left + 7) and same width (42).
    expect(leftToggle.left).toBe(leftCard.left + 7)
    expect(leftToggle.right - leftToggle.left).toBe(42)
    expect(rightToggle.left).toBe(rightCard.left + 7)
  })

  it('the collapsed tab stays at its own row\u2019s height — no jump to the canvas center', () => {
    // The container keeps its top (no top:50% + translateY); the card becomes the 14×56 tab with
    // every other child hidden.
    expect(STYLES_SRC).not.toMatch(/\.canvas-root\[data-rail-collapsed\] \.canvas-rail \{[^}]*top: 50%/)
    expect(STYLES_SRC).toMatch(/\.canvas-root\[data-rail-collapsed\] \.canvas-rail__body > :not\(\.canvas-rail__toggle\)[\s\S]*?display: none;/)
    expect(STYLES_SRC).toMatch(/\.canvas-root\[data-rail-collapsed\] \.canvas-rail__body \{[^}]*width: 14px;[^}]*height: 56px;[^}]*padding: 0;/)
    // Expanded toggle center == collapsed tab center (card.top + 7 + 21 == card.top + 28).
    expect(leftToggle.top + 21).toBe(leftCard.top + 28)
    expect(rightToggle.top + 21).toBe(rightCard.top + 28)
    // Fit still sees ZERO obstacles: the card's data-canvas-chrome is dropped when collapsed.
    expect(CANVAS_SRC).toContain('data-canvas-chrome={railCollapsed ? undefined : \'\'}')
  })
})
