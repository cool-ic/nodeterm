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
/** The canvas, for the one structural fact the panel's visibility rests on (T247). */
const CANVAS = readFileSync(join(__dirname, 'canvas/Canvas.tsx'), 'utf8')

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
 * Guard on WHERE the panel opens (T246) and on it actually being VISIBLE, clear of the pill that
 * owns it (T247).
 *
 * T246: it opened at (1657,499) and grew RIGHTWARD 280px from the badge circle's left edge —
 * measured on the live app in a 1728-wide window, a right edge of 1937, i.e. 209px off the window.
 * Every other overlay on this rail opens leftward (T223/T229: `.dock-menu { right: calc(100% + 10px) }`),
 * so the fix was that same direction.
 *
 * T247: opening leftward was not enough, for two reasons, both measured on the packaged build:
 *  - the badge cluster lived INSIDE the card's scroll container (`.canvas-rail__body
 *    { overflow-y: auto }`, T235), and a scroller clips what it holds. The panel at 1360..1640 was
 *    therefore invisible end to end — the pixels that should have carried it hit-tested as the
 *    canvas — and the hovered pill was sliced off at the card's inner edge (22px of its 28px
 *    leftward expansion gone, visible as a chopped circle). The cluster is now a SIBLING of the
 *    body, pinned to the card's foot, with the body reserving its slot (`--rail-badges-h`);
 *  - even seen as rectangles, the panel sat ON the pill: `bottom: 34px` is a 26px-pill value (T226
 *    replaced that pill with a 42px one) and the right edge, anchored on the static 42px circle,
 *    landed 11px inside the pill — which itself slides 28px left on hover because the refresh
 *    control (24px + the row's 4px gap) overflows that fixed 42px box. Overlap measured then:
 *    11×8 = 88px².
 *
 * The offsets below are constants relative to the card's own edges, so they hold at every window
 * width and every rail height; the last test derives both boxes from the same CSS literals and
 * asserts they stay disjoint.
 */
describe('.usage-popover opens into the window and clear of the rail card (T246/T247)', () => {
  /** The px an edge-gap declaration asks for, e.g. `right: calc(100% + 45px)` → 45. */
  function pxAfterDoubleColon(selector: string, prop: string): number {
    const m = new RegExp(`${prop}:\\s*calc\\([^)]*\\+\\s*(\\d+)px\\)`).exec(ruleBody(selector))
    if (!m) throw new Error(`no calc(+Npx) for ${prop} in ${selector}`)
    return Number(m[1])
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

  /** The rail chrome between the card's edge and the badge slot, per axis — `.canvas-rail__body`
   *  carries `padding: 7px 6px` and a 1px border, so 7px sits beside the badges and 8px below them.
   *  Measured: card 1650..1706 × 50..758, badge cluster 1657..1699 × 660..750. */
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

  /** The badge slot's reserved room at the card's foot, as the declaration is written. */
  function railBodyPaddingBottom(): string {
    const m = /padding-bottom:\s*([^;]+);/.exec(ruleBody('.canvas-rail__body'))
    if (!m) throw new Error('no padding-bottom in .canvas-rail__body')
    return m[1].trim()
  }

  /** The rail pill's own box, which is exactly the badge slot it sits in. */
  function railPill() {
    return {
      w: pxOf('.canvas-rail__badges .usage-pill', 'width'),
      h: pxOf('.canvas-rail__badges .usage-pill', 'height'),
    }
  }

  /** How far the pill slides LEFT of its own slot while hovered (or while its panel is open). */
  function hoverDrift(): number {
    return pxOf('.usage-refresh', 'width') + pxOf('.usage-indicator', 'gap')
  }

  it('anchors its RIGHT edge to the rail instead of growing rightward from the circle', () => {
    const body = ruleBody('.usage-popover')
    expect(body).toMatch(/right:\s*calc\(100% \+ \d+px\)/)
    expect(body).toMatch(/left:\s*auto/)
    // `left: 0` is the T246 defect itself: a 280px box starting at the 42px circle's left edge.
    expect(body).not.toMatch(/left:\s*0[;\s]/)
  })

  it('keeps the badge cluster OUT of the card scroller, or the panel is clipped away (T247)', () => {
    // The scroll container clips what it holds, so the cluster must be its SIBLING: the body must
    // close before the cluster's opening tag, with no other element in between.
    const at = CANVAS.indexOf('className="canvas-rail__badges"')
    expect(at, 'the badge cluster in Canvas.tsx').toBeGreaterThan(-1)
    const bodyAt = CANVAS.lastIndexOf('<div className="canvas-rail__body"', at)
    expect(bodyAt).toBeGreaterThan(-1)
    const between = CANVAS.slice(bodyAt, at)
    expect(between.match(/<\/div>/g)?.length, 'the body closes before the cluster').toBe(1)
    expect(between.match(/<div/g)?.length, "the body's own tag plus the cluster's").toBe(2)
    // Out of the flow of the body it used to fill, so pin it to the card's foot instead.
    const cluster = ruleBody('.canvas-rail__badges')
    expect(cluster).toMatch(/position:\s*absolute/)
    expect(cluster).toMatch(/height:\s*var\(--rail-badges-h\)/)
    // Both sides of the slot: the cluster's height, and the room the card body keeps for it.
    const gap = pxOf('.canvas-rail__badges', 'gap')
    const pill = railPill()
    expect(`${gap + pill.h + pill.h}`).toBe('90') // 6 + 42 + 42
    expect(ruleBody('.canvas-rail')).toMatch(/--rail-badges-h:\s*90px/)
    expect(railBodyPaddingBottom()).toBe(`calc(7px + 6px + var(--rail-badges-h))`)
  })

  it('clears the pill it belongs to: 6px above it, 17px beside it (T247)', () => {
    const bottom = pxOf('.usage-popover', 'bottom')
    const gapRight = pxAfterDoubleColon('.usage-popover', 'right')
    const pill = railPill()

    // The panel hangs by its containing block (the badge slot, which the pill fills exactly), so
    // `bottom` must clear the pill's own height plus 6px of air: the rectangles cannot intersect at
    // any pill WIDTH, because a wider pill grows leftward.
    expect(bottom - pill.h).toBe(6)

    // Beside it: the drift the hovered pill slides left by, plus the 17px of air the T246 anchor was
    // already asking for. Ignoring the drift is what put the panel 11px INSIDE the pill.
    expect(hoverDrift()).toBe(28)
    expect(gapRight - hoverDrift()).toBe(17)
  })

  it('hides the cluster with the rest of the rail when the rail is collapsed (T247)', () => {
    // The collapse rule reaches the body's CHILDREN; the cluster is a sibling of the body now, so it
    // needs its own selector — otherwise the two pills would float over the collapsed tab.
    expect(CSS).toMatch(
      /\.canvas-root\[data-rail-collapsed\] \.canvas-rail__badges,[\s\S]{0,200}?display: none;/
    )
  })

  it('keeps the height cap on the same offset it hangs by, so a full panel cannot reach the tab bar', () => {
    const bottom = pxOf('.usage-popover', 'bottom')
    const cap = ruleBody('.usage-popover')
    expect(cap).toMatch(new RegExp(`max-height:\\s*calc\\(100vh - var\\(--tabbar-h\\) - ${bottom}px`))
  })

  it('stays inside the window, off the card and off the pill at any window width', () => {
    const floatGap = Number(/--float-gap:\s*(\d+)px/.exec(CSS)![1])
    const railW = pxOf('.canvas-rail', 'width')
    const gapRight = pxAfterDoubleColon('.usage-popover', 'right')
    const insetX = railInset('x')
    const pill = railPill()
    // One arbitrary-but-real window width; the offsets below are what make it hold for ALL widths.
    for (const windowWidth of [1728, 1280, 2560, 900]) {
      const cardLeft = windowWidth - floatGap - railW
      const slotLeft = cardLeft + insetX // the badge slot, and so the popover's containing block
      const panelRight = slotLeft - gapRight
      expect(panelRight).toBeLessThanOrEqual(windowWidth - floatGap) // nail 1 (T223 bound)
      expect(panelRight).toBeLessThanOrEqual(cardLeft) // nail 2: no intersection with the card
      expect(cardLeft - panelRight).toBe(gapRight - insetX)
      // The hovered pill's own box, from the same literals — the open panel may not touch it.
      const pillLeft = slotLeft - hoverDrift()
      expect(panelRight).toBeLessThan(pillLeft)
      expect(pillLeft - panelRight).toBe(17)
      expect(pill.w).toBe(42)
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
