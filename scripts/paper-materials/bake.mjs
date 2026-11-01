// Offline asset generator. Run: node scripts/paper-materials/bake.mjs
// Never operates the user desktop: one hidden renderer, temporary profile, no network or shell.
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const assets = resolve(here, '../../src/renderer/assets')
const scratch = mkdtempSync(join(tmpdir(), 'nodeterm-paper-'))
try {
  await build({ entryPoints: [join(here, 'generate.ts')], bundle: true, loader: { '.glsl': 'text' }, outfile: join(scratch, 'generate.js') })
  writeFileSync(join(scratch, 'index.html'), '<!doctype html><script src="generate.js"></script>')
  writeFileSync(join(scratch, 'preload.cjs'), "require('electron').contextBridge.exposeInMainWorld('testResult', data => require('electron').ipcRenderer.send('result', data))")
  writeFileSync(join(scratch, 'main.cjs'), `
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), path = require('node:path');
app.setPath('userData', path.join(__dirname, 'profile'));
app.commandLine.appendSwitch('use-mock-keychain');
const timeout = setTimeout(() => app.exit(1), 30000);
ipcMain.once('result', (_, data) => {
  if (data.facts.error) { console.error(data.facts.error); app.exit(1); return; }
  for (const [name, url] of Object.entries(data.images)) {
    if (!['cotton','linen','moonlit','midnight'].includes(name)) throw Error('Unexpected asset');
    fs.writeFileSync(path.join(${JSON.stringify(assets)}, 'paper-' + name + '.png'), Buffer.from(url.split(',')[1], 'base64'));
  }
  console.log(JSON.stringify(data.facts)); clearTimeout(timeout); app.exit(0);
});
app.whenReady().then(() => {
 const win = new BrowserWindow({show:false, webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:false}});
 win.loadFile(path.join(__dirname,'index.html'));
});`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const run = spawnSync(require('electron'), [join(scratch, 'main.cjs')], { env, stdio: 'inherit', timeout: 35000 })
  if (run.error || run.status !== 0) throw run.error ?? Error(`Renderer exited ${run.status}`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
