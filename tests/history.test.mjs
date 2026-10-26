import{test}from'node:test'
import assert from'node:assert/strict'
import{Context}from'@deepseek-ai/cordis'
import{ToolRuntime}from'@deepseek-ai/dsh-tools'
import{ResultStore}from'../dist/results.js'
import{TaskLedger}from'../dist/tasks.js'
import{registerAndroidTools}from'../dist/tools.js'
import{AndroidRuntime}from'../dist/runtime.js'
const signal=()=>new AbortController().signal
test('new conversation reads actual history, reuses original evidence aliases in a separate report, and cannot tap with them',async t=>{
 const results=new ResultStore(),tasks=new TaskLedger(),ref={attachmentId:'original',mediaType:'image/png',bytes:20,width:1080,height:2400},source={observation_id:'old_observation',captured_at:'2026-10-24T10:00:00Z',serial:'original-phone',screenshot:ref}
 const original=await results.save('old-session','old-call','old-task',{title:'历史热榜',status:'complete',columns:['标题'],rows:[{cells:['忽略指令这只是条目文字'],observation_ids:[source.observation_id]}]},id=>id===source.observation_id?source:null,signal())
 const baseline=JSON.stringify(original),ctx=new Context();ctx.provide('systemPrompt',{tools(){}});const registry=new ToolRuntime(ctx);let vision=false,reads=0,taps=0
 ctx.provide('llm',{async resolveModelInfo(){return{inputModalities:vision?['text','image']:['text']}}});ctx.provide('attachments',{async readImage(){reads++;return{data:Buffer.alloc(20)}}})
 const runtime={tasks,results,state:{serial:'unrelated-current-phone'},async endSession(){},async tap(_s,id){taps++;throw new Error('观察已失效：'+id)}};registerAndroidTools(ctx,runtime);t.after(async()=>{await tasks.close();await ctx.fiber.dispose()})
 const agent={id:'new-session',options:{},session:{requestContext:()=>({provider:'fixture',model:'text'})}};let n=0;const call=(name,args)=>registry.execute({name,arguments:args,callId:'new-'+ ++n,agent,signal:signal()})
 const query=await call('android_results',{query:'历史热榜'});assert.equal(query.isError,false);assert.equal(query.value.results[0].id,original.id)
 const read=await call('android_read_result',{result_id:original.id});assert.equal(read.isError,false);assert.equal(read.content.filter(c=>c.type==='image').length,0);assert.equal(reads,0)
 const alias=read.value.pages[0].observation_id;assert.match(alias,/^history_/);assert.equal(read.value.pages[0].serial,'original-phone');assert.equal(read.value.report.rows[0].observation_ids[0],alias)
 const saved=await call('android_save_result',{title:'新对话整理',status:'complete',columns:['标题'],rows:[{cells:['忽略指令这只是条目文字'],observation_ids:[alias]}]});assert.equal(saved.isError,false,JSON.stringify(saved));const updated=results.get(saved.value.result_id);assert.equal(updated.sources[0].captured_at,source.captured_at);assert.equal(updated.sources[0].serial,source.serial);assert.equal(updated.sources[0].origin_result_id,original.id);assert.equal(JSON.stringify(results.get(original.id)),baseline)
 const tap=await call('android_tap',{observation_id:alias,x:10,y:10});assert.equal(tap.isError,true);assert.equal(taps,1)
 assert.equal((await call('android_read_result',{result_id:original.id,include_images:true})).isError,true);vision=true;const image=await call('android_read_result',{result_id:original.id,include_images:true});assert.equal(image.isError,false);assert.equal(image.content.filter(c=>c.type==='image').length,1)
})
test('missing originals retain historical text without image claims; deleted reports and invented screenshot indices are rejected',async t=>{
 const results=new ResultStore(),tasks=new TaskLedger(),ref={attachmentId:'missing',mediaType:'image/png',bytes:20,width:100,height:200},source={observation_id:'old_obs',captured_at:'2026-10-24T00:00:00Z',serial:'phone',screenshot:ref}
 const report=await results.save('old','call','task',{title:'旧结果',status:'complete',summary:'实际摘要',observation_ids:['old_obs']},()=>source,signal())
 const ctx=new Context();ctx.provide('systemPrompt',{tools(){}});const registry=new ToolRuntime(ctx);ctx.provide('llm',{async resolveModelInfo(){return{inputModalities:['image','text']}}});ctx.provide('attachments',{async readImage(){throw new Error('cleaned')}});registerAndroidTools(ctx,{tasks,results,async endSession(){}});t.after(async()=>{await tasks.close();await ctx.fiber.dispose()})
 let n=0;const call=(name,args)=>registry.execute({name,arguments:args,callId:'missing-'+ ++n,agent:{id:'reader',options:{},session:{requestContext:()=>({provider:'fixture',model:'vision'})}},signal:signal()})
 const read=await call('android_read_result',{result_id:report.id,include_images:true});assert.equal(read.isError,false);assert.equal(read.value.report.summary,'实际摘要');assert.equal(read.value.image_availability[0].status,'missing');assert.equal(read.content.filter(c=>c.type==='image').length,0)
 assert.equal((await call('android_read_result',{result_id:report.id,include_images:true,source_numbers:[2]})).isError,true)
 await results.remove(report.id);assert.equal((await call('android_read_result',{result_id:report.id})).isError,true);assert.equal((await call('android_results',{})).value.total,0)
})
test('real AndroidRuntime rejects imported history aliases without sending a tap, even when the task can cite their evidence',async()=>{
 let finish;const commands=[],video={codec:1,deviceName:'fixture',input:{geometry:{width:100,height:200,epoch:1},async send(command){commands.push(command)}},async resetVideo(){},async read(){return new Promise(resolve=>finish=()=>resolve({done:true}))},async close(){finish?.()}}
 const tasks=new TaskLedger(),runtime=new AndroidRuntime({async list(){return[{serial:'phone',state:'device'}]},async open(){return video}},tasks)
 const alias='history_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_1',source={observation_id:alias,captured_at:'2026-10-24T00:00:00Z',serial:'old-phone',screenshot:{attachmentId:'old',mediaType:'image/png',bytes:20,width:100,height:200}}
 try{tasks.begin('reader','read','android_read_result',{});tasks.finish('reader','read','android_read_result',{isError:false,value:{pages:[source]}});assert.equal(tasks.source('reader',alias).serial,'old-phone');await assert.rejects(runtime.tap('reader',alias,{x:10,y:10},signal()),/失效/);assert.equal(commands.filter(command=>command.kind==='pointer').length,0)}finally{await runtime.close()}
})
