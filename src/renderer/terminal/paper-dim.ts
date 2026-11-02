import grainUrl from '../assets/paper-grain.png?url'
import { glassPanelFill } from './glass-cell-backgrounds'
import type { Terminal } from '@xterm/xterm'
import { PAPER_EXTENDED_ANSI } from './paper-colours'
type Colour={rgba:number;css:string}
const rgb=(n:number):[number,number,number]=>[(n>>>24)&255,(n>>>16)&255,(n>>>8)&255]
const lum=(c:number[])=>c.map(x=>{const s=x/255;return s<=.04045?s/12.92:((s+.055)/1.055)**2.4}).reduce((a,x,i)=>a+x*[.2126,.7152,.0722][i],0)
const contrast=(a:number[],b:number[])=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)}
/** Resolve dim's alpha BEFORE checking contrast; return opaque ink so it isn't dimmed twice. */
export function readableDim(fg:Colour,bg:Colour,defaultPaper=false):Colour {
 const back=rgb(bg.rgba),alpha=(fg.rgba&255)/255
 const start=rgb(fg.rgba).map((v,i)=>v*alpha+back[i]*(1-alpha))
 const check=defaultPaper?[179,170,160]:back
 const toward=lum(start)>lum(check)?255:0
 let c=start
 if(contrast(c,check)<4.5){let lo=0,hi=1;for(let i=0;i<18;i++){const m=(lo+hi)/2,v=start.map(x=>Math.round(x+(toward-x)*m));if(contrast(v,check)>=4.5)hi=m;else lo=m}c=start.map(x=>x+(toward-x)*hi)}
 const [r,g,b]=c.map(Math.round);return{rgba:((r<<24)|(g<<16)|(b<<8)|255)>>>0,css:`rgb(${r}, ${g}, ${b})`}
}
const tagged=(colors:any)=>colors?.ansi?.[255]?.rgba===((parseInt(PAPER_EXTENDED_ANSI[239].slice(1),16)*256+255)>>>0)&&(colors?.background?.rgba&255)===0
const ORIGINAL=Symbol.for('nodeterm.paperDim.original')
/** Guarded renderer adapters; only our light-paper palette is affected. No buffer/PTY mutation. */
export function installPaperDimReadability(term:Terminal):()=>void {
 let previous:unknown
 let repaint=0
 const patch=()=>{
  const renderer=(term as any)._core?._renderService?._renderer?.value
  const atlas=renderer?._glyphRenderer?.value?._atlas
  const target=atlas??renderer?._rowFactory
  if(!target||target===previous)return
  previous=target
  const proto=Object.getPrototypeOf(target)
  const method=atlas?'_getForegroundColor':'_applyMinimumContrast'
  if(proto[ORIGINAL])return
  const original=proto[method];if(typeof original!=='function')return
  proto[ORIGINAL]=original
  if(atlas){
   proto[method]=function(...args:any[]){
    const result=original.apply(this,args)
    if(!args[7]||!tagged(this._config?.colors))return result
    const bg=this._resolveBackgroundRgba(args[1],args[2],args[6])
    return readableDim(result,{rgba:bg,css:''},args[1]===0&&!args[6])
   }
  }else{
   proto[method]=function(element:HTMLElement,bg:Colour,fg:Colour,cell:any,bgOverride?:Colour,fgOverride?:Colour){
    if(!tagged(this._themeService?.colors))return original.call(this,element,bg,fg,cell,bgOverride,fgOverride)
    const result=original.call(this,element,bg,fg,cell,bgOverride,fgOverride)
    // The default paper is already textured. Only explicit app backgrounds get a pigment wash;
    // renderer overrides (selection/search) and inverse video retain their own appearance.
    if(!cell.isBgDefault()&&!cell.isInverse()&&(!bgOverride||(bgOverride.rgba>>>8)===(bg.rgba>>>8))){
      const colors=this._themeService.colors
      const fill=glassPanelFill(rgb(bg.rgba),{bg:rgb(colors.background.rgba),fg:rgb(colors.foreground.rgba)},-1,[rgb((fgOverride??fg).rgba)])
      element.style.backgroundImage=`url("${grainUrl}")`
      element.style.backgroundBlendMode='soft-light'
      element.style.backgroundSize='var(--paper-tile-size, 680px)'
      if(fill)element.style.backgroundColor=`rgba(${fill.rgb.join(',')}, ${fill.alpha})`
    }
    if(!cell.isDim())return result
    const originalFg=fgOverride??fg
    const dim={...originalFg,rgba:((originalFg.rgba&0xffffff00)|127)>>>0}
    element.style.color=readableDim(dim,bg,cell.isBgDefault()&&!cell.isInverse()).css
    return true
   }
  }
  repaint=requestAnimationFrame(()=>{repaint=0;term.clearTextureAtlas();term.refresh(0,term.rows-1)})
 }
 patch();const event=term.onRender(patch);return()=>{event.dispose();if(repaint)cancelAnimationFrame(repaint)}
}
