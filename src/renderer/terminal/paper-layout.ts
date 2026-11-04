import type { CSSProperties } from 'react'
import { isPaperTheme } from './themes'

export const PAPER_REFERENCE_FONT = 15
export const PAPER_REFERENCE_TILE = 680
const PAPER_REFERENCE_BLOCK_MARGIN = 22
/** Font-relative material and margins; outer canvas zoom transforms paper and glyphs together. */
export function paperLayoutStyle(theme: string, fontSize: number, margins = false): CSSProperties | undefined {
  if (!isPaperTheme(theme)) return undefined
  return {
    '--paper-font-size': `${fontSize}px`,
    '--paper-tile-size': `${PAPER_REFERENCE_TILE * fontSize / PAPER_REFERENCE_FONT}px`,
    '--paper-margin-block': margins === true ? `${fontSize * PAPER_REFERENCE_BLOCK_MARGIN / PAPER_REFERENCE_FONT}px` : '0px',
    '--paper-margin-inline': margins === true ? `max(${fontSize * 26 / PAPER_REFERENCE_FONT}px, 6%)` : '0px'
  } as CSSProperties
}

/** xterm's lineHeight multiplies font bounding-box height, whereas the demo multiplies fontSize. */
export function paperLineRatio(fontSize: number, lineSpacing: number, fontBoxHeight: number, dpr: number): number {
  if (!(fontBoxHeight > 0 && dpr > 0)) return lineSpacing
  const desiredDeviceHeight = Math.round(fontSize * lineSpacing) * dpr
  return Math.max(1, (desiredDeviceHeight + 0.001) / Math.ceil(fontBoxHeight * dpr))
}
const heights = new Map<string, number>()
export function paperXtermLineHeight(fontSize: number, fontFamily: string, lineSpacing: number): number {
  if (typeof OffscreenCanvas === 'undefined') return lineSpacing
  const key = `${fontSize}px ${fontFamily}`
  let height = heights.get(key)
  if (height === undefined) {
    try {
      const ctx = new OffscreenCanvas(1, 1).getContext('2d')
      if (!ctx) return lineSpacing
      ctx.font = key
      const metrics = ctx.measureText('W')
      height = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent
      if (!(height > 0)) return lineSpacing
      if (heights.size > 128) heights.clear()
      heights.set(key, height)
    } catch { return lineSpacing }
  }
  return paperLineRatio(fontSize, lineSpacing, height, globalThis.devicePixelRatio || 1)
}
