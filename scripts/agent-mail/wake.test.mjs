import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, appendFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Mailbox } from './mail.mjs'
import { emptyCodexPrompt, transcriptPhase, startMailWake } from './wake.mjs'
const wait = ms => new Promise(r => setTimeout(r,ms))
const event = type => JSON.stringify({type:'event_msg',payload:{type}})+'\n'

test('closed-set composer detection refuses drafts, questions and running turns',()=>{
  const clean='last answer\n\n› Ask Codex to do anything\n\nGPT-6-Astra high · Context 40% left\n? for shortcuts\n'
  assert.equal(emptyCodexPrompt(clean),true)
  assert.equal(emptyCodexPrompt(clean.replace('Ask Codex to do anything','my private draft')),false)
  assert.equal(emptyCodexPrompt(clean.replace('last answer','Working (esc to interrupt)')),false)
  assert.equal(emptyCodexPrompt(clean.replace('last answer','Queued follow-up inputs')),false)
  assert.equal(emptyCodexPrompt('shell $'),false)
})
test('native lifecycle last event governs idle; missing/truncated evidence stays unknown',t=>{
  const dir=mkdtempSync(join(tmpdir(),'im-phase-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const p=join(dir,'rollout-session1.jsonl')
  writeFileSync(p,event('task_started'));assert.equal(transcriptPhase(p,'session1'),'working')
  appendFileSync(p,event('turn_aborted'));assert.equal(transcriptPhase(p,'session1'),'interrupted')
  appendFileSync(p,event('task_started')+event('task_complete'));assert.equal(transcriptPhase(p,'session1'),'idle')
  assert.equal(transcriptPhase(p,'other-session'),'unknown')
  appendFileSync(p,'x'.repeat(70000));assert.equal(transcriptPhase(p,'session1'),'unknown')
})
test('file-driven wake coalesces mail, holds interrupted, and never resends a claimed batch',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'im-wake-'));let stop
  t.after(()=>{stop?.();rmSync(dir,{recursive:true,force:true})})
  const db=join(dir,'mail.sqlite'),config=join(dir,'team.json'),pointer=join(dir,'pointer.json'),trace=join(dir,'rollout-s2.jsonl')
  const b=new Mailbox(db);t.after(()=>b.close());b.bind('a','s1');b.bind('b','s2')
  mkdirSync(join(dir,'health'))
  writeFileSync(config,JSON.stringify({db,command:'mail',members:{b:{node:'node-b',session:'s2',wake:true,transcript:trace}}}))
  writeFileSync(pointer,JSON.stringify({enabled:true,projectId:'p',teamConfig:config}))
  writeFileSync(trace,event('turn_aborted'))
  for(let i=0;i<20;i++)b.send('a','s1',{to:'b',thread:'t',body:'m'+i,key:'m'+i})
  let calls=0
  stop=startMailWake(pointer,{authorized:()=>true,wake:async (_m,text,ready,claim)=>{
    assert.ok(ready());assert.ok(text.includes('20'));assert.ok(claim());calls++;return 'sent'
  }})
  await wait(500);assert.equal(calls,0)
  appendFileSync(trace,event('task_started')+event('task_complete'))
  await wait(700);assert.equal(calls,1)
  appendFileSync(trace,event('task_complete'));await wait(500);assert.equal(calls,1)
  assert.equal(b.status('b','s2').unread,20)
})
test('held wake never claims mail or spins on its own writes',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'im-held-'));let stop
  t.after(()=>{stop?.();rmSync(dir,{recursive:true,force:true})})
  const db=join(dir,'mail.sqlite'),trace=join(dir,'rollout-s2.jsonl'),config=join(dir,'team.json'),pointer=join(dir,'pointer.json')
  const b=new Mailbox(db);t.after(()=>b.close());b.bind('a','s1');b.bind('b','s2');b.send('a','s1',{to:'b',thread:'t',key:'m',body:'m'})
  writeFileSync(trace,event('task_complete'));writeFileSync(config,JSON.stringify({db,command:'mail',members:{b:{node:'b',session:'s2',wake:true,transcript:trace}}}));writeFileSync(pointer,JSON.stringify({enabled:true,projectId:'p',teamConfig:config}))
  let calls=0;stop=startMailWake(pointer,{authorized:()=>true,wake:async()=>{calls++;return 'held'}})
  await wait(1000);assert.equal(calls,1);assert.equal(b.db.prepare('SELECT notified FROM members WHERE name=?').get('b').notified,0)
})

