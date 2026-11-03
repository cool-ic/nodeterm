// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useFontReadyVisual } from './useFontReadyVisual'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
afterEach(()=>vi.restoreAllMocks())
it('mounts only after first font; live switching retains usable metrics, ignoring late old loads',async()=>{
 const releases:Record<string,()=>void>={}
 const fonts={load:vi.fn((descriptor:string)=>new Promise<void>(r=>{releases[descriptor]=r}))}
 Object.defineProperty(document,'fonts',{value:fonts,configurable:true})
 const host=document.createElement('div'),root=createRoot(host)
 let value!:ReturnType<typeof useFontReadyVisual<{fontFamily:string}>>
 function Probe({family}:{family:string}) {value=useFontReadyVisual({fontFamily:family});return null}
 const render=async(family:string)=>{await act(async()=>{root.render(<Probe family={family}/>)})}
 await render('"Nodeterm Maple Mono", monospace')
 expect(value.fontsReady).toBe(false)
 await act(async()=>{releases['400 16px "Nodeterm Maple Mono"'](); releases['700 16px "Nodeterm Maple Mono"']()})
 expect(value.fontsReady).toBe(true)
 await render('"Courier Prime", monospace')
 expect(value.fontsReady).toBe(true)
 expect(value.visual.fontFamily).toBe('"Nodeterm Maple Mono", monospace')
 await render('Menlo, monospace')
 await act(async()=>{releases['400 16px "Courier Prime"']();releases['700 16px "Courier Prime"']()})
 expect(value.visual.fontFamily).toBe('Menlo, monospace')
 await render('"Courier Prime", monospace')
 expect(value.visual.fontFamily).toBe('"Courier Prime", monospace')
 await act(async()=>root.unmount())
})
