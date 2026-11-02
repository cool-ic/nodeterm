import { afterEach, expect, it, vi } from 'vitest'
import { loadPaperFonts, BUNDLED_TERMINAL_FONT } from './paper-fonts'
afterEach(()=>vi.unstubAllGlobals())
it('waits for both bundled weights including Chinese before terminal measurement',async()=>{
 let release!:()=>void
 const pending=new Promise<void>(r=>{release=r})
 const load=vi.fn(()=>pending)
 vi.stubGlobal('document',{fonts:{load}})
 let complete=false
 const result=loadPaperFonts().then(()=>{complete=true})
 await Promise.resolve()
 expect(complete).toBe(false)
 expect(load).toHaveBeenCalledWith('400 16px "Nodeterm Maple Mono"','MW中文繁體\ue0b0')
 expect(load).toHaveBeenCalledWith('700 16px "Nodeterm Maple Mono"','MW中文繁體\ue0b0')
 release();await result
 expect(complete).toBe(true)
 expect(BUNDLED_TERMINAL_FONT).toBe('"Nodeterm Maple Mono", monospace')
})
