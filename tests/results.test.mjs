import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createServer} from 'node:http'
import {promisify} from 'node:util'
import {execFile} from 'node:child_process'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {ResultStore} from '../dist/results.js'
import {validateResult,resultCsv,resultMarkdown} from '../dist/result-format.js'
import {zipFiles} from '../dist/result-archive.js'
import {TaskLedger} from '../dist/tasks.js'
import {createPanel} from '../dist/host.js'
import {registerAndroidTools} from '../dist/tools.js'
const ref={attachmentId:'real-image',mediaType:'image/png',bytes:24,width:1080,height:2400}
const source={observation_id:'observation_one',captured_at:'2026-10-24T12:00:00Z',serial:'phone',screenshot:ref}
const input=(extra={})=>({title:'热榜',status:'complete',columns:['标题','热度'],rows:[{cells:['标题 A','100 万'],observation_ids:[source.observation_id]}],...extra})
const signal=()=>new AbortController().signal
async function directory(){await mkdir('.build/tests',{recursive:true});return mkdtemp(join(process.cwd(),'.build/tests/results-'))}
const resolve=id=>id===source.observation_id?source:null

test('missing cells and insufficient rows downgrade a complete result and retain reasons',()=>{
 const value=validateResult(input({expected_count:20,rows:[{cells:['实际标题',null],observation_ids:[source.observation_id]}]}))
 assert.equal(value.status,'partial');assert.match(value.reason,/未读到/);assert.match(value.reason,/少于预期 20/);assert.equal(value.rows[0].cells[1],null)
})
test('result validation rejects mismatched tables, fake path sources, unexplained partial results and UTF-8 oversize',()=>{
 assert.throws(()=>validateResult(input({rows:[{cells:['A'],observation_ids:[source.observation_id]}]})),/数量/)
 assert.throws(()=>validateResult(input({rows:[{cells:['A','B'],observation_ids:['../../secret']}]})),/依据/)
 assert.throws(()=>validateResult(input({status:'partial'})),/原因/)
 assert.throws(()=>validateResult(input({summary:'字'.repeat(8001)})),/摘要/)
 assert.throws(()=>validateResult(input({rows:Array.from({length:100},()=>({cells:['中'.repeat(1900),'文'.repeat(1900)],observation_ids:[source.observation_id]}))})),/256/)
})
test('summary and failed results preserve evidence and failure explanations without fabricating table rows',()=>{
 const summary=validateResult({title:'摘要',status:'complete',summary:'实际读到的摘要',observation_ids:[source.observation_id]});assert.equal(summary.rows.length,0)
 assert.throws(()=>validateResult({title:'摘要',status:'complete',summary:'没有依据'}),/依据/)
 const failed=validateResult({title:'未读到',status:'failed',reason:'页面无法读取'});assert.equal(failed.rows.length,0);assert.equal(failed.status,'failed')
})
test('saved results survive restart with independent screenshot references and idempotent call identity',async()=>{
 const root=await directory(),store=new ResultStore(root);await store.load()
 const [a,b]=await Promise.all([store.save('session','call','task',input(),resolve,signal()),store.save('session','call','task',input(),resolve,signal())]);assert.equal(a.id,b.id);assert.equal(store.summaries().length,1)
 const restored=new ResultStore(root);await restored.load();assert.deepEqual(restored.get(a.id),a);assert.deepEqual(a.sources[0].screenshot,ref)
 await assert.rejects(store.save('session','call','task',input({title:'different'}),resolve,signal()),/重复保存/)
})
test('foreign sources and cancellation do not create a saved result',async()=>{
 const store=new ResultStore();await assert.rejects(store.save('other','a','task',input(),()=>null,signal()),/不属于当前对话/)
 const abort=new AbortController();abort.abort();await assert.rejects(store.save('session','b','task',input(),resolve,abort.signal),/abort/i);assert.equal(store.summaries().length,0)
})
test('corrupt files leave valid results visible and provide a warning',async()=>{
 const root=await directory(),store=new ResultStore(root);await store.load();const saved=await store.save('s','c','t',input(),resolve,signal())
 await writeFile(join(root,'results','11111111-1111-1111-1111-111111111111.json'),'{broken')
 const restored=new ResultStore(root);await restored.load();assert(restored.warning);assert.equal(restored.get(saved.id).title,'热榜')
})
test('CSV quotes multiline Unicode fields and neutralizes spreadsheet formulas including prefixed whitespace',async()=>{
 const result=await new ResultStore().save('s','c','t',input({rows:[{cells:['=HYPERLINK("https://example.invalid")','行一,行二\n"中文"'],observation_ids:[source.observation_id]}],reason:'保留说明'}),resolve,signal())
 const csv=resultCsv(result);assert(csv.includes('"\'=HYPERLINK(""'));assert(csv.includes('行一,行二\n""中文""'));assert(csv.includes('截图 1'));assert(csv.includes('保留说明'))
 result.task_state={status:'limited',reason:'达到调用上限'};assert(resultMarkdown(result).includes('达到调用上限'));assert(resultCsv(result).includes('达到限额'));
 result.rows[0].cells[0]=' \t@SUM(A1)';assert(resultCsv(result).includes('"\' \t@SUM(A1)'))
})
test('Markdown escapes device HTML, preserves missing values and uses only packaged screenshot paths',async()=>{
 const saved=await new ResultStore().save('s','c','t',input({rows:[{cells:['<script>alert(1)</script> | [link](bad)',null],observation_ids:[source.observation_id]}]}),resolve,signal())
 const md=resultMarkdown(saved);assert(!md.includes('<script>'));assert(md.includes('&lt;script&gt;'));assert(md.includes('未读到'));assert(md.includes('evidence/1.png'));assert(md.includes('部分完成'))
})
test('ZIP exports open in Python with correct CRC and exact report/image bytes',async()=>{
 const root=await directory(),file=join(root,'bundle.zip'),png=Buffer.from([137,80,78,71,1,2,3])
 await writeFile(file,zipFiles([{name:'report.md',data:Buffer.from('中文\n')},{name:'evidence/1.png',data:png}]))
 const result=await promisify(execFile)('python',['-c','import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2]); assert z.read("report.md").decode()=="中文\\n"; assert z.read("evidence/1.png")==bytes([137,80,78,71,1,2,3]); print("OK")',file,join(root,'extracted')],{windowsHide:true})
 assert.match(result.stdout,/OK/);assert.throws(()=>zipFiles([{name:'../secret',data:png}]),/Invalid/)
})
test('observation evidence can be resolved only within its conversation and remains after session completion',async t=>{
 const ledger=new TaskLedger();t.after(()=>ledger.close());ledger.begin('a','one','android_observe',{})
 ledger.finish('a','one','android_observe',{isError:false,value:{observation_id:source.observation_id,captured_at:source.captured_at,serial:'phone',screenshot:ref}})
 assert.equal(ledger.source('b',source.observation_id),null);assert.deepEqual(ledger.source('a',source.observation_id),source);ledger.complete('a');assert.deepEqual(ledger.source('a',source.observation_id),source)
})
test('actual native tool saves an observed result, rejects invented evidence and marks unread fields partial',async t=>{
 const ctx=new Context();ctx.provide('systemPrompt',{tools(){}});const registry=new ToolRuntime(ctx),tasks=new TaskLedger(),results=new ResultStore()
 t.after(async()=>{await tasks.close();await ctx.fiber.dispose()})
 ctx.provide('llm',{async resolveModelInfo(){return{inputModalities:['text']}}});ctx.provide('attachments',{async saveImage(){return ref}})
 const runtime={tasks,results,state:{revision:1},async observe(){return{observation:{...source,revision:1,width:1080,height:2400,rotation:0,elements:[]},png:Buffer.alloc(24)}}}
 registerAndroidTools(ctx,runtime);let call=0
 const run=(name,args={})=>registry.execute({name,arguments:args,callId:`native-result-${++call}`,agent:{id:'a',session:{requestContext:()=>({provider:'p',model:'m'})},options:{}},signal:signal()})
 assert.equal((await run('android_observe')).isError,false)
 const saved=await run('android_save_result',input({rows:[{cells:['A',null],observation_ids:[source.observation_id]}]}));assert.equal(saved.isError,false);assert.equal(saved.value.result_status,'partial');assert.equal(results.get(saved.value.result_id).sources.length,1)
 const bad=await run('android_save_result',input({rows:[{cells:['A','B'],observation_ids:['invented']}]}));assert.equal(bad.isError,true);assert.equal(results.summaries().length,1)
})
test('result HTTP exports require authorization, survive task removal and report missing screenshot originals',async t=>{
 const png=Buffer.from([137,80,78,71,1,2,3]);let missing=false
 const panel=await createPanel({},()=>[],{async readImage(){if(missing)throw new Error('missing');return{data:png}}}),server=createServer(panel.handler)
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await panel.close();await new Promise(resolve=>server.close(resolve))})
 const saved=await panel.results.save('s','c','deleted-task',input(),resolve,signal()),url=`http://127.0.0.1:${server.address().port}/x-android/results/${saved.id}`,headers={'x-android-client':'1'}
 assert.equal((await fetch(url)).status,403);assert.equal((await fetch(url,{headers:{...headers,origin:'https://other.invalid'}})).status,403)
 const response=await fetch(url+'/export?format=csv',{headers}),bytes=new Uint8Array(await response.arrayBuffer());assert.deepEqual([...bytes.slice(0,3)],[239,187,191]);assert(response.headers.get('content-disposition').includes('.csv'))
 assert.equal((await fetch(url+'/source/1',{headers})).status,200);assert.equal((await fetch(url+'/source/999',{headers})).status,404);assert.equal((await fetch(url+'/export?format=other',{headers})).status,400)
 assert.equal((await(await fetch(url,{headers})).json()).task_state,null)
 missing=true;assert.equal((await fetch(url+'/source/1',{headers})).status,410);assert.equal((await fetch(url+'/export?format=bundle',{headers})).status,409);assert.equal((await fetch(url+'/export?format=markdown',{headers})).status,200)
})
