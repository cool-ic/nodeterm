import { expect, it, vi } from 'vitest'
import { paperRectangleShader, installPaperBackgroundMaterial } from './paper-background-material'
it('textures opaque rectangle RGB while preserving alpha and ignores glyph shaders', () => {
  const source = 'precision lowp float;\nin vec4 v_color;\nvoid main(){ outColor = v_color; }'
  const patched = paperRectangleShader(source)
  expect(patched).toContain('v_color.a')
  expect(patched).toContain('u_paper')
  expect(paperRectangleShader(patched)).toBe(patched)
  expect(paperRectangleShader('glyph shader')).toBe('glyph shader')
})
it('material is enabled for background draw only and resets on errors', () => {
  const uniform1f = vi.fn()
  const rr = { _gl: { getUniformLocation: () => 1, useProgram: vi.fn(), uniform1f }, _program: {}, renderBackgrounds: vi.fn(() => { throw Error('context lost') }) }
  expect(installPaperBackgroundMaterial({ _renderer: { _rectangleRenderer: { value: rr } } }, () => true)).toBe(true)
  expect(() => rr.renderBackgrounds()).toThrow('context lost')
  expect(uniform1f.mock.calls.slice(-2).map(x => x[1])).toEqual([1,0])
})
