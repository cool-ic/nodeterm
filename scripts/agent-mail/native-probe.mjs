// Opt-in integration probe: two disposable Codex exec sessions, isolated hooks/config,
// existing login referenced by symlink (never copied or printed). No canvas or global writes.
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, realpathSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { Mailbox } from './mail.mjs'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'nodeterm-mail-native-')))
const moduleURL = new URL('./mail.mjs', import.meta.url).href
const db = join(root, 'mail.sqlite')
const canvasMode = process.argv.includes('--canvas')
const hook = join(root, 'hook.mjs'), actions = join(root, 'actions.mjs')
const sleep = ms => new Promise(r => setTimeout(r,ms))
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'"
writeFileSync(hook, `import {readFileSync,writeFileSync,appendFileSync,existsSync} from 'node:fs';
import {run} from ${JSON.stringify(moduleURL)};
const p=JSON.parse(readFileSync(0,'utf8'));const dir=process.env.PROBE_DIR;
writeFileSync(dir+'/session',p.session_id);
writeFileSync(dir+'/node',process.env.NODETERM_NODE_ID||'exec');
if(p.hook_event_name==='SessionStart'){
 for(let i=0;i<200&&!existsSync(dir+'/bound');i++)await new Promise(r=>setTimeout(r,50));
}
const out=run(['hook'],JSON.stringify(p));
appendFileSync(dir+'/hooks.jsonl',JSON.stringify({event:p.hook_event_name,source:p.source,session:p.session_id,output:out})+'\\n');
if(out)console.log(JSON.stringify(out));
`)
writeFileSync(actions, `import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {run} from ${JSON.stringify(moduleURL)};
const op=process.argv[2],root=${JSON.stringify(root)};
process.env.NODETERM_MAIL_SESSION=readFileSync(process.env.PROBE_DIR+'/session','utf8');
if(op==='send-batch'){
 for(let i=0;i<20;i++)run(['send'],JSON.stringify({to:'receiver',thread:'probe',key:'m'+i,body:'Validation item '+i}));
 writeFileSync(root+'/sent','20');writeFileSync(process.env.PROBE_DIR+'/done','sent');console.log('20 messages stored');
}else if(op==='barrier'){
 for(let i=0;i<1200&&!existsSync(root+'/sent');i++)await new Promise(r=>setTimeout(r,100));
 if(!existsSync(root+'/sent'))throw Error('Sender timeout');console.log('Mailbox batch ready');
}else if(op==='defer'){
 const x=run(['status'],'');if(x.unread!==20)throw Error('Unread lost before ack');console.log('Deferred; unread='+x.unread);
}else {const out=run(process.argv.slice(2),'');console.log(JSON.stringify(out));
 if(op==='status'&&out.unread===0)writeFileSync(process.env.PROBE_DIR+'/done','read');}
`)