test('opt-out during terminal observation prevents the final write',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'im-disable-'));let stop
  t.after(()=>{stop?.();rmSync(dir,{recursive:true,force:true})})
  const db=join(dir,'mail.sqlite'),trace=join(dir,'rollout-s2.jsonl'),config=join(dir,'team.json'),pointer=join(dir,'pointer.json')
  const b=new Mailbox(db);t.after(()=>b.close());b.bind('a','s1');b.bind('b','s2');b.send('a','s1',{to:'b',thread:'t',key:'m',body:'m'})
  writeFileSync(trace,event('task_complete'));writeFileSync(config,JSON.stringify({db,command:'mail',members:{b:{node:'b',session:'s2',wake:true,transcript:trace}}}));writeFileSync(pointer,JSON.stringify({enabled:true,projectId:'p',teamConfig:config}))
  let checked=false
  stop=startMailWake(pointer,{authorized:()=>true,wake:async (_member,_prompt,ready)=>{
    assert.equal(ready(),true)
    writeFileSync(pointer,JSON.stringify({enabled:false,projectId:'p',teamConfig:config}))
    assert.equal(ready(),false);checked=true;return 'held'
  }})
  await wait(700);assert.equal(checked,true)
  assert.equal(b.db.prepare('SELECT notified FROM members WHERE name=?').get('b').notified,0)
})

test('passive hook notice cannot suppress later idle mail; wake dedupe survives restart',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'im-hook-idle-'));let stop
  t.after(()=>{stop?.();rmSync(dir,{recursive:true,force:true})})
  const db=join(dir,'mail.sqlite'),config=join(dir,'team.json'),pointer=join(dir,'pointer.json'),trace=join(dir,'rollout-s2.jsonl')
  const b=new Mailbox(db);t.after(()=>b.close());b.bind('a','s1');b.bind('b','s2')
  writeFileSync(config,JSON.stringify({db,command:'mail',members:{b:{node:'b',session:'s2',wake:true,transcript:trace}}}))
  writeFileSync(pointer,JSON.stringify({enabled:true,projectId:'p',teamConfig:config}))
  writeFileSync(trace,event('task_started'))
  const first=b.send('a','s1',{to:'b',thread:'t',key:'first',body:'first'})
  assert.ok(b.notice('b','s2','PostToolUse','work-turn'))
  let calls=0
  const deps={authorized:()=>true,wake:async (_m,_text,ready,claim)=>{
    assert.ok(ready());assert.ok(claim());calls++;return 'sent'
  }}
  stop=startMailWake(pointer,deps)
  await wait(500);assert.equal(calls,0)
  appendFileSync(trace,event('task_complete'))
  await wait(600);assert.equal(calls,1)
  assert.equal(b.db.prepare('SELECT wake_through FROM members WHERE name=?').get('b').wake_through,first.id)
  // The first message remains unread, as in the incident. New idle mail still wakes.
  const next=b.send('a','s1',{to:'b',thread:'t',key:'later',body:'later while idle'})
  await wait(600);assert.equal(calls,2)
  assert.equal(b.db.prepare('SELECT wake_through FROM members WHERE name=?').get('b').wake_through,next.id)
  b.notice('b','s2','PostToolUse','new-work-turn')
  stop();stop=startMailWake(pointer,deps)
  await wait(600);assert.equal(calls,2)
  assert.equal(b.status('b','s2').unread,2)
})
