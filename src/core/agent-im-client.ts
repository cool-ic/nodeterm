/** Installed by nodeterm. No CLI-specific session variables or project wrappers. */
export const IM_CLIENT_SOURCE = String.raw`
import {readFileSync} from 'node:fs';
import {request} from 'node:http';
import {dirname,join} from 'node:path';
if(process.argv.length<3 || ['--help','help'].includes(process.argv[2])) {
 console.log('Nodeterm IM: status | roster | list | read [thread] | ack <receipt> | history <thread> [after] | send (JSON stdin: to=node ID, thread, key, body, optional supersedes)');process.exit(0);
}
const env={...process.env};
if(env.NODETERM_HOOK_ENDPOINT){
 for(const line of readFileSync(env.NODETERM_HOOK_ENDPOINT,'utf8').split('\n')){
  const m=line.match(/^(NODETERM_[A-Z_]+)=(.*)$/);if(!m)continue;
  const v=m[2];env[m[1]]=v.startsWith("'")?v.slice(1,-1).replaceAll("'\\''","'"):v;
 }
}
const node=env.NODETERM_NODE_ID;
if(!node||!/^[a-zA-Z0-9_-]+$/.test(node))throw Error('Not a nodeterm node');
const token=readFileSync(join(env.NODETERM_NODE_TOKEN_DIR||join(dirname(env.NODETERM_HOOK_ENDPOINT),'node-tokens'),node),'utf8').trim();
const [operation,...args]=process.argv.slice(2);
const input=operation==='send'?JSON.parse(readFileSync(0,'utf8')):undefined;
const body=JSON.stringify({nodeId:node,operation,args,input});
const result=await new Promise((resolve,reject)=>{
 const r=request({...(env.NODETERM_HOOK_SOCK?{socketPath:env.NODETERM_HOOK_SOCK}:{host:'127.0.0.1',port:Number(env.NODETERM_HOOK_PORT)}),path:'/im',method:'POST',headers:{'X-Nodeterm-Hook-Token':env.NODETERM_HOOK_TOKEN,'X-Nodeterm-Node-Token':token,'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{
  let text='';res.on('data',c=>text+=c);res.on('end',()=>{try{const d=JSON.parse(text);if(!d.ok)throw Error(d.error||'IM refused');resolve(d.result)}catch(e){reject(e)}});
 });r.setTimeout(5000,()=>r.destroy(Error('IM endpoint timeout')));r.on('error',reject);r.end(body);
});
console.log(JSON.stringify(result));
`
