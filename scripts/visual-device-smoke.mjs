import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { PNG } from 'pngjs'
import { AndroidRuntime } from '../dist/runtime.js'
import { registerAndroidTools } from '../dist/tools.js'

await mkdir('.build/evidence', {recursive:true})
const ctx=new Context();ctx.provide('systemPrompt',{tools(){}})
const registry=new ToolRuntime(ctx),runtime=new AndroidRuntime(),results=[]
let images=0,callId=0,treeCalls=0
const dump=runtime.backend.dumpUi.bind(runtime.backend)
runtime.backend.dumpUi=(...args)=>{treeCalls++;return dump(...args)}
ctx.provide('llm',{async resolveModelInfo(){return{inputModalities:['text','image']}}})
ctx.provide('attachments',{async saveImage({data}){
  const png=PNG.sync.read(data),name='visual-device-'+(++images)
  await writeFile('.build/evidence/'+name+'.png',data)
  return{attachmentId:name,mediaType:'image/png',bytes:data.length,width:png.width,height:png.height}
}})
registerAndroidTools(ctx,runtime)
const agent={id:'visual-device-smoke',options:{},session:{requestContext:()=>({provider:'fixture',model:'image-capable-test-route'})}}
async function call(name,args){
  const start=performance.now()
  const result=await registry.execute({name,arguments:args,callId:'visual-device-'+(++callId),agent,signal:AbortSignal.timeout(45000)})
  assert.equal(result.isError,false,JSON.stringify(result))
  assert(result.content.some(item=>item.type==='image'),'Image attachment missing')
  results.push({name,elapsed_ms:Math.round(performance.now()-start),value:result.value})
  console.log(JSON.stringify({name,status:result.value.status??'observed',elapsed_ms:results.at(-1).elapsed_ms,width:result.value.screenshot.width,height:result.value.screenshot.height}))
  return result.value
}
try{
  const devices=await runtime.list(agent.id),serial=process.argv[2]??devices.devices.find(device=>device.state==='device')?.serial
  assert(serial,'No authorized Android device');await runtime.bind(agent.id,serial)
  const full=await call('android_observe',{mode:'screenshot'})
  assert.equal(full.capture_mode,'screenshot');assert.equal(full.screen_fingerprint,undefined)
  const region={x:Math.floor(full.width/4),y:Math.floor(full.height/4),width:Math.floor(full.width/4),height:Math.floor(full.height/4)}
  const crop=await call('android_observe',{mode:'screenshot',region,scale:2})
  assert.equal(crop.width,full.width);assert.equal(crop.screenshot.width,region.width*2);assert.deepEqual(crop.image_transform.region,region)
  const after=await call('android_key',{key:'wake',return_screenshot:true,screenshot_delay_ms:300})
  assert.equal(after.action_sent,true);assert.equal(after.capture_mode,'screenshot');assert.notEqual(after.observation_id,crop.observation_id)
  const stable=await call('android_wait',{condition:'image_stable',region,stable_ms:600,timeout_ms:6000,interval_ms:300})
  assert(['met','timed_out'].includes(stable.status));assert.equal(stable.condition,'image_stable')
  const changed=await call('android_wait',{condition:'image_changed',region,timeout_ms:1600,interval_ms:300})
  assert(['met','timed_out'].includes(changed.status));assert.equal(changed.condition,'image_changed')
  assert.equal(treeCalls,0,'Visual calls must not dump UI')
  await writeFile('.build/evidence/visual-device.json',JSON.stringify({pass:true,kind:'real-device + Harness ToolRuntime; no model invocation',treeCalls,results},null,2))
  console.log('PASS: real-device screenshot/crop/post-action/wait via Harness; zero UI tree reads')
}finally{await runtime.close();await ctx.fiber.dispose()}
