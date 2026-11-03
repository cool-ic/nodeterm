import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ImRuntime} from './runtime.mjs'
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'im-runtime-'));const r=new ImRuntime(join(dir,'im.db'));t.after(()=>{r.close();rmSync(dir,{recursive:true})});return r}
const a={project:'p',node:'a',session:'sa',cli:'qoder',generation:'g1'}
const b={project:'p',node:'b',session:'sb',cli:'codex',generation:'g1'}
test('Qoder and Codex use the same identity and mailbox operations with project isolation',t=>{
 const r=fixture(t);r.attach(a);r.attach(b)
 r.dispatch(a,'send',[],{to:'b',thread:'job',key:'one',body:'task'})
 const batch=r.dispatch(b,'read');assert.equal(batch.messages[0].body,'task')
 assert.equal(r.dispatch(b,'status').unread,1);r.dispatch(b,'ack',[batch.receipt]);assert.equal(r.dispatch(b,'status').unread,0)
 const c={...b,project:'other',node:'c',session:'sc'};r.attach(c)
 assert.throws(()=>r.dispatch(c,'send',[],{to:'a',thread:'job',key:'two',body:'bad'}),/outside project/)
})
test('out of order events and new mail cannot clear interruption; stale lifecycle never wakes',t=>{
 const r=fixture(t);r.attach(a)
 r.observe(a,{sequence:2,event:'interrupt',at:100})
 assert.equal(r.observe(a,{sequence:1,event:'idle',at:101}),false)
 r.observe(a,{sequence:3,event:'idle',at:102})
 assert.equal(r.eligibility(a,{now:103}),'user-paused')
 r.observe(a,{sequence:4,event:'resume',at:104});r.observe(a,{sequence:5,event:'idle',at:105})
 assert.equal(r.eligibility(a,{now:106,draft:true}),'draft')
 assert.equal(r.eligibility(a,{now:106}),'ready')
 assert.equal(r.eligibility(a,{now:100000}),'stale')
})
test('restored process preserves mail but rejects old generation and old lifecycle',t=>{
 const r=fixture(t);r.attach(a);r.attach(b)
 r.dispatch(b,'send',[],{to:'a',thread:'job',key:'one',body:'persistent'})
 const restored={...a,generation:'g2'};r.attach(restored)
 assert.throws(()=>r.dispatch(a,'list'),/Stale/)
 assert.equal(r.dispatch(restored,'status').unread,1)
 assert.equal(r.eligibility(restored),'stale')
 assert.throws(()=>r.attach({...restored,session:'new'}),/takeover/)
})
test('idle notification is coalesced and independent from passive hook reminders',async t=>{
 const r=fixture(t);r.attach(a);r.attach(b)
 r.observe(b,{sequence:1,event:'idle'})
 r.dispatch(a,'send',[],{to:'b',thread:'job',key:'m1',body:'first'})
 const n=r.notice(b,{session_id:'sb',hook_event_name:'PostToolUse'},'im')
 assert.ok(n);assert.equal(JSON.stringify(n).includes('first'),false)
 let sends=0
 const transport=async(text,ready,claim)=>{assert.ok(ready());assert.ok(claim());sends++;return 'sent'}
 assert.equal(await r.wake(b,transport,'im'),'sent')
 assert.equal(await r.wake(b,transport,'im'),'empty')
 r.dispatch(a,'send',[],{to:'b',thread:'job',key:'m2',body:'second'})
 assert.equal(await r.wake(b,transport,'im'),'sent');assert.equal(sends,2)
 r.observe(b,{sequence:2,event:'interrupt'})
 r.dispatch(a,'send',[],{to:'b',thread:'job',key:'m3',body:'third'})
 assert.equal(await r.wake(b,transport,'im'),'held');assert.equal(sends,2)
})
test('passive notifications coalesce across tool callbacks within the same native turn',t=>{
 const r=fixture(t);r.attach(a);r.attach(b);r.observe(b,{sequence:1,event:'resume'})
 r.dispatch(a,'send',[],{to:'b',thread:'job',key:'one',body:'task'})
 const payload={session_id:'sb',hook_event_name:'PostToolUse'}
 assert.ok(r.notice(b,payload,'im'))
 r.observe(b,{sequence:2,event:'working'})
 assert.equal(r.notice(b,payload,'im'),null)
 r.observe(b,{sequence:3,event:'resume'})
 assert.ok(r.notice(b,payload,'im'))
})
test('app recovery requires identical live process proof and preserves wake claims',async t=>{
 const r=fixture(t);r.attach(a);r.attach(b);r.observe(b,{sequence:1,event:'idle'})
 const proof={pid:123,pane:'%5',tty:'/dev/ttys5',boot:1000};r.rememberOwner(b,proof)
 r.dispatch(a,'send',[],{to:'b',thread:'job',key:'one',body:'pending'})
 await r.wake(b,async(_t,_r,claim)=>{claim();return 'uncertain'},'im')
 const next={...b,generation:'g2'}
 assert.equal(r.recover(next,{...proof,pid:124}),false)
 assert.equal(r.recover(next,{...proof,boot:20000}),false)
 assert.equal(r.recover(next,proof),true)
 assert.equal(r.dispatch(next,'status').unread,1)
 assert.equal(await r.wake(next,async()=>{throw Error('duplicate wake')},'im'),'empty')
})
test('held diagnostics survive restart and existing mail wakes without sender resend when safe',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'im-held-recovery-'));const path=join(dir,'im.db')
 let r=new ImRuntime(path)
 t.after(()=>{r.close();rmSync(dir,{recursive:true})})
 r.attach(a);r.attach(b);r.observe(a,{sequence:1,event:'idle'})
 const proof={pid:123,pane:'%5',tty:'/dev/ttys5',boot:1000};r.rememberOwner(a,proof)
 r.dispatch(b,'send',[],{to:'a',thread:'job',key:'only-send',body:'already stored'})
 const reason='held:qoder-composer-footer-unknown'
 assert.equal(await r.wake(a,async()=>reason,'im'),reason)
 assert.equal(r.dispatch(a,'status').lastWake,reason)
 assert.equal(r.box.member('node:a','sa').wake_through,0)
 r.close();r=new ImRuntime(path)
 const restored={...a,generation:'g2'}
 assert.equal(r.recover(restored,proof),true)
 assert.equal(r.dispatch(restored,'status').lastWake,reason)
 let sends=0
 const safe=async(_text,ready,claim)=>{assert.equal(ready(),true);assert.equal(claim(),true);sends++;return 'sent'}
 assert.equal(await r.wake(restored,safe,'im'),'sent')
 assert.equal(await r.wake(restored,safe,'im'),'empty')
 assert.equal(sends,1)
 assert.equal(r.dispatch(restored,'status').unread,1)
 assert.equal(r.dispatch(restored,'read').messages[0].body,'already stored')
})
