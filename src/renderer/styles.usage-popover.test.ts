import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Guard on the account usage popover's overflow behaviour (issue #503).
 *
 * The panel had no `max-height` and no scroll, so once about four accounts were present it grew
 * taller than the window: the FIRST account's header and Session meter were clipped off the top
 * with no way to reach them, and the last was squeezed against the status bar. Removing the
 * account was the only workaround.
 *
 * The fix is structural, not cosmetic, and every part of it is load-bearing:
 *  - the popover is capped and is a flex COLUMN, so the heading stays put;
 *  - `__body` is the scroll container, and needs `min-height: 0` or a flex child refuses to
 *    shrink below its content height and the cap does nothing.
 *
 * The "Switch Claude account…" button used to be a fixed footer OUTSIDE `__body`. Issue #912 moved
 * it into the Claude / System block it acts on: as a footer it sat under whichever provider was
 * listed last and read as that provider's action. That block is always first, so it scrolls with
 * the account it belongs to rather than away from it.
 *
 * None of that renders in CI, and all of it is one "simplification" away from being undone.
 */

const CSS = readFileSync(join(__dirname, 'styles.css'), 'utf8')
const TSX = readFileSync(join(__dirname, 'components/UsageIndicator.tsx'), 'utf8')

/** The declaration body of the rule whose selector list is EXACTLY `selector`. */
function ruleBody(selector: string): string {
  for (const chunk of CSS.split('}')) {
    const brace = chunk.indexOf('{')
    if (brace < 0) continue
    const head = chunk
      .slice(0, brace)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(',')
      .map((sel) => sel.trim())
      .filter(Boolean)
      .join(',')
    // Comments are stripped from the body too: they legitimately NAME the properties they
    // explain, and a `not.toMatch` would then answer about the prose instead of the rule.
    if (head === selector) return chunk.slice(brace + 1).replace(/\/\*[\s\S]*?\*\//g, '')
  }
  throw new Error(`no rule for selector "${selector}"`)
}

describe('.usage-popover is bounded and scrolls (issue #503)', () => {
  it('caps its height so it can never grow past the window', () => {
    const body = ruleBody('.usage-popover')
    expect(body).toMatch(/max-height:\s*calc\(100vh/)
  })

  it('is a flex column, so the heading and footer can be held out of the scroll', () => {
    const body = ruleBody('.usage-popover')
    expect(body).toMatch(/display:\s*flex/)
    expect(body).toMatch(/flex-direction:\s*column/)
  })

  it('scrolls the account list rather than truncating it', () => {
    const body = ruleBody('.usage-popover__body')
    expect(body).toMatch(/overflow-y:\s*auto/)
    // Without min-height: 0 a flex child will not shrink below its content, and the cap above
    // becomes decorative.
    expect(body).toMatch(/min-height:\s*0/)
    // A max-height here would be a silent truncation — the panel must show every account.
    expect(body).not.toMatch(/max-height/)
  })

  it('holds the heading out of the scrolling area', () => {
    expect(ruleBody('.usage-popover__head')).toMatch(/flex:\s*none/)
  })
})

/**
 * Guard on WHERE the panel opens (T246).
 *
 * It opened at (1657,499) and grew RIGHTWARD 280px from the badge circle's left edge: measured on the
 * live app in a 1728-wide window that is a right edge of 1937, i.e. 209px off the window, with the
 * account list cut in half by the screen edge. Every other overlay on this rail opens leftward
 * (T223/T229: `.dock-menu { right: calc(100% + 10px) }`), so the fix is that same anchor — with the
 * rail card's 7px inset added, or the panel would end up only 3px clear of the card.
 *
 * Both bounds are constants relative to the window's right edge, so they hold at every window width:
 * the panel's right edge is `W - floatGap - railW + inset - gap`, the card's left edge is
 * `W - floatGap - railW`, and the T223 bound is `W - floatGap`.
 */
describe('.usage-popover opens into the window and clear of the rail card (T246)', () => {
  /** The px an edge-gap/inset declaration asks for, e.g. `right: calc(100% + 17px)` → 17. */
  function pxAfterDoubleColon(selector: string, prop: string): number {
    const m = new RegExp(`${prop}:\\s*calc\\([^)]*\\+\\s*(\\d+)px\\)`).exec(ruleBody(selector))
    if (!m) throw new Error(`no calc(+Npx) for ${prop} in ${selector}`)
    return Number(m[1])
  }

  it('anchors its RIGHT edge to the rail instead of growing rightward from the circle', () => {
    const body = ruleBody('.usage-popover')
    expect(body).toMatch(/right:\s*calc\(100% \+ \d+px\)/)
    expect(body).toMatch(/left:\s*auto/)
    // `left: 0` is the defect itself: a 280px box starting at the 42px circle's left edge.
    expect(body).not.toMatch(/left:\s*0[;\s]/)
  })

  it('gaps the panel from the CARD by the same 10px the rail menus keep', () => {
    // The circle is 7px inside the card (`.canvas-rail__body` 1px border + 6px padding), and the
    // popover's containing block is that circle — so a bare 10px would leave 3px of air.
    const railBody = ruleBody('.canvas-rail__body')
    const padX = /padding:\s*\d+px\s+(\d+)px/.exec(railBody)
    const border = /border:\s*(\d+)px/.exec(railBody)
    expect(padX, '.canvas-rail__body padding shorthand').toBeTruthy()
    expect(border, '.canvas-rail__body border shorthand').toBeTruthy()
    const inset = Number(padX![1]) + Number(border![1])
    expect(inset).toBe(7)
    expect(pxAfterDoubleColon('.usage-popover', 'right') - inset).toBe(10)
  })

  it('stays inside the window and off the card at any window width', () => {
    const floatGap = Number(/--float-gap:\s*(\d+)px/.exec(CSS)![1])
    const railW = Number(/^\.canvas-rail \{[\s\S]*?width:\s*(\d+)px/m.exec(CSS)![1])
    const inset = 7 // pinned by the test above, from the rail body's own declarations
    const gap = pxAfterDoubleColon('.usage-popover', 'right')
    // One arbitrary-but-real window width; the offsets below are what make it hold for ALL widths.
    for (const windowWidth of [1728, 1280, 2560, 900]) {
      const cardLeft = windowWidth - floatGap - railW
      const panelRight = cardLeft + inset - gap
      expect(panelRight).toBeLessThanOrEqual(windowWidth - floatGap) // nail 1 (T223 bound)
      expect(panelRight).toBeLessThanOrEqual(cardLeft) // nail 2: no intersection with the card
      expect(cardLeft - panelRight).toBe(10)
    }
  })
})

describe('UsageIndicator keeps the switch action with the account it switches (issue #912)', () => {
  it('opens __body after the head and renders the switch action inside it, not as a footer', () => {
    const head = TSX.indexOf('className="usage-popover__head"')
    const bodyOpen = TSX.indexOf('className="usage-popover__body"')
    expect(head).toBeGreaterThan(-1)
    expect(bodyOpen).toBeGreaterThan(head)
    // Rendered by the Claude block and the System account row, both inside __body.
    const uses = [...TSX.matchAll(/switchAction\}/g)].map((m) => m.index ?? -1)
    expect(uses.length).toBeGreaterThanOrEqual(2)
    for (const at of uses) expect(at).toBeGreaterThan(bodyOpen)
  })
})
