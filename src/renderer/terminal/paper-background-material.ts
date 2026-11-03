import cotton from '../assets/paper-cotton.png?url'
import linen from '../assets/paper-linen.png?url'
import moonlit from '../assets/paper-moonlit.png?url'

// The same material used by the CSS sheet, normalized by its measured mean RGB.
// Cell opacity controls pigment only; it must never erase the underlying paper relief.
export const PAPER_MATERIALS = {
  cotton: {url:cotton,mean:[206.8035,199.0109,188.3534]},
  linen: {url:linen,mean:[202.4863,196.7548,190.5012]},
  moonlit: {url:moonlit,mean:[197.3814,196.0022,197.6287]}
} as const
export type PaperMaterial = keyof typeof PAPER_MATERIALS
export function paperMaterialKind(host:Element|null|undefined):PaperMaterial {
 return host?.classList.contains('terminal-paper--cotton')?'cotton':host?.classList.contains('terminal-paper--moonlit')?'moonlit':'linen'
}
export function paperRectangleShader(source:string):string {
  if(!source.includes('in vec4 v_color;') || !source.includes('outColor = v_color;') || source.includes('uniform float u_paper'))return source
  return source.replace('precision lowp float;',`precision highp float;
uniform float u_paper;
uniform sampler2D u_paperTexture;
uniform vec3 u_paperMean;
uniform vec4 u_paperGeometry;
uniform float u_paperDpr;`)
    .replace('outColor = v_color;',`outColor = v_color;
  if (u_paper > .5) {
    vec2 css = vec2(gl_FragCoord.x, u_paperGeometry.z * u_paperDpr - gl_FragCoord.y) / u_paperDpr;
    vec2 uv = (css + u_paperGeometry.xy) / u_paperGeometry.w;
    vec3 relief = texture(u_paperTexture, uv).rgb / u_paperMean;
    outColor = vec4(clamp(v_color.rgb * relief, 0.0, 1.0), v_color.a);
  }`)
}
export function withPaperBackgroundShader<T>(activate:()=>T):T {
  const proto=globalThis.WebGL2RenderingContext?.prototype
  if(!proto)return activate()
  const original=proto.shaderSource
  proto.shaderSource=function(shader,source){original.call(this,shader,paperRectangleShader(source))}
  try{return activate()}finally{proto.shaderSource=original}
}
const images=new Map<PaperMaterial,Promise<HTMLImageElement>>()
function imageFor(kind:PaperMaterial):Promise<HTMLImageElement> {
  let pending=images.get(kind)
  if(!pending){pending=new Promise((resolve,reject)=>{
    const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(Error('Paper material load failed'));image.src=PAPER_MATERIALS[kind].url
  });images.set(kind,pending)}
  return pending
}
/** Guard private xterm entry points. No glyph shader or text buffer changes. */
export function installPaperBackgroundMaterial(addon:unknown,enabled:()=>boolean):boolean {
  const rr=(addon as any)?._renderer?._rectangleRenderer?.value
  if(!rr?._gl || !rr._program || typeof rr.renderBackgrounds!=='function' || typeof rr.renderCursor!=='function')return false
  const gl:WebGL2RenderingContext=rr._gl
  const u=Object.fromEntries(['u_paper','u_paperTexture','u_paperMean','u_paperGeometry','u_paperDpr'].map(n=>[n,gl.getUniformLocation(rr._program,n)]))
  if(Object.values(u).some(x=>x===null))return false
  const unit=7, textures=new Map<PaperMaterial,WebGLTexture|null>()
  let disposed=false
  const upload=(image?:HTMLImageElement):WebGLTexture=>{
    const active=gl.getParameter(gl.ACTIVE_TEXTURE);gl.activeTexture(gl.TEXTURE0+unit)
    const previous=gl.getParameter(gl.TEXTURE_BINDING_2D),texture=gl.createTexture()
    const flip=image?gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL):undefined
    if(!texture){gl.activeTexture(active);throw Error('Paper texture allocation failed')}
    try{
      gl.bindTexture(gl.TEXTURE_2D,texture)
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.REPEAT)
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.REPEAT)
      if(image){gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image)}
      else gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([255,255,255,255]))
      return texture
    }catch(e){gl.deleteTexture(texture);throw e}
    finally{if(image)gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,flip);gl.bindTexture(gl.TEXTURE_2D,previous);gl.activeTexture(active)}
  }
  const white=upload()
  let geometryKey='',geometry=[0,0,1,680],dpr=1
  for(const method of ['renderBackgrounds','renderCursor']){
    const original=rr[method]
    rr[method]=function(...args:unknown[]){
      const host=this._terminal?.element?.closest('.terminal-paper') as HTMLElement|undefined
      const kind=paperMaterialKind(host)
      const on=method==='renderBackgrounds' && enabled()
      if(on && !textures.has(kind)){
        textures.set(kind,null)
        void imageFor(kind).then(image=>{
          if(disposed || gl.isContextLost())return
          textures.set(kind,upload(image))
          this._terminal?.refresh?.(0,(this._terminal?.rows??1)-1)
        }).catch(()=>{ /* retain the flat fallback; never break terminal rendering */ })
      }
      const canvas=gl.canvas as HTMLCanvasElement
      const font=this._terminal?.options?.fontSize??15
      const key=`${canvas.width}:${canvas.height}:${font}:${kind}`
      if(on && key!==geometryKey){
        const c=canvas.getBoundingClientRect(),h=host?.getBoundingClientRect(),zoom=c.width/(canvas.clientWidth||1)
        dpr=canvas.width/(canvas.clientWidth||canvas.width)
        geometry=[h&&zoom?(c.left-h.left)/zoom:0,h&&zoom?(c.top-h.top)/zoom:0,canvas.height/dpr,680*font/15]
        if(c.width>0)geometryKey=key
      }
      const texture=on?textures.get(kind):null
      const active=gl.getParameter(gl.ACTIVE_TEXTURE);gl.activeTexture(gl.TEXTURE0+unit)
      const previous=gl.getParameter(gl.TEXTURE_BINDING_2D)
      gl.bindTexture(gl.TEXTURE_2D,texture??white);gl.useProgram(this._program)
      gl.uniform1i(u.u_paperTexture,unit)
      gl.uniform1f(u.u_paper,texture?1:0)
      gl.uniform3fv(u.u_paperMean,PAPER_MATERIALS[kind].mean.map(v=>v/255))
      gl.uniform4fv(u.u_paperGeometry,geometry);gl.uniform1f(u.u_paperDpr,dpr)
      try{return original.apply(this,args)}
      finally{gl.uniform1f(u.u_paper,0);gl.bindTexture(gl.TEXTURE_2D,previous);gl.activeTexture(active)}
    }
  }
  const dispose=rr.dispose
  rr.dispose=function(...args:unknown[]){
    disposed=true;gl.deleteTexture(white);for(const texture of textures.values())if(texture)gl.deleteTexture(texture)
    return dispose?.apply(this,args)
  }
  return true
}
