import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdir,mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {apply} from '../dist/agent.js'

test('headless plugin exposes all Android functions to the model prompt and dispatches without a web server or panel',async()=>{
 await mkdir('.build/tests',{recursive:true});const directory=await mkdtemp(join(process.cwd(),'.build/tests/agent-entry-')),ctx=new Context();let promptTools
 ctx.provide('systemPrompt',{tools(provider){promptTools=provider}})
 const registry=new ToolRuntime(ctx)
 ctx.provide('attachments',{async saveImage(){throw new Error('No phone observation requested')},async readImage(){throw new Error('No historical images requested')}})
 ctx.provide('llm',{async resolveModelInfo(){return{inputModalities:['text']}}})
 try{
  await apply(ctx,{dataDir:directory})
  const agent={id:'headless-agent',options:{},session:{requestContext:()=>({provider:'fixture',model:'text'})}}
  const modelTools=promptTools({scope:agent}).schemas
  assert.equal(modelTools.length,44)
  assert.deepEqual(modelTools.map(t=>t.name).sort(),registry.schemas(agent).map(t=>t.name).sort())
  for(const name of ['android_notifications','android_wait_notification','android_wait_app','android_media_query','android_pick_file','android_file_stat','android_file_manage','android_open_file','android_share_file','android_wait_file','android_transfer_status','android_transfer_cancel','android_device_state','android_app_info','android_open_uri','android_stop_app','android_gesture','android_files','android_push_file','android_pull_file','android_install_apk','android_clipboard','android_device_control','android_capture_settings','android_recording','android_results','android_read_result'])assert(modelTools.some(tool=>tool.name===name),name)
  let n=0;const call=(name,args)=>registry.execute({name,arguments:args,callId:'headless-'+ ++n,agent,signal:AbortSignal.timeout(10000)})
  const settings=await call('android_capture_settings',{action:'get'});assert.equal(settings.isError,false);assert.equal(settings.value.saved.audio,false)
  const saved=await call('android_capture_settings',{action:'set',max_size:1440,audio:true});assert.equal(saved.isError,false);assert.equal(saved.value.saved.maxSize,1440);assert.equal(saved.value.active,null)
  const recording=await call('android_recording',{action:'status'});assert.equal(recording.isError,false);assert.equal(recording.value.current,null)
  const history=await call('android_results',{});assert.equal(history.isError,false);assert.equal(history.value.total,0)
 }finally{await ctx.fiber.dispose()}
})
