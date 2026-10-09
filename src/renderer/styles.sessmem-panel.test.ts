import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Guard on WHERE the session-memory panel opens (T255).
 *
 * It is the usage panel's twin: same corner, same 42px badge circle to hang from, and it carried the
 * same two era-drifts, so it is pinned the same way.
 *
 *  - `left: 0` anchored it on the 42px circle's LEFT edge and grew RIGHTWARD: measured live at
 *    (1657,214) 380×454 in a 1728-wide window, its right edge landed at 2037 — 309px past the
 *    window, with only the 71px inside the frame painted at all (the App's own frame clip, not the
 *    rail scroller: the panel is really drawn). Every overlay on this rail opens AWAY from the window
 *    edge (T223/T229); this one now does too, at `right: calc(100% + 17px)`.
 *  - `bottom: 34px` was written for the 26px pill T226 replaced with a 42px one (26 + 8 = a clean
 *    8px gap then, 8px of OVERLAP now), so it hangs at 42 + 6 here.
 *
 * Both offsets are constants relative to the card's own edges, so they hold at every window width
 * and every rail height; the arithmetic below derives them from the same CSS literals.
 */

const CSS = readFileSync(join(__dirname, 'styles.css'), 'utf8')

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
    // Comments are stripped from the body too: they legitimately NAME the properties and numbers
    // they explain, and an assertion would otherwise answer about the prose.
    if (head === selector) return chunk.slice(brace + 1).replace(/\/\*[\s\S]*?\*\//g, '')
  }
  throw new Error(`no rule for selector "${selector}"`)
}

/** A plain `prop: Npx` declaration, from any rule whose selector LIST contains `selector`. */
function pxOf(selector: string, prop: string): number {
  for (const chunk of CSS.split('}')) {
    const brace = chunk.indexOf('{')
    if (brace < 0) continue
    const head = chunk
      .slice(0, brace)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(',')
      .map((sel) => sel.trim())
      .filter(Boolean)
    if (!head.includes(selector)) continue
    const body = chunk.slice(brace + 1).replace(/\/\*[\s\S]*?\*\//g, '')
    const m = new RegExp(`(?:^|[;{\\s])${prop}:\\s*(\\d+)px`).exec(body)
    if (m) return Number(m[1])
  }
  throw new Error(`no ${prop}: Npx in a rule containing "${selector}"`)
}

/** The px a `calc(100% + Npx)` edge gap asks for. */
function pxAfterDoubleColon(selector: string, prop: string): number {
  const m = new RegExp(`${prop}:\\s*calc\\([^)]*\\+\\s*(\\d+)px\\)`).exec(ruleBody(selector))
  if (!m) throw new Error(`no calc(+Npx) for ${prop} in ${selector}`)
  return Number(m[1])
}

/** The rail chrome between the card's edge and a badge slot, per axis: 7px beside, 8px below. */
function railInset(axis: 'x' | 'y'): number {
  const railBody = ruleBody('.canvas-rail__body')
  const pad = /padding:\s*(\d+)px\s+(\d+)px/.exec(railBody)
  const border = /border:\s*(\d+)px/.exec(railBody)
  expect(pad, '.canvas-rail__body padding shorthand').toBeTruthy()
  expect(border, '.canvas-rail__body border shorthand').toBeTruthy()
  const [padY, padX] = [Number(pad![1]), Number(pad![2])]
  expect([padY, padX]).toEqual([7, 6])
  return (axis === 'x' ? padX : padY) + Number(border![1])
}

describe('.sessmem-panel opens into the window, clear of the pill it hangs from (T255)', () => {
  it('anchors its RIGHT edge to the rail instead of growing rightward from the circle', () => {
    const body = ruleBody('.sessmem-panel')
    expect(body).toMatch(/right:\s*calc\(100% \+ \d+px\)/)
    expect(body).toMatch(/left:\s*auto/)
    // `left: 0` is the defect itself: a 380px box starting at the 42px circle's left edge.
    expect(body).not.toMatch(/left:\s*0[;\s]/)
  })

  it('keeps the same 10px gap from the card that the usage panel keeps', () => {
    // The circle is 7px inside the card (1px border + 6px padding), and the popover's containing
    // block is that circle — so the gap is the card's inset plus the convention's 10px, exactly as
    // `.usage-popover` spells it. This row has no refresh control, so no hover drift to add.
    const inset = railInset('x')
    expect(inset).toBe(7)
    expect(pxAfterDoubleColon('.sessmem-panel', 'right') - inset).toBe(10)
    // The sibling panel's extra 28px is its own row's drift; this row has none (the pill is the
    // indicator's only child), which is why the two numbers must NOT be equal.
    expect(pxAfterDoubleColon('.sessmem-panel', 'right')).toBeLessThan(
      pxAfterDoubleColon('.usage-popover', 'right')
    )
  })

  it('hangs 6px above the pill it belongs to, not 8px inside its top edge', () => {
    const pillH = pxOf('.canvas-rail__badges .sysres-pill', 'height')
    expect(pillH).toBe(42)
    // Both panels hang by their containing block (the badge slot the pill fills exactly).
    expect(pxOf('.sessmem-panel', 'bottom')).toBe(pillH + 6)
    // The glass override lifts it for the taller pill there; it must stay above the plain value.
    const glass = /:root\[data-nt-glass='on'\] \.sessmem-panel \{[^}]*bottom:\s*calc\((\d+)px \+ (\d+)px\)/
      .exec(CSS)
    expect(glass, "the glass override's bottom").toBeTruthy()
    expect(Number(glass![1]) + Number(glass![2])).toBeGreaterThan(pxOf('.sessmem-panel', 'bottom'))
  })

  it('stays inside the window and off the card and the pill at any window width', () => {
    const floatGap = Number(/--float-gap:\s*(\d+)px/.exec(CSS)![1])
    const railW = pxOf('.canvas-rail', 'width')
    const gap = pxAfterDoubleColon('.sessmem-panel', 'right')
    const inset = railInset('x')
    const pillW = pxOf('.canvas-rail__badges .sysres-pill', 'width')
    // The row is exactly one pill wide (both 42px) and packs to its end, so the pill fills its slot
    // and never moves: that is why the plain 17px gap is the whole story here, with no drift to add.
    expect(pillW).toBe(pxOf('.canvas-rail__badges', 'width'))
    for (const windowWidth of [1728, 1280, 2560, 900]) {
      const cardLeft = windowWidth - floatGap - railW
      const slotLeft = cardLeft + inset // the sysres badge circle, and the panel's containing block
      const pillLeft = slotLeft // the pill fills the slot: no hover drift in this row
      const panelRight = slotLeft - gap
      expect(panelRight).toBeLessThanOrEqual(windowWidth - floatGap) // nail 1 (T223 bound)
      expect(panelRight).toBeLessThanOrEqual(cardLeft) // nail 2: no intersection with the card
      expect(panelRight).toBeLessThanOrEqual(pillLeft) // nail 3: no intersection with the pill
      expect(pillLeft - panelRight).toBe(17)
      // The 380px panel reaches well inside the window from there, which is the whole point.
      expect(panelRight - pxOf('.sessmem-panel', 'width')).toBeGreaterThan(0)
    }
  })
})
