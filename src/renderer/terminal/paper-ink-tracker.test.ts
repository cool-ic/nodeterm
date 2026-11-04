import { afterEach, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import type { IBuffer } from '@xterm/xterm'
import { VisibleInkChanges } from './paper-ink-tracker'
const opened: Terminal[] = []
const terminal = (cols = 30, rows = 4) => { const t = new Terminal({ cols, rows, allowProposedApi: true }); opened.push(t); return t }
const write = (t: Terminal, text: string) => new Promise<void>((r) => t.write(text, r))
const capture = (tracker: VisibleInkChanges, t: Terminal, output = true) => tracker.capture(t.buffer.active, t.cols, t.rows, 0, t.rows - 1, output)
afterEach(() => { opened.splice(0).forEach((t) => t.dispose()); vi.restoreAllMocks() })
it('animates actual output without any key, in normal and alternate TUIs', async () => {
 const t = terminal(), tracker = new VisibleInkChanges()
 capture(tracker,t,false)
 await write(t,'shell output')
 expect(capture(tracker,t).map(x=>x.chars).join('')).toBe('shelloutput')
 await write(t,'\x1b[?1049h')
 capture(tracker,t,false) // buffer-change baseline, before TUI emits its content
 await write(t,'\x1b[2J\x1b[HCPU 12%\x1b[2;1H中文')
 expect(capture(tracker,t).map(x=>x.chars).join('')).toBe('CPU12%中文')
 await write(t,'\x1b[1;5H34')
 expect(capture(tracker,t).map(x=>x.chars).join('')).toBe('34')
 await write(t,'\x1b[HCPU 34%\x1b[2;1H中文')
 expect(capture(tracker,t)).toEqual([]) // full app redraw, identical cells
})
it('settles existing text across style changes and respects wide/combining cells',async()=>{
 const t=terminal(),tracker=new VisibleInkChanges();capture(tracker,t,false)
 await write(t,'\x1b[31m中e\u0301')
 const first=capture(tracker,t)
 expect(first.map(x=>[x.col,x.chars])).toEqual([[0,'中'],[2,'e\u0301']])
 await write(t,'\r\x1b[32m中')
 const next=capture(tracker,t);expect(next).toEqual([])
 await write(t,'\r\x1b[2K')
 expect(capture(tracker,t)).toEqual([])
})
it('does not retain or decorate concealed input or invent non-echoed input',async()=>{
 const t=terminal(),tracker=new VisibleInkChanges();capture(tracker,t,false)
 expect(capture(tracker,t)).toEqual([]) // a key without a terminal write is invisible here
 await write(t,'\x1b[8msecret\x1b[0m')
 expect(capture(tracker,t)).toEqual([])
 expect(JSON.stringify([...((tracker as any).rows).values()])).not.toContain('secret')
})
it('repaint-only events do no cell scanning; snapshots are bounded to the visible viewport',async()=>{
 const t=terminal(),tracker=new VisibleInkChanges();capture(tracker,t,false)
 const read=vi.spyOn(t.buffer.active,'getLine')
 for(let i=0;i<100;i++)expect(capture(tracker,t,false)).toEqual([])
 expect(read).not.toHaveBeenCalled()
 for(let i=0;i<40;i++){await write(t,`\r\nline${i}`);capture(tracker,t)}
 expect((tracker as any).rows.size).toBeLessThanOrEqual(t.rows)
})
it('scrolling history does not manufacture fresh ink; returning live permits later new output',async()=>{
 const t=terminal(15,3),tracker=new VisibleInkChanges()
 await write(t,Array.from({length:10},(_,i)=>`line${i}`).join('\r\n'))
 const live=t.buffer.active;let top=live.viewportY
 const view=new Proxy(live,{get(target,key){if(key==='viewportY')return top;const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}}) as IBuffer
 const scan=(output:boolean)=>tracker.capture(view,t.cols,t.rows,0,t.rows-1,output)
 scan(false);top=0;expect(scan(false)).toEqual([])
 top=live.baseY;expect(scan(false)).toEqual([])
 await write(t,'\r\nnew');top=live.baseY
 expect(scan(true).map(x=>x.chars).join('')).toBe('new')
})

it('first repaint after suspension establishes a baseline instead of flashing old history',async()=>{
 const t=terminal(),tracker=new VisibleInkChanges()
 await write(t,'old text');expect(capture(tracker,t)).toEqual([])
 tracker.reset();await write(t,' new');expect(capture(tracker,t)).toEqual([])
 await write(t,'!');expect(capture(tracker,t).map(x=>x.chars).join('')).toBe('!')
})

it('moves settled alternate-screen history without giving it new ink',async()=>{
 const t=terminal(30,4),tracker=new VisibleInkChanges()
 await write(t,'\x1b[?1049hA old\r\nB old\r\nC old\r\nD old');capture(tracker,t,false)
 await write(t,'\x1b[1S\x1b[4;1Hfresh')
 expect(capture(tracker,t).map(x=>x.chars).join('')).toBe('fresh')
 expect(tracker.moves.some(m=>m.fromLine===1&&m.line===0)).toBe(true)
})
it('handles actual tmux-shaped cursor-addressed row redraw, not just CSI scrolling',async()=>{
 const t=terminal(40,4),tracker=new VisibleInkChanges()
 await write(t,'\x1b[?1049hfirst history\r\nsecond history\r\nthird history');capture(tracker,t,false)
 await write(t,'\x1b[H\x1b[Ksecond history\x1b[2;1H\x1b[Kthird history\x1b[3;1H\x1b[Knew token')
 const changed=capture(tracker,t)
 expect(changed.map(x=>x.chars).join('')).toBe('newtoken')
 expect(changed.every(x=>x.line===2)).toBe(true)
})
it('does not restart old lines when normal scrollback is full',async()=>{
 const t=new Terminal({cols:10,rows:3,scrollback:2,allowProposedApi:true});opened.push(t)
 const tracker=new VisibleInkChanges()
 await write(t,'A\r\nB\r\nC\r\nD\r\nE');capture(tracker,t,false)
 await write(t,'\r\nF')
 expect(capture(tracker,t).map(x=>x.chars).join('')).toBe('F')
})
it('does not steal the identity of repeated rows, and retains real normal-buffer repeats',async()=>{
 const t=terminal(10,3),tracker=new VisibleInkChanges()
 await write(t,'\x1b[?1049hA\r\nB\r\nC');capture(tracker,t,false)
 await write(t,'\x1b[H\x1b[KB\x1b[2;1H\x1b[KC\x1b[3;1H\x1b[KB')
 expect(capture(tracker,t).map(x=>x.chars).join('')).toBe('B')
 const normal=terminal(10,3),other=new VisibleInkChanges()
 await write(normal,'A\r\nA\r\nA');capture(other,normal,false)
 await write(normal,'\r\nA')
 expect(capture(other,normal).map(x=>x.chars).join('')).toBe('A')
})
it('carries inline and wrapped Chinese/combining text while marking only inserted glyphs',async()=>{
 const t=terminal(30,3),tracker=new VisibleInkChanges()
 await write(t,'\x1b[?1049h中文 e\u0301 old');capture(tracker,t,false)
 await write(t,'\x1b[H++中文 e\u0301 old')
 expect(capture(tracker,t).map(x=>x.chars).join('')).toBe('++')
 expect(tracker.moves.find(m=>m.chars==='中')).toMatchObject({fromCol:0,col:2})
 await write(t,'\x1b[H\x1b[K++中文\x1b[2;1H e\u0301 old')
 expect(capture(tracker,t)).toEqual([])
})
it('keeps autonomous TUI counter updates after history movement filtering',async()=>{
 const t=terminal(30,3),tracker=new VisibleInkChanges()
 await write(t,'\x1b[?1049hCPU 12%\r\nMemory 20%');capture(tracker,t,false)
 await write(t,'\x1b[HCPU 34%\x1b[2;1HMemory 25%')
 expect(capture(tracker,t).map(x=>x.chars).join('')).toBe('345')
})
it('bounds ambiguous huge alignments without restarting an entire old screen',async()=>{
 const t=terminal(300,4),tracker=new VisibleInkChanges()
 await write(t,'\x1b[?1049h'+'a'.repeat(900));capture(tracker,t,false)
 await write(t,'\x1b[H'+'b'.repeat(900))
 expect(capture(tracker,t)).toEqual([]) // resource budget: conservative decoration, real output still written
 expect(tracker.uncertain).toBe(true)
 expect(t.buffer.active.getLine(0)?.getCell(0)?.getChars()).toBe('b')
 await write(t,'\x1b[1;300H!')
 expect(capture(tracker,t).map(x=>x.chars).join('')).toBe('!')
 expect(tracker.uncertain).toBe(false)
})
