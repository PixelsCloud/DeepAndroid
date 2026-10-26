import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { AndroidRuntime } from '../dist/runtime.js'
import { registerAndroidTools } from '../dist/tools.js'
import { pngSize } from '../dist/observation.js'
await mkdir('.build/evidence',{recursive:true})
const runtime=new AndroidRuntime(),ctx=new Context();ctx.provide('systemPrompt',{tools(){}});const registry=new ToolRuntime(ctx)
ctx.provide('llm',{async resolveModelInfo(){return{inputModalities:['text','image']}}})
let image=0,call=0
ctx.provide('attachments',{async saveImage({data}){const attachmentId=`zhihu-list-${++image}`;await writeFile(`.build/evidence/${attachmentId}.png`,data);return{attachmentId,mediaType:'image/png',bytes:data.length,...pngSize(data)}}})
registerAndroidTools(ctx,runtime)
const agent={id:'zhihu-list-smoke',session:{requestContext:()=>({provider:'integration',model:'vision-fixture'})},options:{}},results=[]
async function run(name,args={}){const result=await registry.execute({callId:`zhihu-${++call}`,name,arguments:args,agent,signal:AbortSignal.timeout(145000)});results.push({name,args,result});assert.equal(result.isError,false,JSON.stringify(result));console.log(name,result.value.status??'ok',result.value.items?.length??'');return result.value}
try {
  await run('android_open_app',{app_name:'知乎'})
  let current=await run('android_observe')
  for(let back=0;back<2&&!current.elements.some(e=>e.text==='热榜');back++){await run('android_key',{key:'back'});current=await run('android_observe')}
  assert(current.elements.some(e=>e.text==='热榜'),'Zhihu must expose its hot-list navigation')
  await run('android_tap_target',{text:'热榜',exact:true,package_name:'com.zhihu.android',max_attempts:1})
  const ready=await run('android_wait',{resource_id:'com.zhihu.android:id/metrics_text',package_name:'com.zhihu.android',max_attempts:3});assert.equal(ready.status,'met')
  const top=await run('android_scroll_find',{text:'知乎日报',exact:true,resource_id:'com.zhihu.android:id/text',package_name:'com.zhihu.android',scroll_resource_id:'',scroll_class_name:'androidx.recyclerview.widget.RecyclerView',direction:'up',max_scrolls:7});assert.equal(top.status,'found')
  const list=await run('android_read_list',{resource_id:'com.zhihu.android:id/title',package_name:'com.zhihu.android',scroll_resource_id:'',scroll_class_name:'androidx.recyclerview.widget.RecyclerView',max_items:20,max_scrolls:7})
  assert.equal(list.status,'limit_reached');assert.equal(list.items.length,20);assert.equal(new Set(list.items.map(i=>i.title)).size,20);assert(list.items.some(i=>i.texts.some(t=>/热度/.test(t))));assert(list.pages.length>1)
  const observedRanks=list.items.flatMap(i=>i.texts.filter(t=>/^\d+$/.test(t)).map(Number));assert.deepEqual(observedRanks,Array.from({length:17},(_,i)=>i+4),'Ranks 4–20 must be explicitly visible without a gap; top-three icons are left to screenshot evidence')
  const listResult=results.at(-1).result;assert.equal(listResult.content.filter(c=>c.type==='image').length,list.pages.length)
  const selected=list.items.find(i=>i.pages.includes(list.page_count));assert(selected)
  const opened=await run('android_tap_target',{text:selected.title,exact:true,package_name:'com.zhihu.android'});assert.equal(opened.action_sent,true);assert.equal(opened.verification.status,'changed')
  const detail=await run('android_observe');assert(detail.elements.some(e=>e.text.includes(selected.title)||e.description.includes(selected.title)),'Question title must be readable on detail page')
  await run('android_key',{key:'home'});await run('android_release')
  await writeFile('.build/evidence/zhihu-list-smoke.json',JSON.stringify({pass:true,kind:'real phone + native ToolRuntime; visible raw titles/heat only; no model summary or desktop chat',count:list.items.length,pages:list.pages.length,scrolls:list.scrolls,selectedTitle:selected.title,detailObserved:true,results},null,2))
  console.log('PASS Zhihu hot list: 20 unique titles with raw row fields → ordered screenshot attachments → detail title observed → Home')
}catch(error){await writeFile('.build/evidence/zhihu-list-failure.json',JSON.stringify({pass:false,error:String(error),results},null,2));throw error}
finally{await runtime.close();await ctx.fiber.dispose()}
