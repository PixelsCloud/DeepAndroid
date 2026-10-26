import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { registerAndroidTools } from '../dist/tools.js'
test('all three event tools dispatch through actual Harness with structured outcomes and bounded parameters',async t=>{
 const ctx=new Context();ctx.provide('systemPrompt',{tools(){}});const registry=new ToolRuntime(ctx),calls=[];registerAndroidTools(ctx,{async notifications(_s,args){calls.push(args);return{status:'listed',items:[]}},async waitNotification(_s,args){calls.push(args);return{status:'timed_out',completion_confirmed:false}},async waitApp(_s,args){calls.push(args);return{status:'matched',content_ready_confirmed:false}}});t.after(()=>ctx.fiber.dispose());const agent={id:'events-registry'},call=(name,args,id)=>registry.execute({name,arguments:args,callId:id,agent,signal:AbortSignal.timeout(10000)})
 assert.equal((await call('android_notifications',{package_name:'com.example.app'},'query')).value.status,'listed');assert.equal((await call('android_wait_notification',{package_name:'com.example.app'},'notify')).value.status,'timed_out');assert.equal((await call('android_wait_app',{package_name:'com.example.app'},'app')).value.content_ready_confirmed,false);assert.equal(calls.length,3);assert.equal((await call('android_wait_app',{},'missing-package')).isError,true)
})
test('media/picker tools dispatch through Harness and keep XML internal while respecting text/vision modalities',async t=>{
 const ctx=new Context();ctx.provide('systemPrompt',{tools(){}});const registry=new ToolRuntime(ctx);let vision=false,media=0,picks=0
 ctx.provide('attachments',{async saveImage(){return{attachmentId:'picker-fixture',mediaType:'image/png',bytes:24,width:100,height:200}}});ctx.provide('llm',{async resolveModelInfo(){return{inputModalities:vision?['text','image']:['text']}}})
 const runtime={state:{revision:1},async mediaQuery(_session,args){media++;return{status:'listed',items:[],kind:args.kind??'all'}},async pickFile(){picks++;return{status:'not_picker',attachment_confirmed:false,capture:{xml:'INTERNAL XML',png:Buffer.alloc(0),observation:{observation_id:'picker',revision:1,width:100,height:200,elements:[]}}}}};registerAndroidTools(ctx,runtime);t.after(()=>ctx.fiber.dispose())
 const agent={id:'picker-registry',options:{},session:{requestContext:()=>({provider:'fixture',model:'text'})}},call=(name,args={},id='native')=>registry.execute({name,arguments:args,callId:id,agent,signal:AbortSignal.timeout(10000)})
 assert.equal((await call('android_media_query',{kind:'image'})).value.kind,'image');assert.equal(media,1);const text=await call('android_pick_file',{},'picker-text');assert.equal(text.isError,false);assert(!text.content.some(item=>item.type==='image'));assert(!JSON.stringify(text).includes('INTERNAL XML'));vision=true;const image=await call('android_pick_file',{},'picker-image');assert(image.content.some(item=>item.type==='image'));assert.equal(picks,2);assert.equal((await call('android_media_query',{kind:'private'},'bad')).isError,true)
})
test('actual Harness native tool registry validates arguments, renders image references, and respects model modalities', async t => {
  const ctx = new Context(); ctx.provide('systemPrompt',{ tools() {} })
  const registry = new ToolRuntime(ctx); let vision = false, observed = 0
  const screenshot = { attachmentId:'android-test-image', mediaType:'image/png',bytes:20,width:100,height:200 }
  ctx.provide('attachments',{ async saveImage(){return screenshot} })
  ctx.provide('llm',{ async resolveModelInfo(){return {inputModalities:vision?['text','image']:['text']}} })
  const runtime = { state:{ revision:1 },async list(){return {devices:[]}},async observe(){observed++; return {observation:{observation_id:'obs',revision:1,elements:[]},png:Buffer.alloc(0)}} }
  registerAndroidTools(ctx,runtime); t.after(()=>ctx.fiber.dispose())
  assert.equal(registry.schemas().filter(t=>t.name.startsWith('android_')).length,44)
  const agent = {id:'session-test',session:{ requestContext:()=>({provider:'test',model:'test'}) },options:{}}
  let n=0; const execute = (name,args,caller=agent)=>registry.execute({callId:`call-${++n}`,name,arguments:args,agent:caller,signal:new AbortController().signal})
  const text = await execute('android_observe',{}); assert.equal(text.isError,false); assert(text.content.every(c=>c.type!=='image'))
  assert.equal(text.value.image_supported,false)
  const invalid = await execute('android_observe',{include_image:true}); assert.equal(invalid.isError,true); assert.equal(observed,1)
  vision=true; const image = await execute('android_observe',{}); assert.equal(image.isError,false); assert.deepEqual(image.content.find(c=>c.type==='image').attachment,screenshot)
  assert.equal((await execute('android_key',{key:'shell'})).isError,true)
  assert.equal((await execute('android_devices',{},null)).isError,true)
})

