import {it,expect} from 'vitest'
import {writeFileSync,mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {buildManagedScript} from './managed-script'
import {testTmpDir} from '../../test-tmp'
it('Qoder hook forwards only the successful metadata response to native stdout',()=>{
 const dir=testTmpDir('im-native-');const bin=join(dir,'bin');mkdirSync(bin)
 const endpoint=join(dir,'endpoint.env');writeFileSync(endpoint,'NODETERM_HOOK_PORT=1\nNODETERM_HOOK_TOKEN=test\n')
 writeFileSync(join(bin,'curl'),`#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = '-o' ]; then shift; out="$1"; fi; shift; done\ncat >/dev/null\nprintf '%s' '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"[NODETERM_IM] 2 unread"}}' > "$out"\nprintf 200\n`,{mode:0o755})
 const file=join(dir,'qoder.sh');writeFileSync(file,buildManagedScript('qoder'))
 const result=spawnSync('sh',[file],{input:'{"session_id":"test","hook_event_name":"PostToolUse"}',encoding:'utf8',timeout:5000,env:{...process.env,PATH:bin+':'+process.env.PATH,NODETERM_NODE_ID:'test-node',NODETERM_HOOK_ENDPOINT:endpoint,CODEX_THREAD_ID:''}})
 expect(result.status,result.stderr).toBe(0)
 expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toBe('[NODETERM_IM] 2 unread')
})
