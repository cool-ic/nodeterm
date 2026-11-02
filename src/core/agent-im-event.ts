import type {NormalizedAgentEvent} from '../shared/agents/normalize'
/** Idle rescue is not an explicit interrupt or a trusted turn completion. */
export function imLifecycleEvent(e:NormalizedAgentEvent):string|undefined {
 if(e.kind==='session' && e.sessionPhase==='end')return 'exit'
 if(e.kind==='session' && e.sessionPhase==='start')return e.sessionResumed?'restored-idle':'start'
 if(e.idle)return undefined
 if(e.interrupted)return 'interrupt'
 if(e.errored)return 'approval'
 if(e.state==='blocked'||e.state==='waiting')return 'approval'
 if(e.state==='done')return 'idle'
 if(e.newTurn)return 'resume'
 if(e.state==='working')return 'working'
 return undefined
}
