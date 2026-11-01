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
