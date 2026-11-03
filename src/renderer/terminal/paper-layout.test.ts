import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { paperLayoutStyle, paperLineRatio } from './paper-layout'
it('keeps material-to-type ratios at 15, 30 and 45 px', () => {
 for(const size of [15,30,45]){
  const style = paperLayoutStyle('paper-cotton', size) as Record<string,string>
  expect(parseFloat(style['--paper-tile-size']) / size).toBeCloseTo(680/15)
 }
 expect(paperLayoutStyle('nord',30)).toBeUndefined()
})
it('converts demo font-size line spacing into xterm font-box line spacing', () => {
 for(const [size,box] of [[15,18],[30,36]]){
  const ratio=paperLineRatio(size,1.45,box,2)
  expect(Math.floor(Math.ceil(box*2)*ratio)/2).toBe(Math.round(size*1.45))
 }
})

it('removes both levels of paper padding, including the modal wrapper',()=>{
 const css=readFileSync(new URL('../styles.css',import.meta.url),'utf8')
 const block=css.slice(css.indexOf('.kanban-modal__termwrap:has(> .terminal-paper)'),css.indexOf('.paper-presets {'))
 expect(block).toContain('.term-node__xterm.terminal-paper')
 expect(block).toContain('.terminal-paper .xterm')
 expect(block).toContain('padding: 0;')
 expect(block).not.toContain('6%')
})
