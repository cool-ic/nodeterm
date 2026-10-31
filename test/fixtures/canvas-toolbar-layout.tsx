import { createRoot } from 'react-dom/client'
import { Dock } from '../../src/renderer/components/Dock'
import { IconGear } from '../../src/renderer/components/icons'
import { Tooltip } from '../../src/renderer/components/Tooltip'
import { useSettings } from '../../src/renderer/state/settings'

useSettings.setState(s => ({ settings: { ...s.settings, enabledAgents: [] } }))
window.nodeTerminal = { shell: { platform: 'darwin' } } as typeof window.nodeTerminal
let calls = 0
const hit = () => { calls++ }
const props = Object.fromEntries(['onAddTerminal','onAddSticky','onSpawnTeam','onAddDino','onAddWhiteboard','onAddTrigger','onAddFiles','onAddRun','onAddSimulator','onAddAgent','onOpenFile','onAddRemote','onConnectRemote','onAddBrowser','onAddWeb','onNewFile','onAddWorktree','onUndo','onRedo','onGoBack','onGoForward','onSave','onFitView','onSaveLayout','onRestoreLayout','onUpdateLayout','onRenameLayout','onDeleteLayout','onZoomIn','onZoomOut','onZoomTo','onToggleCanvasLock','onDictate'].map(k=>[k,hit]))
createRoot(document.getElementById('root')!).render(
 <div className="canvas-root" style={{width:1280,height:800}}><div className="flow-wrap" style={{height:"100%"}}>
  <div className="canvas-rail canvas-rail--left"><div className="canvas-rail__body">
   <button className="canvas-rail__toggle" aria-label="Collapse canvas controls" onClick={hit}><span className="canvas-rail__chevron" aria-hidden="true" /></button>
   <Dock {...props} group="compact" dirty={false} zoomPct={100} canvasLocked={false} />
   <Tooltip label="Settings"><button className="dock-btn" aria-label="Settings" onClick={hit}><IconGear /></button></Tooltip>
  </div></div>
 </div></div>
)
const pause = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 80))))
async function check() {
 await pause()
 const root=document.querySelector<HTMLElement>('.canvas-root')!, rail=document.querySelector<HTMLElement>('.canvas-rail__body')!
 const results=[]
 for(const theme of ['dark','light']) for(const glass of ['off','on']) for(const [width,height] of [[1280,800],[390,350]]) {
  document.documentElement.dataset.theme=theme
  document.documentElement.dataset.ntGlass=glass
  root.style.width=width+'px';root.style.height=height+'px'
  await pause()
  const buttons=Array.from(rail.querySelectorAll<HTMLButtonElement>('button'))
  const labels=buttons.map(b=>b.getAttribute('aria-label'))
  if(JSON.stringify(labels)!==JSON.stringify(['Collapse canvas controls','Add node','Save','Fit view','Lock view','Settings']))throw Error('Unexpected controls: '+labels)
  for(const b of buttons){
   b.scrollIntoView({block:'nearest'});await pause()
   const r=b.getBoundingClientRect(),icon=b.querySelector<HTMLElement>('svg,.canvas-rail__chevron')!, chevron=icon.classList.contains('canvas-rail__chevron'), ink=getComputedStyle(icon), line=chevron?getComputedStyle(icon,'::before'):getComputedStyle(icon.querySelector('path,rect,circle')!)
   if(r.width<30||r.height<30||r.right>width+1||r.bottom>height+1)throw Error('clipped '+theme+'/'+glass+'/'+width+' '+b.ariaLabel+' '+JSON.stringify(r))
   if(!b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))throw Error('covered '+b.ariaLabel)
   if(icon.getBoundingClientRect().width<12||(chevron?line.borderLeftStyle==='none':line.stroke==='none')||Number(ink.opacity)!==1)throw Error('invisible '+b.ariaLabel)
   // Require contrasting foreground in both appearances, including glass overrides.
   const rgb=(chevron?line.borderLeftColor:ink.color).match(/[\d.]+/g)!.slice(0,3).map(Number), light=rgb.reduce((a,v)=>a+v,0)/3
   if(b.ariaLabel!=='Add node' && (theme==='dark'?light<160:light>130))throw Error('low-contrast '+b.ariaLabel+' '+ink.color)
   if(b.ariaLabel!=='Add node')b.click()
  }
  results.push({theme,glass,width,height})
 }
 if(calls!==results.length*5)throw Error('callbacks lost: '+calls)
 document.getElementById('result')!.textContent='PASS '+JSON.stringify(results)
}
check().catch(e=>{document.getElementById('result')!.textContent='FAIL '+e.stack})
