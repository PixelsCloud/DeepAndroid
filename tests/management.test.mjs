import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { adbCandidates, discoverAdb } from '../dist/adb.js'
import { diagnoseError } from '../dist/diagnostics.js'
import { PreferenceStore } from '../dist/config.js'
import { TaskLedger } from '../dist/tasks.js'
import { TemplateStore } from '../dist/templates.js'
import { createPanel } from '../dist/host.js'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { registerAndroidTools } from '../dist/tools.js'
async function directory() {await mkdir('.build/tests',{recursive:true});return mkdtemp(join(process.cwd(),'.build/tests/management-'))}
const image={attachmentId:'test-screenshot',mediaType:'image/png',bytes:20,width:100,height:200}
test('ADB discovery honors explicit paths and environment precedence without a development directory',async()=>{
  assert.deepEqual(adbCandidates('C:/custom/adb.exe',{ANDROID_HOME:'D:/sdk'},'win32'),['C:/custom/adb.exe'])
  assert.deepEqual(adbCandidates('auto',{DSH_ANDROID_ADB_PATH:'C:/chosen/adb.exe'},'win32'),['C:/chosen/adb.exe'])
  const candidates=adbCandidates('auto',{ANDROID_HOME:'C:/sdk',ANDROID_SDK_ROOT:'C:/sdk'},'win32','x64')
  assert(candidates[0].replaceAll('\\','/').endsWith('/vendor/adb/windows/adb.exe'));assert.equal(candidates[1],'adb');assert.equal(candidates.length,3);assert(candidates[2].includes('platform-tools'))
  assert.equal(adbCandidates('auto',{},'linux','x64')[0],'adb')
  for (const arch of ['x64','arm64']) {
    assert(adbCandidates('auto',{},'darwin',arch)[0].replaceAll('\\','/').endsWith('/vendor/adb/macos/adb'))
    assert.deepEqual(adbCandidates('/custom/adb',{DSH_ANDROID_ADB_PATH:'/ignored/adb'},'darwin',arch),['/custom/adb'])
    assert.deepEqual(adbCandidates('auto',{DSH_ANDROID_ADB_PATH:'/chosen/adb'},'darwin',arch),['/chosen/adb'])
  }
  await assert.rejects(discoverAdb('C:/__dsh_nonexistent__/adb.exe',{}),error=>error.diagnostic.code==='ADB_MISSING')
})
test('diagnostics identify authorization, focus, cancellation, model support and stale observation recovery',()=>{
  for(const [message,code] of [['unauthorized','DEVICE_UNAUTHORIZED'],['offline','DEVICE_OFFLINE'],['当前模型未声明图片输入能力','MODEL_IMAGE_UNSUPPORTED'],['观察已失效','STALE_OBSERVATION'],['没有已聚焦的输入框','FIELD_NOT_FOCUSED'],['operation aborted','CANCELLED']])assert.equal(diagnoseError(new Error(message)).code,code)
})
test('task limit cannot be reset by release; an explicit lifecycle completion starts the next task',async t=>{
  const ledger=new TaskLedger(undefined,{maxCalls:2,timeoutMs:10000});t.after(()=>ledger.close());const reasons=[]
  ledger.begin('a','one','android_observe',{},reason=>reasons.push(reason))
  ledger.begin('a','two','android_key',{key:'home'})
  assert.throws(()=>ledger.begin('a','three','android_observe',{}),/TASK_LIMIT/)
  assert.equal(ledger.status('a').status,'limited');assert.equal(reasons.length,1)
  ledger.begin('a','release','android_release',{})
  assert.throws(()=>ledger.begin('a','four','android_key',{}),/TASK_LIMIT/)
  ledger.complete('a');assert.equal(ledger.begin('a','new','android_observe',{}).signal.aborted,false)
})
test('task deadline aborts owned work and invokes the Harness cancellation seam even between tool calls',async t=>{
  const ledger=new TaskLedger(undefined,{maxCalls:10,timeoutMs:100});t.after(()=>ledger.close());let reason
  const task=ledger.begin('a','one','android_observe',{},value=>reason=value)
  ledger.finish('a','one','android_observe',{isError:false,value:{screenshot:image}})
  await delay(140);assert.equal(task.signal.aborted,true);assert(reason.includes('时限'));assert.equal(ledger.status('a').status,'limited')
})
test('records persist across instances, redact input text, retain failure causes and link before/after screenshots',async t=>{
  const root=await directory(),ledger=new TaskLedger(root);await ledger.load();t.after(()=>ledger.close())
  ledger.begin('a','before','android_observe',{});ledger.finish('a','before','android_observe',{isError:false,value:{screenshot:image}},'phone')
  ledger.begin('a','input','android_input_text',{text:'PRIVATE INPUT',replace:true});ledger.finish('a','input','android_input_text',{isError:false,value:{status:'sent'}})
  ledger.begin('a','after','android_observe',{});ledger.finish('a','after','android_observe',{isError:false,value:{screenshot:image}})
  ledger.begin('a','fail','android_tap',{});ledger.finish('a','fail','android_tap',{isError:true,content:'观察已失效'})
  ledger.begin('a','input-fail','android_input_text',{text:'PRIVATE INPUT'});ledger.finish('a','input-fail','android_input_text',{isError:true,content:'invalid PRIVATE INPUT'})
  ledger.complete('a');await ledger.flush()
  const record=ledger.get(ledger.summaries()[0].id)
  assert.equal(record.operations[1].input.text_length,13);assert.equal(record.operations[1].input.text,undefined)
  assert.equal(record.operations[1].beforeObservation,record.operations[0].id);assert.equal(record.operations[1].afterObservation,record.operations[2].id)
  const raw=await readFile(join(root,'tasks',record.id+'.json'),'utf8');assert(!raw.includes('PRIVATE INPUT'))
  const restored=new TaskLedger(root);await restored.load();t.after(()=>restored.close())
  const saved=restored.get(record.id);assert.equal(saved.operations[3].diagnostic.code,'STALE_OBSERVATION');assert.deepEqual(restored.evidence(saved.operations[0].id),image)
})
test('template drafts substitute literal values once and save reusable custom parameterized tasks',async()=>{
  const root=await directory(),store=new TemplateStore(root)
  await store.load();assert.equal(store.list().length,5)
  assert(store.render('ranking',{app:'知乎',list:'热榜',count:20}).prompt.includes('前 20 条'))
  assert.throws(()=>store.render('ranking',{count:0}),/数量/)
  assert(store.render('search',{app:'{{keyword}}',keyword:'电池'}).prompt.includes('“{{keyword}}”'))
  const saved=await store.save({title:'我的搜索',body:'打开 {{app}}，搜索 {{keyword}}',defaults:{app:'设置',keyword:'电池'}})
  const restored=new TemplateStore(root);await restored.load();assert.equal(restored.render(saved.id,{keyword:'显示'}).prompt,'打开 设置，搜索 显示')
  await assert.rejects(store.save({title:'invalid',body:'{{bad-name}}'}),/参数/)
})
test('settings and management routes persist migration data, enforce client fencing, and serve only recorded evidence',async t=>{
  const root=await directory(),preferences=new PreferenceStore(root);await preferences.load();await preferences.save({adbPath:'auto',maxCalls:12,taskTimeoutMs:60000})
  const panel=await createPanel({dataDir:root},()=>[],{readImage:async ref=>({data:Buffer.from(ref.attachmentId)})})
  const server=createServer(panel.handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await panel.close();await new Promise(resolve=>server.close(resolve))})
  const url=`http://127.0.0.1:${server.address().port}/x-android`,headers={'x-android-client':'1','content-type':'application/json'}
  assert.equal((await fetch(url+'/records')).status,403)
  assert.equal((await fetch(url+'/settings',{headers})).status,200);assert.equal(panel.tasks.limits.maxCalls,12)
  assert.equal((await fetch(url+'/evidence/../../package.json',{headers})).status,404)
  const rendered=await(await fetch(url+'/templates/render',{method:'POST',headers,body:JSON.stringify({id:'search',params:{app:'设置',keyword:'电池'}})})).json();assert(rendered.prompt.includes('电池'))
  panel.tasks.begin('a','image','android_observe',{});panel.tasks.finish('a','image','android_observe',{isError:false,value:{screenshot:image}})
  const record=panel.tasks.get(panel.tasks.summaries()[0].id),evidence=await fetch(url+'/evidence/'+record.operations[0].id,{headers});assert.equal(evidence.headers.get('content-type'),'image/png');assert.equal(await evidence.text(),'test-screenshot')
})
test('actual Harness tool registry blocks the next phone dispatch at the task limit and records the reason',async t=>{
  const ctx=new Context();ctx.provide('systemPrompt',{tools(){}});const tools=new ToolRuntime(ctx),ledger=new TaskLedger(undefined,{maxCalls:1,timeoutMs:10000});t.after(async()=>{await ledger.close();await ctx.fiber.dispose()})
  let called=0,cancelled=0
  const runtime={tasks:ledger,state:{serial:null},async list(){called++;return{devices:[]}},async endSession(){}}
  ctx.provide('llm',{async resolveModelInfo(){return{inputModalities:['text']}}});registerAndroidTools(ctx,runtime)
  const agent={id:'a',options:{},session:{requestContext:()=>({provider:'p',model:'m'})},cancel(cause){assert.equal(cause.kind,'hook');cancelled++}}
  const invoke=callId=>tools.execute({callId,name:'android_devices',arguments:{},agent,signal:new AbortController().signal})
  assert.equal((await invoke('one')).isError,false);assert.equal((await invoke('two')).isError,true)
  assert.equal(called,1);assert.equal(cancelled,1);assert.equal(ledger.summaries()[0].status,'limited')
})

test('stopping while the model is thinking is recorded as cancellation even without a running phone tool',async t=>{
  const ctx=new Context();ctx.provide('systemPrompt',{tools(){}});new ToolRuntime(ctx)
  const ledger=new TaskLedger();t.after(async()=>{await ledger.close();await ctx.fiber.dispose()})
  registerAndroidTools(ctx,{tasks:ledger,async endSession(){}})
  ledger.begin('a','observe','android_observe',{});ledger.finish('a','observe','android_observe',{isError:false,value:{}})
  ctx.emit('session/event',{id:'a'},{type:'turn/end',data:{turn:1,reason:{kind:'aborted',reason:{kind:'user'}}}})
  ctx.emit('agent/status',{agent:{id:'a'},status:'idle'})
  assert.equal(ledger.summaries()[0].status,'cancelled');assert.equal(ledger.summaries()[0].reason,'用户停止了当前任务')
})
