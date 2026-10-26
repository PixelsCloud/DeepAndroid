import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { AndroidRuntime } from '../dist/runtime.js'
import { DeviceService } from '../dist/device.js'
import { registerAndroidTools } from '../dist/tools.js'
await mkdir('.build/evidence',{recursive:true})
const runtime=new AndroidRuntime(new DeviceService({adbPath:'D:/android/sdk/platform-tools/adb.exe'}))
const ctx=new Context();ctx.provide('systemPrompt',{tools(){}});const registry=new ToolRuntime(ctx)
ctx.provide('llm',{async resolveModelInfo(){return {inputModalities:['text']}}})
let image=0
ctx.provide('attachments',{async saveImage({data}){const name=`search-${++image}.png`;await writeFile(`.build/evidence/${name}`,data);return {attachmentId:name,mediaType:'image/png',bytes:data.length,width:1080,height:2400}}})
registerAndroidTools(ctx,runtime)
const agent={id:'native-search-smoke',session:{requestContext:()=>({provider:'integration',model:'no-model'})},options:{}}
const results=[],queries=[];let call=0
async function run(name,args={}) {
  const result=await registry.execute({callId:`search-${++call}`,name,arguments:args,agent,signal:AbortSignal.timeout(65000)})
  results.push({name,args,result});assert.equal(result.isError,false,JSON.stringify(result));return result.value
}
try {
  const apps=await run('android_apps',{query:'设置'});assert(apps.apps.some(app=>app.name==='设置'&&app.package_name==='com.android.settings'))
  const opened=await run('android_open_app',{app_name:'设置'});assert.equal(opened.status,'sent');assert.equal(opened.app.package_name,'com.android.settings')
  const search=await run('android_scroll_find',{text:'搜索',package_name:'com.android.settings',direction:'up',scroll_resource_id:'com.android.settings:id/scroll_headers',max_scrolls:7})
  console.log('Search targets',search.status,search.matches?.map(e=>({id:e.element_id,text:e.text,description:e.description,class:e.class_name})))
  assert.equal(search.status,'found')
  const field=search.matches.find(e=>e.editable)||search.matches[0]
  await run('android_tap',{observation_id:search.observation_id,element_id:field.element_id})
  let current=await run('android_find',{editable:true,package_name:'com.android.settings',max_attempts:3})
  console.log('Editors',current.matches?.map(e=>({id:e.element_id,text:e.text,focused:e.focused,resource:e.resource_id})))
  assert(current.matches.some(e=>e.focused),'Search editor must be visibly focused')
  for(const text of ['电池','显示']) {
    await run('android_input_text',{observation_id:current.observation_id,text,replace:true})
    current=await run('android_find',{text,class_name:'android.widget.TextView',package_name:'com.android.settings',max_attempts:3})
    console.log('Search results',text,current.status,current.matches?.map(e=>e.text||e.description))
    assert.equal(current.status,'found')
    assert(current.elements.some(e=>e.editable&&e.focused&&e.text===text),'Exact editor text must match, including replacement')
    queries.push({text,attempts:current.attempts,matches:current.matches.map(e=>({text:e.text,description:e.description,resource_id:e.resource_id}))})
  }
  const missing=await run('android_find',{text:'__dsh_target_that_does_not_exist__',exact:true,max_attempts:2,interval_ms:100})
  assert.equal(missing.status,'not_found');assert.equal(missing.attempts,2);assert.deepEqual(missing.matches,[])
  await run('android_key',{key:'home'})
  const home=await run('android_observe');assert(home.elements.some(e=>e.package_name==='com.miui.home'))
  await run('android_release')
  await writeFile('.build/evidence/search-smoke.json',JSON.stringify({pass:true,kind:'real phone + actual Harness native registry; no model invocation',queries,missingTargetAttempts:missing.attempts,homeObserved:true,results},null,2))
  console.log('PASS localized app name → focused Chinese search → verified results → replace query → bounded missing target → Home')
} catch(error) {
  await writeFile('.build/evidence/search-failure.json',JSON.stringify({pass:false,error:String(error),queries,results},null,2))
  throw error
} finally {await runtime.close();await ctx.fiber.dispose()}
