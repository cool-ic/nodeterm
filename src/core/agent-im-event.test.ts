import {it,expect} from 'vitest'
import {imLifecycleEvent} from './agent-im-event'
it('does not mistake Qoder idle rescue for a user interruption',()=>{
 const base={nodeId:'n',agentId:'qoder' as const,kind:'state' as const,state:'done' as const}
 expect(imLifecycleEvent({...base,idle:true,interrupted:true})).toBeUndefined()
 expect(imLifecycleEvent({...base,interrupted:true})).toBe('interrupt')
 expect(imLifecycleEvent(base)).toBe('idle')
 expect(imLifecycleEvent({...base,state:'working',newTurn:true})).toBe('resume')
})

it('maps native exit and explicit session resume separately from inferred idle',()=>{
 const base={nodeId:'n',agentId:'qoder' as const,kind:'session' as const}
 expect(imLifecycleEvent({...base,sessionPhase:'end'})).toBe('exit')
 expect(imLifecycleEvent({...base,sessionPhase:'start'})).toBe('start')
 expect(imLifecycleEvent({...base,sessionPhase:'start',sessionResumed:true})).toBe('restored-idle')
})