const userConfig = readFileSync(join(homedir(),'.codex/config.toml'),'utf8')
const modelConfig = userConfig.split('\n').filter(x=>/^model(?:_reasoning_effort)?\s*=/.test(x)).join('\n')
const children=[]
for(const agent of ['sender','receiver']){
  const dir=join(root,agent),home=join(dir,'codex-home');mkdirSync(home,{recursive:true,mode:0o700})
  symlinkSync(join(homedir(),'.codex/auth.json'),join(home,'auth.json'))
  const command=`${quote(process.execPath)} --no-warnings ${quote(hook)}`
  const hooks={hooks:{}}
  let config=modelConfig+'\napproval_policy="never"\nsandbox_mode="workspace-write"\n'
  for(const [event,label] of [['SessionStart','session_start'],['PostToolUse','post_tool_use']]){
    hooks.hooks[event]=[{hooks:[{type:'command',command,timeout:20}]}]
    const canonical={event_name:label,hooks:[{async:false,command,timeout:20,type:'command'}]}
    const hash='sha256:'+createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
    config+=`\n[hooks.state.${JSON.stringify(join(home,'hooks.json')+':'+label+':0:0')}]\nenabled=true\ntrusted_hash=${JSON.stringify(hash)}\n`
  }
  if (canvasMode) {
    // Keep nodeterm's own status/identity hooks in the disposable home. No global edits.
    const installed=JSON.parse(readFileSync(join(homedir(),'.codex/hooks.json'),'utf8'))
    const labels={SessionStart:'session_start',UserPromptSubmit:'user_prompt_submit',PreToolUse:'pre_tool_use',
      PermissionRequest:'permission_request',PostToolUse:'post_tool_use',SubagentStart:'subagent_start',
      SubagentStop:'subagent_stop',Stop:'stop'}
    for(const [event,groups] of Object.entries(installed.hooks))for(const group of groups){
      const handlers=group.hooks.filter(h=>h.command?.includes('.nodeterm/agent-hooks/codex.sh'))
      if(!handlers.length)continue
      const defs=hooks.hooks[event]??=[];const gi=defs.length
      defs.push({...group,hooks:handlers})
      for(const [hi,h] of handlers.entries()){
        const normalized={async:h.async??false,command:h.command,timeout:h.timeout??600,type:'command'}
        if(h.statusMessage!==undefined)normalized.statusMessage=h.statusMessage
        const sort=o=>Array.isArray(o)?o.map(sort):o&&typeof o==='object'?Object.fromEntries(Object.keys(o).sort().map(k=>[k,sort(o[k])])):o
        const identity={event_name:labels[event],hooks:[normalized]}
        if(group.matcher!==undefined)identity.matcher=group.matcher
        const hash='sha256:'+createHash('sha256').update(JSON.stringify(sort(identity))).digest('hex')
        config+=`\n[hooks.state.${JSON.stringify(join(home,'hooks.json')+':'+labels[event]+':'+gi+':'+hi)}]\nenabled=true\ntrusted_hash=${JSON.stringify(hash)}\n`
      }
    }
  }
  writeFileSync(join(home,'hooks.json'),JSON.stringify(hooks))
  config+=`\n[projects.${JSON.stringify(dir)}]\ntrust_level="trusted"\n`
  writeFileSync(join(home,'config.toml'),config)
  const base=`You are a temporary local mailbox integration test. Only run the explicitly provided local node commands. Do not browse, edit source, contact other agents, read credentials, or access other projects. The mail command is: ${quote(process.execPath)} --no-warnings ${quote(actions)}. `
  const prompt=agent==='sender'
    ?base+'Run the mail command with send-batch exactly once, then finish with SENT20.'
    :base+'First run the mail command with barrier. Then check whether a native hook supplied a [NODETERM_MAIL] notification. Do not assume one exists. If present, first run defer to prove unread may be deferred, then read (without a thread argument), confirm all 20 messages were returned, and ack the actual returned receipt. Finally run status. Finish reporting whether you SAW_NATIVE_NOTICE, how many messages you read, and final unread count. If no hook notice was received, report NO_NATIVE_NOTICE and do not fake it.'
  const env={...process.env,CODEX_HOME:home,PROBE_DIR:dir,NODETERM_MAIL_DB:db,NODETERM_MAIL_AGENT:agent}
  if(canvasMode){
    writeFileSync(join(dir,'launch.sh'),`#!/bin/sh\nexport CODEX_HOME=${quote(home)} PROBE_DIR=${quote(dir)} NODETERM_MAIL_DB=${quote(db)} NODETERM_MAIL_AGENT=${quote(agent)}\nexec codex --no-daemon -C ${quote(dir)} --add-dir ${quote(root)} ${quote(prompt)}\n`)
    children.push({agent,dir,done:false,code:null});continue
  }
  for(const k of Object.keys(env))if(k.startsWith('NODETERM_')&&!k.startsWith('NODETERM_MAIL_'))delete env[k]
  const child=spawn('codex',['exec','--json','--ephemeral','--skip-git-repo-check','-C',dir,'--add-dir',root,prompt],{env,stdio:['ignore','pipe','pipe']})
  const entry={agent,dir,child,done:false,code:null};children.push(entry)
  child.stdout.on('data',x=>appendFileSync(join(dir,'events.jsonl'),x))
  child.stderr.on('data',x=>appendFileSync(join(dir,'stderr.log'),x))
  child.on('exit',code=>{entry.done=true;entry.code=code})
}
console.log('Evidence directory:',root)
if(canvasMode)writeFileSync(join(root,'canvas.json'),JSON.stringify({root,db,launchers:children.map(x=>({agent:x.agent,path:join(x.dir,'launch.sh')}))}))
const b=new Mailbox(db)
const deadline=Date.now()+240000
try{
  while(Date.now()<deadline&&!children.every(x=>x.done)){
    for(const c of children)if(existsSync(join(c.dir,'session'))&&!existsSync(join(c.dir,'bound'))){
      const session=readFileSync(join(c.dir,'session'),'utf8');b.bind(c.agent,session);writeFileSync(join(c.dir,'bound'),'bound')
    }
    if(canvasMode)for(const c of children)if(existsSync(join(c.dir,'done'))){c.done=true;c.code=0}
    await sleep(100)
  }
  const receiver=children[1], sid=existsSync(join(receiver.dir,'session'))?readFileSync(join(receiver.dir,'session'),'utf8'):null
  const hookRuns=existsSync(join(receiver.dir,'hooks.jsonl'))?readFileSync(join(receiver.dir,'hooks.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[]
  const notices=hookRuns.filter(x=>x.output).length
  const status=sid?b.status('receiver',sid):null
  const result={sessions:children.map(x=>({agent:x.agent,exitCode:x.code,finished:x.done})),notices,status}
  writeFileSync(join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
  if(children.some(x=>!x.done||x.code!==0)||notices!==1||status?.unread!==0)process.exitCode=1
}finally{
  for(const c of children)if(!c.done&&c.child)c.child.kill('SIGTERM')
  // Keep only test evidence, not downloaded plugin caches or a lingering login symlink.
  for(const c of children)if(c.done&&!canvasMode)rmSync(join(c.dir,'codex-home'),{recursive:true,force:true})
  b.close()
}
