import { PAPER_EXTENDED_ANSI, paperInkContrast } from './paper-colours'
import { describe, expect, it } from 'vitest'
import { isPaperTheme, paperThemeClass, PAPER_TYPOGRAPHY, TERMINAL_THEMES } from './themes'

const luminance = (hex: string) => {
  const rgb = hex.slice(1).match(/../g)!.map((x) => parseInt(x, 16) / 255)
    .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
}
const contrast = (a: string, b: string) => {
  const x = luminance(a), y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
describe('paper palettes', () => {
  it.each(TERMINAL_THEMES.filter((t) => t.paper))('$label keeps body text and status colours readable on its base paper', (t) => {
    expect(contrast(t.theme.foreground!, t.theme.background!)).toBeGreaterThan(7)
    for (const c of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const) {
      expect(contrast(t.theme[c]!, t.theme.background!), c).toBeGreaterThanOrEqual(4.5)
    }
  })
  it('shares paper treatment across all palettes without changing ordinary themes', () => {
    expect(paperThemeClass('paper-cotton')).toContain('terminal-paper--cotton')
    expect(isPaperTheme('paper-midnight')).toBe(true)
    expect(paperThemeClass('paper-midnight')).toContain('terminal-paper--night')
    expect(paperThemeClass('paper-moonlit')).toContain('terminal-paper--moonlit')
    expect(paperThemeClass('nord')).toBe('')
    expect(paperThemeClass('unknown')).toBe('')
    expect(PAPER_TYPOGRAPHY.fontFamily).not.toContain('\\')
  })
})

it('keeps all 256-colour paper inks legible on darker texture regions', () => {
  expect(PAPER_EXTENDED_ANSI).toHaveLength(240)
  for(const ink of PAPER_EXTENDED_ANSI) expect(paperInkContrast(ink)).toBeGreaterThanOrEqual(5)
  const cotton=TERMINAL_THEMES.find(t=>t.id==='paper-cotton')!
  expect(cotton.theme.extendedAnsi).toBe(PAPER_EXTENDED_ANSI)
  expect(TERMINAL_THEMES.find(t=>t.id==='paper-midnight')!.theme.extendedAnsi).toBeUndefined()
  // The actual p10k indices in the user's prompt must not escape the paper palette.
  for(const i of [31,39,103,101]) expect(paperInkContrast(PAPER_EXTENDED_ANSI[i-16])).toBeGreaterThanOrEqual(5)
})