test('native app tools enforce one launch selector and render non-launch outcomes honestly', async t => {
  const ctx=new Context();ctx.provide('systemPrompt',{tools(){}});const registry=new ToolRuntime(ctx)
  const launched=[]
  const runtime={async openApp(_s,pkg){launched.push(pkg);return {status:'sent'}},async openAppByName(){return {status:'ambiguous',candidates:[{name:'设置',package_name:'com.a.settings'},{name:'设置',package_name:'com.b.settings'}]}}}
  registerAndroidTools(ctx,runtime);t.after(()=>ctx.fiber.dispose())
  let call=0;const execute=args=>registry.execute({callId:`app-${++call}`,name:'android_open_app',arguments:args,agent:{id:'a'},signal:new AbortController().signal})
  assert.equal((await execute({})).isError,true)
  assert.equal((await execute({app_name:'设置',package_name:'com.android.settings'})).isError,true)
  const ambiguous=await execute({app_name:'设置'});assert.equal(ambiguous.isError,false);assert.equal(ambiguous.meta.status,'ambiguous');assert.equal(launched.length,0)
  const view=registry.get('android_open_app').presentResult({},ambiguous);assert(view.content[0].text.includes('未启动'))
  assert.equal((await execute({package_name:'com.android.settings'})).isError,false);assert.deepEqual(launched,['com.android.settings'])
})

test('Harness lifecycle events release control on idle and forget disposed conversation bindings', async t => {
  const ctx = new Context(); ctx.provide('systemPrompt',{ tools() {} }); new ToolRuntime(ctx)
  const calls=[]; registerAndroidTools(ctx,{async endSession(id,disposed){calls.push({id,disposed})}})
  t.after(()=>ctx.fiber.dispose())
  const agent={id:'session-a'}
  ctx.emit('agent/status',{agent,status:'running'});assert.equal(calls.length,0)
  ctx.emit('agent/status',{agent,status:'idle'});ctx.emit('agent/disposed',{agent})
  assert.deepEqual(calls,[{id:'session-a',disposed:false},{id:'session-a',disposed:true}])
})

test('native list tool attaches ordered page evidence once per page only for an image-capable model', async t => {
  const ctx=new Context();ctx.provide('systemPrompt',{tools(){}});const registry=new ToolRuntime(ctx)
  let vision=true,images=0
  ctx.provide('llm',{async resolveModelInfo(){return{inputModalities:vision?['text','image']:['text']}}})
  ctx.provide('attachments',{async saveImage(){return{attachmentId:`image-${++images}`,mediaType:'image/png',bytes:24,width:1080,height:2400}}})
  const capture=id=>({observation:{observation_id:id,revision:1,width:1080,height:2400,rotation:0,elements:[]},png:Buffer.alloc(24)})
  const runtime={state:{revision:1},async readList(){const first=capture('one'),last=capture('two');return{...last,pages:[first,last],items:[{title:'A',pages:[1,2]}],status:'scroll_limit'}}}
  registerAndroidTools(ctx,runtime);t.after(()=>ctx.fiber.dispose())
  const agent={id:'a',session:{requestContext:()=>({provider:'test',model:'test'})},options:{}}
  const execute=id=>registry.execute({callId:id,name:'android_read_list',arguments:{resource_id:'title'},agent,signal:new AbortController().signal})
  const result=await execute('vision');assert.equal(result.isError,false);assert.equal(images,2);assert.deepEqual(result.content.filter(c=>c.type==='image').map(c=>c.attachment.attachmentId),['image-1','image-2']);assert.equal(result.value.screenshot.attachmentId,'image-2')
  vision=false;const text=await execute('text');assert.equal(text.isError,false);assert.equal(text.content.filter(c=>c.type==='image').length,0);assert.equal(text.value.pages.length,2)
})
