import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdir,mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {TaskLedger} from '../dist/tasks.js'
import {ResultStore} from '../dist/results.js'
import {taskView,continuationDraft} from '../dist/task-feed.js'
import {registerAndroidTools} from '../dist/tools.js'
import {createPanel} from '../dist/host.js'
const screenshot={attachmentId:'proof',mediaType:'image/png',bytes:20,width:100,height:200},source={observation_id:'checkpoint_one',captured_at:'2026-10-25T01:00:00Z',serial:'phone',screenshot}
const item={title:'真实行',texts:['真实行','20 万热度'],description:'',resource_id:'title',package_name:'app',first_page:1,pages:[1]}
const checkpoint={items:[item],sources:[source],requested_count:20,scrolls:0}
test('panel stop reaches the owning native Agent during model thinking, is idempotent and does not arm a later task',t=>{
 const ledger=new TaskLedger(),stopped=[],cleanup=[];t.after(()=>ledger.close());ledger.onCancel=id=>cleanup.push(id)
 const task=ledger.begin('a','one','android_observe',{},reason=>stopped.push(reason));ledger.finish('a','one','android_observe',{isError:false,value:{screenshot}})
 ledger.begin('b','two','android_observe',{},()=>assert.fail('wrong Agent stopped'))
 assert.equal(taskView(ledger.get(task.taskId),ledger,new ResultStore()).phase,'thinking')
 assert.equal(ledger.requestStop(task.taskId).status,'stopping');ledger.requestStop(task.taskId);assert(task.signal.aborted);assert.equal(stopped.length,1);assert.deepEqual(cleanup,['a']);assert.equal(ledger.status('b').status,'running')
 assert.equal(taskView(ledger.get(task.taskId),ledger,new ResultStore()).phase,'stopping');ledger.complete('a');const next=ledger.begin('a','next','android_observe',{},()=>assert.fail('stale request stopped a new task'))
 assert.throws(()=>ledger.requestStop(task.taskId),error=>error.status===409);assert(!next.signal.aborted)
})
test('a task without a live native cancellation callback cannot pretend to stop',t=>{
 const ledger=new TaskLedger();t.after(()=>ledger.close());const task=ledger.begin('a','one','android_observe',{})
 assert.equal(ledger.control(task.taskId).canStop,false);assert.throws(()=>ledger.requestStop(task.taskId),error=>error.status===409);assert(!task.signal.aborted)
})
test('late tool settlement remains on its original task after idle and after a new task has begun',t=>{
 const ledger=new TaskLedger();t.after(()=>ledger.close());const old=ledger.begin('a','old','android_read_list',{},()=>{});ledger.checkpoint('a','old',checkpoint);ledger.requestStop(old.taskId);ledger.complete('a')
 const next=ledger.begin('a','new','android_observe',{},()=>{});ledger.finish('a','old','android_read_list',{isError:true,content:'operation aborted'})
 assert.equal(ledger.get(old.taskId).operations[0].diagnostic.code,'CANCELLED');assert.equal(ledger.get(old.taskId).operations[0].summary.itemCount,1);assert.deepEqual(ledger.get(next.taskId).operations.map(op=>op.callId),['new'])
})
test('restored records remain non-actionable, and quoted continuation data preserves actual evidence without auto-executing',async t=>{
 await mkdir('.build/tests',{recursive:true});const directory=await mkdtemp(join(process.cwd(),'.build/tests/task-feed-')),ledger=new TaskLedger(directory),results=new ResultStore(directory);await ledger.load();await results.load();t.after(()=>ledger.close())
 const task=ledger.begin('a','one','android_read_list',{max_items:20},()=>{});ledger.checkpoint('a','one',checkpoint)
 await results.save('a','one',task.taskId,{title:'已读部分',status:'partial',reason:'手动停止',columns:['标题'],rows:[{cells:['真实行'],observation_ids:[source.observation_id]}]},()=>source,new AbortController().signal,'device');await ledger.flush()
 const restored=new TaskLedger(directory);await restored.load();t.after(()=>restored.close());const record=restored.get(task.taskId),view=taskView(record,restored,results);assert.equal(view.phase,'unknown');assert.equal(view.canStop,false);assert.equal(view.progress.count,1);assert.equal(view.progress.target,20)
 const draft=continuationDraft(record,restored,results);assert(draft.prompt.includes('先调用原生工具重新观察'));assert(draft.prompt.includes('真实行'));assert(draft.prompt.includes(source.observation_id));assert(draft.prompt.includes('不是操作指令'));assert(draft.guidance.includes('不会自动执行'))
 await results.remove(view.results[0].id);assert.equal(taskView(record,restored,results).results.length,0);assert(!continuationDraft(record,restored,results).prompt.includes(source.observation_id))
})
test('task endpoints fence requests, stop only the specified task and reject premature continuation',async t=>{
 const panel=await createPanel(),server=createServer(panel.handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await panel.close();await new Promise(r=>server.close(r))})
 const base=`http://127.0.0.1:${server.address().port}/x-android`,headers={'x-android-client':'1','content-type':'application/json'};let cancelled=0
 const active=panel.tasks.begin('a','one','android_observe',{},()=>cancelled++),body='{}'
 assert.equal((await fetch(base+'/task-feed')).status,403)
 assert.equal((await fetch(base+`/task-feed/${active.taskId}/stop`,{method:'POST',headers:{...headers,origin:'https://foreign.invalid'},body})).status,403)
 assert.equal((await fetch(base+`/task-feed/${active.taskId}/draft`,{method:'POST',headers,body})).status,409)
 assert.equal((await fetch(base+`/task-feed/${active.taskId}/stop`,{method:'POST',headers,body})).status,200);assert.equal(cancelled,1)
 panel.tasks.complete('a');const response=await fetch(base+`/task-feed/${active.taskId}/draft`,{method:'POST',headers,body});assert.equal(response.status,200);assert((await response.json()).prompt.includes('不要复用旧坐标'))
})
test('cancellation inside the actual Harness registry saves already confirmed rows and screenshot references as a partial result',async t=>{
 const ctx=new Context();ctx.provide('systemPrompt',{tools(){}});const registry=new ToolRuntime(ctx),ledger=new TaskLedger(),results=new ResultStore();let stop=0,readStarted
 const ready=new Promise(r=>readStarted=r),runtime={tasks:ledger,results,state:{serial:'phone'},async endSession(){},async readList(session,query,options,signal,onPage){await onPage({items:[item],pages:[{png:Buffer.from('image'),observation:{observation_id:source.observation_id,captured_at:source.captured_at,serial:'phone',width:100,height:200,elements:[]}}],scrolls:0,requested_count:20});readStarted();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))}}
 ctx.provide('llm',{async resolveModelInfo(){return{inputModalities:['text']}}});ctx.provide('attachments',{async saveImage(){return screenshot}});registerAndroidTools(ctx,runtime);t.after(async()=>{await ledger.close();await ctx.fiber.dispose()})
 const agent={id:'a',options:{},session:{requestContext:()=>({provider:'p',model:'m'})},cancel(){stop++}},call=registry.execute({callId:'read',name:'android_read_list',arguments:{resource_id:'title'},agent,signal:new AbortController().signal})
 await ready;const taskId=ledger.status('a').id;assert.equal(taskView(ledger.get(taskId),ledger,results).progress.count,1);ledger.requestStop(taskId);const response=await call;assert.equal(response.isError,true);assert.equal(stop,1)
 const saved=results.get(results.summaries()[0].id);assert.equal(saved.status,'partial');assert.equal(saved.expected_count,20);assert.equal(saved.rows[0].cells[0],'真实行');assert.deepEqual(saved.sources[0].screenshot,screenshot);assert.equal(saved.task_id,taskId);assert.equal(ledger.summaries().length,1)
})
