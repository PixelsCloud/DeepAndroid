import {test} from 'node:test'
import assert from 'node:assert/strict'
import {parseHierarchy} from '../dist/observation.js'
import {readPage} from '../dist/page-reading.js'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {registerAndroidTools} from '../dist/tools.js'
import {TaskLedger} from '../dist/tasks.js'
import {ResultStore} from '../dist/results.js'
import {taskView,continuationDraft} from '../dist/task-feed.js'
let id=0
const a='第一段介绍实际阅读范围与原始内容。',b='第二段说明数据来源与证据，保留真实段落。',c='第三段补充相关背景，不推测缺失内容。',end='这里是已观察到的结束标记。'
const escape=value=>value.replace(/&/g,'&amp;').replace(/"/g,'&quot;')
const node=(text,index=0,extra='')=>`<node text="${escape(text)}" class="android.widget.TextView" package="app.test" resource-id="body" bounds="[10,${150+index*400}][900,${400+index*400}]" ${extra}/>`
function page(texts,extra=''){return `<hierarchy><node package="app.test" scrollable="true" resource-id="article" class="android.widget.ScrollView" bounds="[0,100][1000,2000]">${texts.map((text,i)=>node(text,i)).join('')}</node>${extra}</hierarchy>`}
function capture(xml){return{observation:{observation_id:'reading-'+(++id),serial:'phone',captured_at:new Date().toISOString(),revision:1,video_epoch:1,width:1080,height:2400,rotation:0,tree_error:null,...((parsed)=>({elements:parsed.elements,tree_truncated:parsed.truncated}))(parseHierarchy(xml,1080,2400))},png:Buffer.alloc(24)}}
function driver(pages,controller=new AbortController()){let index=0;const events=[];return{events,signal:controller.signal,async capture(){controller.signal.throwIfAborted();events.push('capture');return capture(pages[Math.min(index++,pages.length-1)])},async press(){assert.fail('reader must never press')},async scroll(){controller.signal.throwIfAborted();events.push('scroll')}}}
const query={resource_id:'body',package_name:'app.test'},options={scroll_resource_id:'article',interval_ms:100}

test('adjacent paragraph overlap preserves order, provenance and genuine repeated paragraphs later in the article',async()=>{
 const d=driver([page([a,b]),page([b,c]),page([c,a,end])]),result=await readPage(d,query,{...options,max_scrolls:7,end_text:end,expected_title:a})
 assert.equal(result.status,'end_marker');assert.equal(result.coverage,'from_current_view');assert.deepEqual(result.items.map(item=>item.texts[0]),[a,b,c,a,end]);assert.deepEqual(result.items[1].pages,[1,2]);assert.deepEqual(result.items[0].pages,[1]);assert.deepEqual(result.items[3].pages,[3]);assert.equal(result.characters,[a,b,c,a,end].join('').length);assert.equal(d.events.filter(value=>value==='scroll').length,2)
})
test('an overlapping partial paragraph is appended without duplicating its shared text',async()=>{
 const shared='这是一段跨屏重叠的实际文字，字符长度超过二十四字。',first='先前内容：'+shared,last=shared+'后续内容。'
 const result=await readPage(driver([page([a,first]),page([last,end])]),query,{...options,end_text:end})
 assert.equal(result.status,'end_marker');assert.equal(result.items.map(item=>item.texts.join('')).join(''),a+first+'后续内容。'+end);assert.deepEqual(result.items[1].pages,[1,2])
})
test('missing continuity and stationary repeated text stop before admitting unverified new content',async()=>{
 const lost=await readPage(driver([page([a,b]),page([c,end])]),query,{...options});assert.equal(lost.status,'continuity_lost');assert.deepEqual(lost.items.map(item=>item.texts[0]),[a,b]);assert.equal(lost.pages.length,2)
 const fixed=await readPage(driver([page([a]),page([a,c])]),query,{...options});assert.equal(fixed.status,'continuity_lost');assert.equal(fixed.items.length,1)
})
test('repeated screen stops after one explicit scroll and never implies the whole article was read',async()=>{
 const d=driver([page([a,b])]),result=await readPage(d,query,{...options,max_scrolls:7});assert.equal(result.status,'unchanged');assert.equal(result.scrolls,1);assert.equal(result.items.length,2);assert(result.guidance.includes('cannot prove complete reading'))
})
test('wrong title, ambiguous scroll regions, empty content and invalid bounds never trigger a speculative input',async()=>{
 const wrong=driver([page([a])]);assert.equal((await readPage(wrong,query,{...options,expected_title:'另一个文章标题'})).status,'context_mismatch');assert(!wrong.events.includes('scroll'))
 const duplicate=`<node package="app.test" scrollable="true" resource-id="article" bounds="[0,100][1000,2000]"/>`,ambiguous=driver([page([a],duplicate)]);assert.equal((await readPage(ambiguous,query,options)).status,'ambiguous_container');assert(!ambiguous.events.includes('scroll'))
 const empty=driver([page([])]);assert.equal((await readPage(empty,query,options)).status,'content_unavailable');assert(!empty.events.includes('scroll'))
 for(const invalid of [{max_chars:99},{max_paragraphs:101},{max_scrolls:8},{end_text:''},{direction:'up'}]){const d=driver([page([a])]);await assert.rejects(readPage(d,query,{...options,...invalid}));assert.deepEqual(d.events,[])}
 await assert.rejects(readPage(driver([page([a])]),{package_name:'app.test'},options),/选择条件/)
})
test('character, paragraph and accessibility truncation limits remain explicit and do not mark a short range complete',async()=>{
 const chars=await readPage(driver([page(['字'.repeat(300)])]),query,{...options,max_chars:100});assert.equal(chars.status,'character_limit');assert.equal(chars.characters,100)
 const paragraphs=await readPage(driver([page([a,b,c])]),query,{...options,max_paragraphs:2});assert.equal(paragraphs.status,'paragraph_limit');assert.equal(paragraphs.items.length,2)
 const clipped=await readPage(driver([page(['字'.repeat(1100)])]),query,options);assert.equal(clipped.status,'text_truncated');assert.equal(clipped.items[0].texts[0].length,1000);assert.equal(clipped.scrolls,0)
 const hidden=parseHierarchy(`<hierarchy>${node('隐藏文字',0,'visible-to-user="false"')}${node(a,1)}</hierarchy>`,1080,2400);assert.deepEqual(hidden.elements.map(element=>element.text),[a])
 const hiddenBranch=parseHierarchy(`<hierarchy><node visible-to-user="false">${node('隐藏后代')}</node>${node(a)}</hierarchy>`,1080,2400);assert.deepEqual(hiddenBranch.elements.map(element=>element.text),[a])
})
test('a static selected text region can be captured without inventing a scroll gesture',async()=>{
 const d=driver([`<hierarchy>${node(a)}</hierarchy>`]),result=await readPage(d,query,options);assert.equal(result.status,'scroll_unavailable');assert.equal(result.items[0].texts[0],a);assert(!d.events.includes('scroll'))
})
test('overlaid toolbar siblings are excluded even when their bounds lie inside a full-height reading container',async()=>{
 const result=await readPage(driver([page([a,b],node('工具栏覆盖文字',2))]),query,{...options,max_scrolls:0});assert.deepEqual(result.items.map(item=>item.texts[0]),[a,b])
})
test('cancellation after a confirmed page preserves its checkpoint and sends no later scroll',async()=>{
 const controller=new AbortController(),d=driver([page([a,b])],controller),snapshots=[]
 await assert.rejects(readPage(d,query,options,async snapshot=>{snapshots.push(snapshot);controller.abort(new Error('cancelled after checkpoint'))}),/cancelled after checkpoint/)
 assert.equal(snapshots[0].items.length,2);assert.equal(snapshots[0].characters,a.length+b.length);assert(!d.events.includes('scroll'))
})
test('actual Harness tool reuses page screenshots, saves partial raw text without an invented expected paragraph count, and reports text progress',async t=>{
 const ctx=new Context();ctx.provide('systemPrompt',{tools(){}});const registry=new ToolRuntime(ctx),ledger=new TaskLedger(),results=new ResultStore();let images=0
 ctx.provide('llm',{async resolveModelInfo(){return{inputModalities:['text','image']}}});ctx.provide('attachments',{async saveImage(){return{attachmentId:'page-'+(++images),mediaType:'image/png',bytes:24,width:1080,height:2400}}})
 const runtime={tasks:ledger,results,state:{revision:1},async endSession(){},async readPage(session,q,opts,signal,onPage){return readPage(driver([page([a,b]),page([b,c])]),q,opts,onPage)}}
 registerAndroidTools(ctx,runtime);t.after(async()=>{await ledger.close();await ctx.fiber.dispose()})
 const agent={id:'page-test',options:{},session:{requestContext:()=>({provider:'p',model:'m'})},cancel(){}},result=await registry.execute({callId:'read',name:'android_read_page',arguments:{...query,...options,max_scrolls:1},agent,signal:new AbortController().signal})
 assert.equal(result.isError,false,JSON.stringify(result));assert.equal(images,2);assert.deepEqual(result.content.filter(block=>block.type==='image').map(block=>block.attachment.attachmentId),['page-1','page-2']);const saved=results.get(result.value.saved_result.id);assert.equal(saved.status,'partial');assert.equal(saved.expected_count,undefined);assert.equal(saved.rows.length,3);assert.equal(saved.sources.length,2)
 const view=taskView(ledger.get(ledger.status(agent.id).id),ledger,results);assert.equal(view.progress.kind,'page');assert.equal(view.progress.count,3);assert.equal(view.progress.characters,a.length+b.length+c.length)
})
test('stopping a native page read retains confirmed paragraph evidence as a partial report and does not treat the paragraph limit as a target',async t=>{
 const ctx=new Context();ctx.provide('systemPrompt',{tools(){}});const registry=new ToolRuntime(ctx),ledger=new TaskLedger(),results=new ResultStore();let ready
 const started=new Promise(resolve=>ready=resolve)
 ctx.provide('llm',{async resolveModelInfo(){return{inputModalities:['text']}}});ctx.provide('attachments',{async saveImage(){return{attachmentId:'cancel-page',mediaType:'image/png',bytes:24,width:1080,height:2400}}})
 const runtime={tasks:ledger,results,state:{revision:1},async endSession(){},async readPage(session,q,opts,signal,onPage){return readPage(driver([page([a,b])],{signal}),q,opts,async snapshot=>{await onPage(snapshot);ready();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))})}}
 registerAndroidTools(ctx,runtime);t.after(async()=>{await ledger.close();await ctx.fiber.dispose()})
 const agent={id:'cancel-page',options:{},session:{requestContext:()=>({provider:'p',model:'m'})},cancel(){}},call=registry.execute({callId:'cancel-reading',name:'android_read_page',arguments:{...query,...options},agent,signal:new AbortController().signal})
 await started;ledger.requestStop(ledger.status(agent.id).id);assert.equal((await call).isError,true)
 const saved=results.get(results.summaries()[0].id);assert.equal(saved.title,'正文读取（中断保留）');assert.equal(saved.expected_count,undefined);assert.equal(saved.status,'partial');assert.equal(saved.rows.length,2);assert.equal(saved.sources.length,1)
})
test('screenshot mode collects a bounded range without fabricating paragraphs or continuity',async()=>{
 const d=driver([page([a,b]),page([b,c]),page([c,end])]),capture=d.capture.bind(d);d.capture=async()=>{const value=await capture();value.png=Buffer.from(JSON.stringify(value.observation.elements));return value}
 const result=await readPage(d,{package_name:'app.test'},{...options,mode:'screenshots',max_scrolls:2})
 assert.equal(result.status,'screen_limit');assert.equal(result.pages.length,3);assert.deepEqual(result.items,[]);assert.equal(result.continuity_verified,false);assert.equal(result.coverage,'screenshots_from_current_view');assert.equal(result.regions.length,3);assert.equal(result.characters,0)
})
test('screenshot repeats, wrong titles and ambiguous containers stop without claiming article completion',async()=>{
 const d=driver([page([a,b])]),same=await readPage(d,query,{...options,mode:'screenshots',max_scrolls:7});assert.equal(same.status,'unchanged_image');assert.equal(same.scrolls,1)
 const wrong=driver([page([a])]);assert.equal((await readPage(wrong,query,{...options,mode:'screenshots',expected_title:'不存在'})).status,'context_mismatch');assert(!wrong.events.includes('scroll'))
 const ambiguous=driver([page([a],'<node package="app.test" scrollable="true" resource-id="article" bounds="[0,100][1000,2000]"/>')]);assert.equal((await readPage(ambiguous,query,{...options,mode:'screenshots'})).status,'ambiguous_container');assert(!ambiguous.events.includes('scroll'))
})
test('native screenshot reading requires image input and delivers real image references with a partial evidence-only report',async t=>{
 const ctx=new Context();ctx.provide('systemPrompt',{tools(){}});const registry=new ToolRuntime(ctx),ledger=new TaskLedger(),results=new ResultStore();let vision=false,opens=0,images=0
 ctx.provide('llm',{async resolveModelInfo(){return{inputModalities:vision?['text','image']:['text']}}});ctx.provide('attachments',{async saveImage(){return{attachmentId:'visual-'+(++images),mediaType:'image/png',bytes:24,width:1080,height:2400}}})
 const runtime={tasks:ledger,results,state:{revision:1},async endSession(){},async readPage(session,q,opts,signal,onPage){opens++;return readPage(driver([page([a])]),q,opts,onPage)}}
 registerAndroidTools(ctx,runtime);t.after(async()=>{await ledger.close();await ctx.fiber.dispose()})
 const agent={id:'visual',options:{},session:{requestContext:()=>({provider:'p',model:'m'})},cancel(){}},run=(callId,extra={})=>registry.execute({callId,name:'android_read_page',arguments:{...query,...options,mode:'screenshots',max_scrolls:0,...extra},agent,signal:new AbortController().signal})
 assert.equal((await run('no-images')).isError,true);assert.equal(opens,0);assert(continuationDraft(ledger.get(ledger.status(agent.id).id),ledger,results).prompt.includes('尚无可确认的正文进度'));vision=true;assert.equal((await run('hidden-images',{include_image:false})).isError,true);assert.equal(opens,0)
 const result=await run('images');assert.equal(result.isError,false,JSON.stringify(result));assert.equal(result.content.filter(block=>block.type==='image').length,1);assert.equal(images,1)
 const saved=results.get(result.value.saved_result.id);assert.equal(saved.status,'partial');assert.equal(saved.rows.length,0);assert.equal(saved.observation_ids.length,1);assert(saved.summary.includes('未执行 OCR'));const view=taskView(ledger.get(ledger.status(agent.id).id),ledger,results);assert.equal(view.progress.readingMode,'screenshots')
})
test('cancelling native screenshot collection preserves its original images without fabricated text',async t=>{
 const ctx=new Context();ctx.provide('systemPrompt',{tools(){}});const registry=new ToolRuntime(ctx),ledger=new TaskLedger(),results=new ResultStore();let ready;const started=new Promise(resolve=>ready=resolve)
 ctx.provide('llm',{async resolveModelInfo(){return{inputModalities:['text','image']}}});ctx.provide('attachments',{async saveImage(){return{attachmentId:'visual-cancel',mediaType:'image/png',bytes:24,width:1080,height:2400}}})
 const runtime={tasks:ledger,results,state:{revision:1},async endSession(){},async readPage(session,q,opts,signal,onPage){return readPage(driver([page([a])],{signal}),q,opts,async snapshot=>{await onPage(snapshot);ready();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))})}}
 registerAndroidTools(ctx,runtime);t.after(async()=>{await ledger.close();await ctx.fiber.dispose()});const agent={id:'visual-cancel',options:{},session:{requestContext:()=>({provider:'p',model:'m'})},cancel(){}}
 const call=registry.execute({callId:'cancel',name:'android_read_page',arguments:{...query,...options,mode:'screenshots'},agent,signal:new AbortController().signal});await started;ledger.requestStop(ledger.status(agent.id).id);assert.equal((await call).isError,true)
 const saved=results.get(results.summaries()[0].id);assert.equal(saved.rows.length,0);assert.equal(saved.observation_ids.length,1);assert.equal(saved.status,'partial');assert(saved.summary.includes('1 屏原始截图'))
})
