import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { AndroidRuntime } from '../dist/runtime.js'
import { DeviceService } from '../dist/device.js'
import { registerAndroidTools } from '../dist/tools.js'
await mkdir('.build/evidence',{recursive:true})
const runtime = new AndroidRuntime(new DeviceService({adbPath:'D:/android/sdk/platform-tools/adb.exe'}))
const ctx = new Context(); ctx.provide('systemPrompt',{tools(){}})
const registry = new ToolRuntime(ctx)
ctx.provide('llm',{async resolveModelInfo(){return {inputModalities:['text']}}})
let image=0
ctx.provide('attachments',{async saveImage({data}){const name=`native-device-${++image}.png`;await writeFile(`.build/evidence/${name}`,data);return {attachmentId:name,mediaType:'image/png',bytes:data.length,width:1080,height:2400}}})
registerAndroidTools(ctx,runtime)
const agent = {id:'native-device-smoke',session:{requestContext:()=>({provider:'integration',model:'no-model'})},options:{}}
const results=[]; let call=0
async function run(name,args={}) {
  const result=await registry.execute({callId:`native-${++call}`,name,arguments:args,agent,signal:AbortSignal.timeout(30000)})
  results.push({name,args,result});assert.equal(result.isError,false,JSON.stringify(result));return result.value
}
try {
  const devices=await run('android_devices'); assert(devices.devices.some(d=>d.state==='device'))
  await run('android_open_app',{package_name:'com.android.settings'});await delay(1000)
  let observation=await run('android_observe')
  console.log('Settings',observation.elements.map(e=>[e.element_id,e.text,e.description]).filter(e=>e[1]||e[2]))
  for(let back=0;back<3&&!observation.elements.some(e=>/^(我的设备|关于手机|About phone|My device)$/.test(e.text));back++) { await run('android_key',{key:'back'});await delay(700);observation=await run('android_observe') }
  const about=observation.elements.find(e=>/^(我的设备|关于手机|About phone|My device)$/.test(e.text))
  assert(about,'About phone entry must be observed')
  await run('android_tap',{observation_id:observation.observation_id,element_id:about.element_id});await delay(700)
  observation=await run('android_observe')
  console.log('About',observation.elements.map(e=>[e.element_id,e.text,e.description]).filter(e=>e[1]||e[2]))
  for(let scroll=0;scroll<3&&!observation.elements.some(e=>/Android|全部参数|详细信息与规格/.test(e.text));scroll++) {
    await run('android_swipe',{observation_id:observation.observation_id,x1:Math.round(observation.width*.6),y1:Math.round(observation.height*.8),x2:Math.round(observation.width*.6),y2:Math.round(observation.height*.3),duration_ms:500});await delay(600);observation=await run('android_observe')
  }
  const details=observation.elements.find(e=>/全部参数与信息|全部参数|详细信息与规格|Detailed info|All specs/.test(e.text))
  if(details){await run('android_tap',{observation_id:observation.observation_id,element_id:details.element_id});await delay(700);observation=await run('android_observe');console.log('Details',observation.elements.map(e=>[e.element_id,e.text]).filter(e=>e[1]))}
  assert(observation.elements.some(e=>/Android/.test(e.text+' '+e.description)),'Android version must appear in observed UI')
  await run('android_key',{key:'home'});await delay(700)
  const home=await run('android_observe');assert(home.elements.some(e=>/launcher|com\.miui\.home/i.test(e.resource_id+' '+e.package_name)),'Home launcher must be observed')
  const old=home.observation_id;await runtime.manual('test-viewer',{kind:'key',key:'home'})
  const denied=await registry.execute({callId:'takeover-test',name:'android_tap',arguments:{observation_id:old,x:100,y:100},agent,signal:AbortSignal.timeout(5000)})
  assert.equal(denied.isError,true);results.push({name:'manual-input-invalidates-observation',result:denied})
  await run('android_observe');await run('android_release')
  await writeFile('.build/evidence/native-device.json',JSON.stringify({pass:true,kind:'real-device + Harness ToolRuntime; no model invocation',results},null,2))
  console.log('PASS native registry → real phone → observed Android info → observed Home → shared input')
} finally {await runtime.close();await ctx.fiber.dispose()}
