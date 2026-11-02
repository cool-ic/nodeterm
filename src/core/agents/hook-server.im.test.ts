import {it,expect,vi} from 'vitest'
import {rmSync} from 'node:fs'
import {testTmpDir} from '../test-tmp'
import {HookServer} from './hook-server'
import {nodeAuthToken} from './node-auth-token'
import {initPlatform,resetPlatformForTests} from '../platform'
import {fakePlatform} from '../platform-fake'
it('IM route requires a verified node and returns structured refusals',async()=>{
 const dir=testTmpDir('nt-im-');resetPlatformForTests();initPlatform(fakePlatform({userDataDir:dir}))
 const server=new HookServer();const secret=Buffer.alloc(32,7);server.setNodeAuthSecret(secret)
 const handler=vi.fn((node:string,op:string)=>{if(op==='bad')throw Error('Unsupported operation');return{node,unread:2}});server.setImHandler(handler)
 try{
  await server.start()
  const call=(token:string,operation='status')=>fetch(`http://127.0.0.1:${server.getPort()}/im`,{method:'POST',headers:{'X-Nodeterm-Hook-Token':server.getToken(),'X-Nodeterm-Node-Token':token,'content-type':'application/json'},body:JSON.stringify({nodeId:'test-node',operation})})
  expect((await call('forged')).status).toBe(403);expect(handler).not.toHaveBeenCalled()
  const token=nodeAuthToken(secret,'test-node')
  const ok=await call(token);expect(ok.status).toBe(200);expect(await ok.json()).toEqual({ok:true,result:{node:'test-node',unread:2}})
  const bad=await call(token,'bad');expect(bad.status).toBe(400);expect(await bad.json()).toEqual({ok:false,error:'Unsupported operation'})
 }finally{server.stop();rmSync(dir,{recursive:true,force:true})}
})
