/** Paper is a background material, independent of cell opacity and foreground contrast.
 * Only xterm's rectangle shader is changed; glyph/selection/cursor shaders stay untouched.
 */
export function paperRectangleShader(source: string): string {
  if (!source.includes('in vec4 v_color;') || !source.includes('outColor = v_color;') || source.includes('uniform float u_paper')) return source
  return source.replace('precision lowp float;', 'precision highp float;\nuniform float u_paper;\nuniform float u_paperScale;')
    .replace('outColor = v_color;', `
  vec2 p = gl_FragCoord.xy / max(u_paperScale, .25);
  float fiber = fract(sin(dot(floor(p), vec2(127.1,311.7))) * 43758.5453);
  float weave = sin(p.x * 2.7 + sin(p.y * 1.3)) * .5 + .5;
  // Darkening only: no light bloom over dark ink, and fully opaque backgrounds retain grain.
  float grain = u_paper * (.012 + .034 * fiber + .012 * weave);
  outColor = vec4(v_color.rgb * (1.0 - grain), v_color.a);`)
}

/** Intercept shader creation only during this synchronous addon activation. */
export function withPaperBackgroundShader<T>(activate: () => T): T {
  const proto = globalThis.WebGL2RenderingContext?.prototype
  if (!proto) return activate()
  const original = proto.shaderSource
  proto.shaderSource = function(shader, source) { original.call(this, shader, paperRectangleShader(source)) }
  try { return activate() } finally { proto.shaderSource = original }
}

/** Background draw only. Reset the uniform before cursor rectangles are drawn. */
export function installPaperBackgroundMaterial(addon: unknown, enabled: () => boolean): boolean {
  const rr = (addon as any)?._renderer?._rectangleRenderer?.value
  if (!rr?._gl || !rr._program || typeof rr.renderBackgrounds !== 'function') return false
  const gl: WebGL2RenderingContext = rr._gl
  const location = gl.getUniformLocation(rr._program, 'u_paper')
  if (location === null) return false
  const scale = gl.getUniformLocation(rr._program, 'u_paperScale')
  const original = rr.renderBackgrounds
  rr.renderBackgrounds = function(...args: unknown[]) {
    gl.useProgram(this._program)
    const fontScale = (this._terminal?.options?.fontSize ?? 15) / 15
    const pixelScale = globalThis.devicePixelRatio || 1
    if(scale !== null) gl.uniform1f(scale, fontScale * pixelScale)
    gl.uniform1f(location, enabled() ? 1 : 0)
    try { return original.apply(this, args) } finally { gl.uniform1f(location, 0) }
  }
  return true
}
