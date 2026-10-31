#!/usr/bin/env node
// Isolated real-Electron regression for the pinned xterm atlas collision.
// Run: node scripts/test-webgl-atlas.cjs. Never attaches to a user session.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
if (!process.versions.electron) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-atlas-regression-'));
  require('esbuild').buildSync({entryPoints:[path.join(__dirname,'../src/renderer/terminal/webgl-atlas-identity.ts')],outfile:path.join(dir,'guard.js'),bundle:true,format:'iife',globalName:'atlasGuard'});
  const r = require('node:child_process').spawnSync(require('electron'), [__filename], {stdio:'inherit',env:{...process.env,NT_ATLAS_TEST_DIR:dir,ELECTRON_RUN_AS_NODE:''}});
  console.log('Synthetic regression artifacts:',dir);
  process.exit(r.status ?? 1);
}
const {app,BrowserWindow,ipcMain} = require('electron');
const dir=process.env.NT_ATLAS_TEST_DIR;
if (!dir) throw new Error('Run this test through node');
app.setPath('userData',path.join(dir,'profile'));
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('force-device-scale-factor','2');
const xterm=require.resolve('@xterm/xterm/lib/xterm.js');
const webgl=require.resolve('@xterm/addon-webgl/lib/addon-webgl.js');
const css=require.resolve('@xterm/xterm/css/xterm.css');
let win, timeout;
const outcomes=[];
function page(patched) {
 return `<!doctype html><meta charset="utf-8"><style>${fs.readFileSync(css,'utf8')}</style><div id="a"></div><div id="b"></div>
 <script>${fs.readFileSync(xterm,'utf8')}</script><script>${fs.readFileSync(webgl,'utf8')}</script><script>${fs.readFileSync(path.join(dir,'guard.js'),'utf8')}</script>
 <script>(${browserTest.toString()})(${patched});</script>`;
}
async function browserTest(patched) {
 const result={patched}, pause=()=>new Promise(r=>setTimeout(r,100)), write=(t,s)=>new Promise(r=>t.write(s,r));
 try {
  const make=id=>{const t=new Terminal({cols:90,rows:12,fontSize:24,fontFamily:'Menlo',scrollback:4000,allowProposedApi:true,theme:{background:'#eff1f5',foreground:'#4c4f69'},cursorBlink:false});t.open(document.getElementById(id));const a=new WebglAddon.WebglAddon(true);t.loadAddon(a);if(patched&&!atlasGuard.installWebglAtlasIdentity(a))throw Error('guard failed to install');return {t,a}};
  const x=make('a'), y=make('b'); const wr=()=>x.a._renderer;
  const pixels=z=>{const gl=z.a._renderer._gl,c=gl.canvas,b=new Uint8Array(c.width*c.height*4);gl.readPixels(0,0,c.width,c.height,gl.RGBA,gl.UNSIGNED_BYTE,b);return b};
  const delta=(a,b)=>{let n=0;if(a.length!==b.length)throw Error('size mismatch');for(let i=0;i<a.length;i++)if(a[i]!==b[i])n++;return n};
  await write(y.t,'第二个共享字形缓存终端 Shared atlas sibling');await pause();
  result.shared=wr()._charAtlas===y.a._renderer._charAtlas;
  for(let block=0;block<80;block++){let s='';for(let row=0;row<10;row++){let line='';for(let col=0;col<40;col++)line+=String.fromCharCode(0x4e00+(block*400+row*40+col)%20000);s+='\x1b['+(row%2?31:90)+'m'+line+'\x1b[0m\r\n';}await write(x.t,s);x.t.refresh(0,11);await pause();}
  result.scrollDifferences=[];
  for(let j=0;j<8;j++){x.t.scrollToLine(j*70);await pause();const p=pixels(x);x.t.refresh(0,11);await pause();result.scrollDifferences.push(delta(p,pixels(x)))}
  const before=pixels(x);result.beforeImage=wr()._gl.canvas.toDataURL();
  for(const t of wr()._glyphRenderer.value._atlasTextures)t.version=-1;
  x.t.refresh(0,11);await pause();result.forcedUploadDifference=delta(before,pixels(x));result.afterImage=wr()._gl.canvas.toDataURL();
  // Font changes replace the atlas; disposal/reacquisition replaces GL textures.
  if(patched){result.fontDifferences=[];for(const size of [40,14]){x.t.options.fontSize=size;await pause();const p=pixels(x);for(const t of wr()._glyphRenderer.value._atlasTextures)t.version=-1;x.t.refresh(0,11);await pause();result.fontDifferences.push(delta(p,pixels(x)));}x.a.dispose();x.a=new WebglAddon.WebglAddon(true);x.t.loadAddon(x.a);if(!atlasGuard.installWebglAtlasIdentity(x.a))throw Error('reacquire guard failed');x.t.refresh(0,11);await pause();const p=pixels(x);for(const t of wr()._glyphRenderer.value._atlasTextures)t.version=-1;x.t.refresh(0,11);await pause();result.reacquireDifference=delta(p,pixels(x));}
  result.done=true;
 }catch(e){result.error=e.stack}
 require('electron').ipcRenderer.send('atlas-result',result);
}
async function run(patched) {
 const file=path.join(dir,patched?'patched.html':'baseline.html');fs.writeFileSync(file,page(patched));
 win=new BrowserWindow({show:false,width:1600,height:1000,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false}});
 win.webContents.on('render-process-gone',(_e,d)=>{console.error(d);app.exit(1)});
 await win.loadFile(file);
}
ipcMain.on('atlas-result',(event,r)=>{
 if(event.sender!==win.webContents)return;
 for(const key of ['beforeImage','afterImage']){if(r[key]){fs.writeFileSync(path.join(dir,(r.patched?'patched-':'baseline-')+key+'.png'),Buffer.from(r[key].split(',')[1],'base64'));delete r[key]}}
 outcomes.push(r);console.log(JSON.stringify(r));win.destroy();
 if(!r.patched){run(true).catch(e=>{console.error(e);app.exit(1)});return}
 clearTimeout(timeout);fs.writeFileSync(path.join(dir,'results.json'),JSON.stringify(outcomes,null,2));
 const [old,fixed]=outcomes;
 const pass=old.done&&fixed.done&&old.shared&&fixed.shared&&old.forcedUploadDifference>0&&fixed.forcedUploadDifference===0&&fixed.scrollDifferences.every(n=>n===0)&&fixed.fontDifferences.every(n=>n===0)&&fixed.reacquireDifference===0;
 console.log(pass?'ATLAS_REGRESSION_PASS':'ATLAS_REGRESSION_FAIL');app.exit(pass?0:1);
});
app.on('window-all-closed',()=>{});
app.whenReady().then(()=>{timeout=setTimeout(()=>{console.error('atlas test timeout');app.exit(1)},180000);run(false).catch(e=>{console.error(e);app.exit(1)})});
