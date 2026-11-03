import { afterEach, expect, it, vi } from 'vitest'
import { loadTerminalFonts, terminalFontsReady, BUNDLED_TERMINAL_FONT } from './paper-fonts'
afterEach(()=>vi.unstubAllGlobals())
it('waits for only the selected bundled weights, including Chinese, and shares in-flight work',async()=>{
 let release!:()=>void
 const pending=new Promise<void>(r=>{release=r}),load=vi.fn(()=>pending)
 vi.stubGlobal('document',{fonts:{load}})
 expect(terminalFontsReady(BUNDLED_TERMINAL_FONT)).toBe(false)
 const first=loadTerminalFonts(BUNDLED_TERMINAL_FONT)
 expect(loadTerminalFonts(BUNDLED_TERMINAL_FONT)).toBe(first)
 expect(loadTerminalFonts('"nodeterm maple mono", monospace')).toBe(first)
 expect(load).toHaveBeenCalledTimes(2)
 expect(load).toHaveBeenCalledWith('400 16px "Nodeterm Maple Mono"','MW中文繁體\ue0b0')
 expect(load).toHaveBeenCalledWith('700 16px "Nodeterm Maple Mono"','MW中文繁體\ue0b0')
 release();await first
 expect(terminalFontsReady(BUNDLED_TERMINAL_FONT)).toBe(true)
 expect(load).toHaveBeenCalledTimes(2)
})
it('does not download paper fonts for a system font; font failure cannot leave a terminal blocked',async()=>{
 const load=vi.fn().mockRejectedValue(Error('offline')),warn=vi.spyOn(console,'warn').mockImplementation(()=>{})
 vi.stubGlobal('document',{fonts:{load}})
 expect(terminalFontsReady('Menlo, monospace')).toBe(true)
 await loadTerminalFonts('Menlo, monospace');expect(load).not.toHaveBeenCalled()
 await loadTerminalFonts('"Courier Prime", monospace')
 expect(load).toHaveBeenCalledTimes(2)
 expect(terminalFontsReady('"Courier Prime", monospace')).toBe(true)
 warn.mockRestore()
})
