import { expect, it } from 'vitest'
import { readableDim } from './paper-dim'
const color=(rgb:number,a=255)=>({rgba:(rgb*256+a)>>>0,css:''})
it('makes alpha-dim ink opaque and readable on textured paper',()=>{
 const result=readableDim(color(0x2a231c,127),color(0xcfc7bc,0),true)
 expect(result.rgba&255).toBe(255)
 const channels=[result.rgba>>>24,(result.rgba>>>16)&255,(result.rgba>>>8)&255]
 expect(Math.max(...channels)).toBeLessThan(90)
 expect(Math.min(...channels)).toBeGreaterThan(30) // secondary text stays softer than body ink
})
it('keeps light dim text legible on an explicit dark application background',()=>{
 const result=readableDim(color(0xffffff,127),color(0x101010))
 expect(result.rgba&255).toBe(255)
 expect(result.rgba>>>24).toBeGreaterThan(110)
})

it('reuses repeated cell colours and bounds cache growth without changing resolved ink',()=>{
 const fg=color(0x635143,127),bg=color(0xcfc7bc,0)
 const first=readableDim(fg,bg,true)
 expect(readableDim({...fg,css:'other'},bg,true)).toBe(first)
 expect(readableDim(fg,bg,false)).not.toBe(first)
 expect(readableDim(color(0x635143,126),bg,true)).not.toBe(first)
 expect(readableDim(fg,color(0xcfc7bd,0),true)).not.toBe(first)
 for(let i=0;i<1025;i++)readableDim(color(i,127),bg,true)
 const again=readableDim(fg,bg,true)
 expect(again).not.toBe(first)
 expect(again).toEqual(first)
})
