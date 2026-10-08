// @vitest-environment node
//
// T235 (after T230/T232): EVERY canvas-level control lives in one of the two rails, and the rails
// sit on the row the two top clusters used to occupy. The clusters themselves are gone. These pins
// hold the geometry the employer measures with CDP: the rails' top row, their outer edges, the
// sidebar yielding to the left rail (instead of pushing it), the resume card clearing the right
// rail, the 42×42 .dock-btn column the moved buttons joined, and the collapsed tab.
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { CANVAS_CHROME_SELECTOR, rectsOverlap, type FitRect } from './fit-view'

const CANVAS_SRC = fs.readFileSync(path.join(__dirname, 'Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')
const STYLES_SRC = fs
  .readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8')
  .replace(/\r\n/g, '\n')

const W = 1728 // the field window
const TABBAR_H = 28
const FLOAT_GAP = 22
const CLUSTER_ROW = TABBAR_H + FLOAT_GAP // 50 — where the (now removed) clusters sat

// The two rails, flush with the float gap on their outer edge and 56px wide.
const leftRail: FitRect = { left: FLOAT_GAP, top: CLUSTER_ROW, right: FLOAT_GAP + 56, bottom: 680 }
const rightRail: FitRect = { left: W - 22 - 56, top: CLUSTER_ROW, right: W - 22, bottom: 690 }
// The sessions sidebar now yields to the rail: left = rail right edge + one more float gap.
const sidebar: FitRect = { left: FLOAT_GAP + 56 + FLOAT_GAP, top: CLUSTER_ROW, right: 400, bottom: 900 }
// The resume card clears the right rail card by 8px.
const resumeCard: FitRect = { left: W - (FLOAT_GAP + 56 + 8) - 260, top: CLUSTER_ROW, right: W - (FLOAT_GAP + 56 + 8), bottom: 200 }

describe('T235: the rails own all canvas chrome', () => {
  it('the two former clusters are gone from markup, CSS and the fit obstacle list', () => {
    for (const cls of ['sessions-icon-cluster', 'controls-cluster']) {
      // No element carries the class…
      expect(CANVAS_SRC).not.toContain(`className="${cls}"`)
      // …no rule targets it…
      expect(STYLES_SRC).not.toContain(`.${cls}`)
      // …and fit no longer reserves a rect for it.
      expect(CANVAS_CHROME_SELECTOR).not.toContain(cls)
    }
    // The T230 token that described that band went with them: no declaration and no reader.
    expect(STYLES_SRC).not.toMatch(/--top-cluster-band\s*:/)
    expect(STYLES_SRC).not.toContain('var(--top-cluster-band)')
  })

  it('both rails sit on the old cluster row and hold only their 56px card', () => {
    // Container: 56px single column (T232), no extra chrome, positioned on the cluster row.
    expect(STYLES_SRC).toMatch(/\.canvas-rail \{[\s\S]*?width: 56px;/)
    expect(STYLES_SRC).toMatch(/\.canvas-rail \{[\s\S]*?flex-direction: column;/)
    expect(STYLES_SRC).toMatch(/\.canvas-rail \{[\s\S]*?top: var\(--float-gap\);/)
    // Window y 50 = tabbar + float gap, i.e. the row the clusters occupied.
    expect(leftRail.top).toBe(CLUSTER_ROW)
    expect(leftRail.top).toBe(TABBAR_H + FLOAT_GAP)
    expect(rightRail.top).toBe(leftRail.top)
  })

  it('each rail card is flush with its float gap on the outer edge', () => {
    expect(leftRail.left).toBe(FLOAT_GAP)
    expect(rightRail.right).toBe(W - FLOAT_GAP)
    expect(leftRail.right - leftRail.left).toBe(56)
  })

  it('the cards, the sidebar and the resume card are pairwise disjoint', () => {
    for (const [i, a] of [leftRail, rightRail, sidebar, resumeCard].entries()) {
      for (const [j, b] of [leftRail, rightRail, sidebar, resumeCard].entries()) {
        if (i >= j) continue
        expect(rectsOverlap(a, b), `rect ${i} vs ${j}`).toBe(false)
      }
    }
  })

  it('the sidebar yields to the left rail instead of pushing it', () => {
    // Self-yield, in the sidebar's own rule…
    expect(STYLES_SRC).toMatch(
      /\.sessions-sidebar \{[\s\S]*?left: calc\(var\(--float-gap\) \+ 56px \+ var\(--float-gap\)\);/
    )
    // …and the rule that moved the RAIL when the sidebar opened is gone, so the left rail's x no
    // longer depends on the sidebar (the Sessions trigger now lives inside that rail).
    expect(STYLES_SRC).not.toContain('.canvas-root:has(.sessions-sidebar) .canvas-rail--left')
    expect(STYLES_SRC).toMatch(/\.canvas-rail--left \{\s*left: var\(--float-gap\);\s*\}/)
    // Sidebar left edge == rail right edge + one float gap.
    expect(sidebar.left).toBe(leftRail.right + FLOAT_GAP)
  })

  it('the resume card clears the right rail', () => {
    expect(STYLES_SRC).toMatch(
      /\.resume-card \{[\s\S]*?top: calc\(var\(--tabbar-h\) \+ var\(--float-gap\)\);[\s\S]*?right: calc\(var\(--float-gap\) \+ 56px \+ 8px\);/
    )
    expect(resumeCard.right).toBe(rightRail.left - 8)
  })

  it('the moved buttons are 42×42 and share the .dock-btn column', () => {
    // JSX: seven opt-in buttons live inside the rail bodies as direct `.dock-btn` children —
    // Sessions / Command palette / Explorer / Source Control on the left, Pair phone / Settings /
    // Help on the right (plus the toggle, which is not a .dock-btn).
    const railBodies = CANVAS_SRC.split('data-canvas-chrome={railCollapsed ? undefined : \'\'}>')
    expect(railBodies.length).toBeGreaterThanOrEqual(3)
    expect(railBodies[0]).toContain('canvas-rail canvas-rail--left')
    for (const name of ['Sessions', 'Command palette', 'Explorer', 'Source Control']) {
      expect(railBodies[1], `left rail: ${name}`).toContain(`aria-label="${name}"`)
    }
    for (const name of ['Pair phone', 'Settings', 'Help']) {
      expect(railBodies[2], `right rail: ${name}`).toContain(`aria-label="${name}"`)
    }
    expect(railBodies[1].match(/className="dock-btn"/g) ?? []).toHaveLength(4)
    expect(railBodies[2].match(/className="dock-btn"/g) ?? []).toHaveLength(3)
    expect(CANVAS_SRC).not.toContain('cluster-search')
    // CSS: the moved buttons ARE `.dock-btn` (42×42, radius 10, panel-header hover) — one size
    // family with the Dock's own buttons, no second 34px box.
    expect(STYLES_SRC).toMatch(/\.dock-btn \{[\s\S]*?width: 42px;[\s\S]*?height: 42px;[\s\S]*?border-radius: 10px;/)
    expect(STYLES_SRC).toMatch(/\.dock-btn:hover:not\(:disabled\) \{\s*background: var\(--panel-header\);\s*\}/)
    // The toggle joins that family: no fill, no border.
    expect(STYLES_SRC).toMatch(/\.canvas-rail__toggle \{[\s\S]*?background: transparent;[\s\S]*?border: none;/)
    // The moved-in glyphs keep the 18px the clusters gave them (targeted through the Tooltip's
    // trigger wrapper, so the Dock's own buttons — one level deeper — keep their inline sizes).
    expect(STYLES_SRC).toMatch(
      /\.canvas-rail__body > \.tooltip-trigger > \.dock-btn svg \{[\s\S]*?width: 18px;/
    )
  })

  it('the card keeps its first-row toggle and its scrolling cap', () => {
    expect(STYLES_SRC).toMatch(/\.dock-sep \{[\s\S]*?width: 28px;[\s\S]*?height: 1px;/)
    const railBodies = CANVAS_SRC.split('data-canvas-chrome={railCollapsed ? undefined : \'\'}>')
    expect(railBodies[1]).toMatch(/^\s*<button\b[\s\S]*?className="canvas-rail__toggle/)
    expect(railBodies[2]).toMatch(/^\s*<button\b[\s\S]*?className="canvas-rail__toggle/)
    // Both rails cap their height and scroll inside it (the left one gains 5 rows in T235).
    expect(STYLES_SRC).toMatch(/\.canvas-rail \{[\s\S]*?max-height: calc\(100% - 2 \* var\(--float-gap\)\);/)
    expect(STYLES_SRC).toMatch(/\.canvas-rail--right \{[\s\S]*?max-height: calc\(100% - var\(--float-gap\) - 170px\);/)
    expect(STYLES_SRC).toMatch(/\.canvas-rail__body \{[\s\S]*?overflow-y: auto;/)
  })

  it('the collapsed tab stays at its own row and keeps fit measuring zero', () => {
    expect(STYLES_SRC).not.toMatch(/\.canvas-root\[data-rail-collapsed\] \.canvas-rail \{[^}]*top: 50%/)
    expect(STYLES_SRC).toMatch(
      /\.canvas-root\[data-rail-collapsed\] \.canvas-rail__body \{[^}]*width: 14px;[^}]*height: 56px;[^}]*padding: 0;/
    )
    expect(STYLES_SRC).toMatch(
      /\.canvas-root\[data-rail-collapsed\] \.canvas-rail__body > :not\(\.canvas-rail__toggle\),[\s\S]*?display: none;/
    )
    expect(CANVAS_SRC).toContain('data-canvas-chrome={railCollapsed ? undefined : \'\'}')
  })
})
