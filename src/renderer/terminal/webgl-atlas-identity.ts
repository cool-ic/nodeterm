import type { WebglAddon } from '@xterm/addon-webgl'

interface AtlasPage { canvas: object; version: number }
interface Atlas { pages: AtlasPage[] }
interface Texture { version: number }
interface GlyphRenderer {
  _atlas?: Atlas
  _atlasTextures: Texture[]
  render(model: unknown): void
  _bindAtlasPageTexture(gl: unknown, atlas: Atlas, index: number): void
}

const installed = Symbol.for('nodeterm.webglAtlasIdentity.v1')

/** addon-webgl 0.18 compares per-page versions, which can collide after a page
 * merge moves a different canvas into the same texture unit. The new UVs then
 * sample the OLD page: persistent sliced/mixed glyphs, especially in CJK history.
 *
 * Track the identity actually uploaded, in addition to the addon's own version
 * comparison. No periodic clears, no rerasterization, no extra uploads on a
 * stable frame. Prototype scope covers every terminal and rebuilt GL renderer;
 * weak texture keys release both old contexts and their old pages naturally.
 * Remove when upgrading the core/addon pair to a release with xterm dc726a2a.
 */
export function installWebglAtlasIdentity(addon: WebglAddon): boolean {
  const renderer = (addon as unknown as {
    _renderer?: { _glyphRenderer?: { value?: GlyphRenderer } }
  })._renderer?._glyphRenderer?.value
  if (!renderer || !Array.isArray(renderer._atlasTextures)) return false
  const proto = Object.getPrototypeOf(renderer) as GlyphRenderer & { [installed]?: boolean }
  if (proto[installed]) return true
  const render = proto.render
  const bind = proto._bindAtlasPageTexture
  if (typeof render !== 'function' || typeof bind !== 'function') return false
  const uploaded = new WeakMap<Texture, object>()

  proto._bindAtlasPageTexture = function (gl, atlas, index): void {
    // Record only a completed upload. A failed upload must remain dirty.
    bind.call(this, gl, atlas, index)
    const texture = this._atlasTextures[index]
    if (texture && atlas.pages[index]) uploaded.set(texture, atlas.pages[index].canvas)
  }
  proto.render = function (model): void {
    const pages = this._atlas?.pages
    if (pages) {
      for (let i = 0; i < Math.min(pages.length, this._atlasTextures.length); i++) {
        const texture = this._atlasTextures[i]
        if (uploaded.get(texture) !== pages[i].canvas) texture.version = -1
      }
    }
    render.call(this, model)
  }
  proto[installed] = true
  return true
}
