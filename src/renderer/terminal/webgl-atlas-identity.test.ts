import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import type { WebglAddon } from '@xterm/addon-webgl'
import { installWebglAtlasIdentity } from './webgl-atlas-identity'

// Exercise the INSTALLED renderer's version comparison and upload path, not a
// reimplementation of either. Only GL transport is mocked; pixel coverage is
// provided by scripts/test-webgl-atlas.cjs on real Electron/WebGL.
function rendererClass() {
  const source = readFileSync(require.resolve('@xterm/addon-webgl/lib/addon-webgl.js'), 'utf8')
  const anchor = 'e.WebglAddon=h})(),s'
  expect(source.split(anchor)).toHaveLength(2)
  const box = { module: { exports: {} }, exports: {}, self: {}, window: {},
    navigator: { userAgent: 'node', platform: 'MacIntel' } }
  vm.runInNewContext(source.replace(anchor, `${anchor}.__require=i,s`), box)
  const req = (box.module.exports as { __require(id: number): { GlyphRenderer: { prototype: object } } }).__require
  return req(965).GlyphRenderer
}
function fixture(C = rendererClass()) {
  const upload = vi.fn()
  const gl = { useProgram() {}, bindVertexArray() {}, bindBuffer() {}, bufferData() {},
    activeTexture() {}, bindTexture() {}, texParameteri() {}, generateMipmap() {},
    drawElementsInstanced() {}, texImage2D: upload }
  const r = Object.assign(Object.create(C.prototype), {
    _gl: gl, _terminal: { cols: 1 }, _activeBuffer: 0,
    _vertices: { attributes: new Float32Array(11), attributesBuffers: [new Float32Array(11), new Float32Array(11)] },
    _atlas: { pages: [{ canvas: {}, version: 7 }] },
    _atlasTextures: [{ texture: {}, version: -1 }]
  })
  const addon = { _renderer: { _glyphRenderer: { value: r } } } as unknown as WebglAddon
  const draw = () => r.render({ lineLengths: [1] })
  return { r, addon, upload, draw }
}

describe('WebGL atlas page identity', () => {
  it('reproduces the pinned addon defect before installing the guard', () => {
    const f = fixture(); f.draw()
    f.r._atlas.pages[0] = { canvas: {}, version: 7 }; f.draw()
    expect(f.upload).toHaveBeenCalledTimes(1) // wrong: different pixels, same version
  })
  it('uploads a replacement page even when versions collide; stable frames stay cheap', () => {
    const f = fixture(); expect(installWebglAtlasIdentity(f.addon)).toBe(true)
    f.draw(); f.draw(); expect(f.upload).toHaveBeenCalledTimes(1)
    f.r._atlas.pages[0] = { canvas: {}, version: 7 }; f.draw(); f.draw()
    expect(f.upload).toHaveBeenCalledTimes(2)
    f.r._atlas.pages[0].version++; f.draw()
    expect(f.upload).toHaveBeenCalledTimes(3)
  })
  it('tracks each terminal separately even when they share one atlas', () => {
    const C = rendererClass(), a = fixture(C), b = fixture(C)
    b.r._atlas = a.r._atlas
    installWebglAtlasIdentity(a.addon); installWebglAtlasIdentity(b.addon)
    a.draw(); b.draw()
    a.r._atlas.pages[0] = { canvas: {}, version: 7 }
    a.draw(); b.draw()
    expect(a.upload).toHaveBeenCalledTimes(2)
    expect(b.upload).toHaveBeenCalledTimes(2)
  })
  it('covers a new atlas after font changes and new textures after context restoration', () => {
    const f = fixture(); installWebglAtlasIdentity(f.addon); f.draw()
    f.r._atlas = { pages: [{ canvas: {}, version: 7 }] }; f.draw()
    f.r._atlasTextures = [{ texture: {}, version: 7 }]; f.draw()
    expect(f.upload).toHaveBeenCalledTimes(3)
  })
  it('does not mark an upload successful when GL throws, and installation is idempotent', () => {
    const f = fixture(); installWebglAtlasIdentity(f.addon)
    const render = f.r.render
    installWebglAtlasIdentity(f.addon); expect(f.r.render).toBe(render)
    f.upload.mockImplementationOnce(() => { throw new Error('context lost') })
    expect(f.draw).toThrow('context lost'); f.draw()
    expect(f.upload).toHaveBeenCalledTimes(2)
  })
  it('rejects an incompatible addon before touching its renderer', () => {
    expect(installWebglAtlasIdentity({} as WebglAddon)).toBe(false)
  })
})
