import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseHierarchy } from '../dist/observation.js'
import { tapTarget, waitForUi, scrollPages, screenFingerprint } from '../dist/navigation.js'
import { AndroidRuntime } from '../dist/runtime.js'
import { TaskLedger } from '../dist/tasks.js'

const node = (text, extra='', bounds='[10,120][900,220]') => `<node text="${text}" package="com.test.app" enabled="true" class="android.widget.TextView" bounds="${bounds}" ${extra}/>`
const tree = body => `<hierarchy>${body}</hierarchy>`
function page(titles, options={}) {
  return tree(`<node package="${options.package ?? 'com.test.app'}" scrollable="true" resource-id="list" class="androidx.recyclerview.widget.RecyclerView" bounds="[0,100][1000,2100]">${titles.map((title,index)=>`<node bounds="[0,${100+index*300}][1000,${400+index*300}]"><node text="${title}" resource-id="title" class="android.widget.TextView" package="${options.package ?? 'com.test.app'}" bounds="[10,${110+index*300}][900,${200+index*300}]"/>${node(`热度 ${title}`, '',`[10,${210+index*300}][900,${290+index*300}]`)}</node>`).join('')}</node>`)
}
let nextId=0
function capture(xml) { return {observation:{observation_id:`obs-${++nextId}`,serial:'test',width:1080,height:2400,rotation:0,revision:0,video_epoch:1,captured_at:new Date().toISOString(),...((({elements,truncated})=>({elements,tree_truncated:truncated}))(parseHierarchy(xml,1080,2400))),tree_error:null},png:Buffer.alloc(0)} }
function driver(pages, controller=new AbortController()) {
  let cursor=0;const events=[]
  return {events,signal:controller.signal,async capture(){controller.signal.throwIfAborted();return capture(pages[Math.min(cursor++,pages.length-1)])},async press(){events.push('tap')},async scroll(){events.push('scroll')}}
}
test('fresh selector ambiguity and missing target never emit a tap',async()=>{
  for(const [xml,status] of [[tree(node('提交')+node('提交')),'ambiguous'],[tree(node('其他')),'not_found']]) {
    const d=driver([xml]);const result=await tapTarget(d,{text:'提交',exact:true},{},);assert.equal(result.status,status);assert.equal(result.action_sent,false);assert.deepEqual(d.events,[])
  }
})
test('one tap is followed by bounded verification, never replayed when screen stays unchanged',async()=>{
  const xml=tree(node('搜索','clickable="true"')),d=driver([xml])
  const result=await tapTarget(d,{text:'搜索',exact:true},{max_attempts:3,interval_ms:100})
  assert.equal(result.verification.status,'not_confirmed');assert.equal(result.verification.attempts,3);assert.deepEqual(d.events,['tap']);assert.equal(result.pages.length,4)
})
test('post-tap condition must become newly visible; a preexisting condition cannot confirm success',async()=>{
  const xml=tree(node('搜索','clickable="true"')+node('结果'))
  const old=await tapTarget(driver([xml]),{text:'搜索',exact:true},{verify_text:'结果',max_attempts:1,interval_ms:100})
  assert.equal(old.verification.status,'not_confirmed');assert.equal(old.verification.condition_already_present,true)
  const fresh=await tapTarget(driver([tree(node('搜索')),tree(node('结果'))]),{text:'搜索',exact:true},{verify_text:'结果',interval_ms:100})
  assert.equal(fresh.verification.status,'matched')
})
test('wait distinguishes late present, absence, change and stable trees without any input',async()=>{
  const loading=tree(node('加载中')),done=tree(node('加载完成'))
  const d=driver([loading,done]);const present=await waitForUi(d,{text:'加载完成',exact:true},{max_attempts:2,interval_ms:100});assert.equal(present.status,'met');assert.equal(present.attempts,2)
  const stable=await waitForUi(driver([done]),{},{condition:'stable',interval_ms:100});assert.equal(stable.status,'met');assert.equal(stable.attempts,2)
  const changed=await waitForUi(driver([done]),{},{condition:'changed',baseline_fingerprint:screenFingerprint(capture(loading).observation)});assert.equal(changed.status,'met')
  const absent=await waitForUi(driver([done]),{text:'加载中',exact:true},{condition:'absent'});assert.equal(absent.status,'met');assert.deepEqual(d.events,[])
})
test('missing or incomplete UI tree cannot prove target absence or authorize an automatic tap',async()=>{
  const current=capture(tree(node('搜索')));current.observation.tree_truncated=true
  const d={signal:new AbortController().signal,capture:async()=>current,press:async()=>assert.fail('tap'),scroll:async()=>assert.fail('scroll')}
  assert.equal((await waitForUi(d,{text:'其他'},{condition:'absent'})).status,'tree_unavailable')
  assert.equal((await tapTarget(d,{text:'搜索'},{})).action_sent,false)
})
test('scroll search stops on target with fresh IDs and preserves all page evidence',async()=>{
  const d=driver([page(['A','B']),page(['B','目标'])]);const result=await scrollPages(d,{text:'目标',exact:true},{mode:'find',interval_ms:100})
  assert.equal(result.status,'found');assert.equal(result.scrolls,1);assert.equal(result.matches.length,1);assert.equal(result.page_count,2);assert.deepEqual(d.events,['scroll'])
  assert(result.observation.elements.some(e=>e===result.matches[0]))
})
test('overlapping list pages deduplicate anchors, retain row fields and link each source page',async()=>{
  const d=driver([page(['A','B']),page(['B','C']),page(['C','D'])]);const result=await scrollPages(d,{resource_id:'title'},{mode:'read',max_items:4,interval_ms:100})
  assert.equal(result.status,'limit_reached');assert.deepEqual(result.items.map(i=>i.title),['A','B','C','D']);assert.deepEqual(result.items[1].pages,[1,2]);assert.deepEqual(result.items[0].texts,['A','热度 A']);assert.equal(result.scrolls,2)
})
test('repeated pages stop after one scroll, with partial output rather than fabricated completeness',async()=>{
  const d=driver([page(['A','B'])]);const result=await scrollPages(d,{resource_id:'title'},{mode:'read',max_items:20,interval_ms:100})
  assert.equal(result.status,'unchanged');assert.equal(result.items.length,2);assert.equal(result.scrolls,1);assert.equal(result.requested_count,20)
})
test('nonoverlapping pages cannot be reported as a complete first-N list',async()=>{
  const d=driver([page(['A','B']),page(['D','E'])]),result=await scrollPages(d,{resource_id:'title'},{mode:'read',max_items:4,interval_ms:100})
  assert.equal(result.status,'continuity_lost');assert.deepEqual(result.items.map(i=>i.title),['A','B']);assert.equal(result.pages.length,2);assert.deepEqual(d.events,['scroll'])
})
test('ambiguous scroll areas never trigger guessed fullscreen gestures',async()=>{
  const xml=page(['A']).replace('</hierarchy>',`<node scrollable="true" resource-id="other" bounds="[0,2200][1080,2400]"/></hierarchy>`)
  const d=driver([xml]);const result=await scrollPages(d,{text:'missing'},{mode:'find'});assert.equal(result.status,'ambiguous_container');assert.equal(result.candidates.length,2);assert.deepEqual(d.events,[])
})
test('list reader does not scroll a header carousel that contains no requested titles',async()=>{
  const xml=page(['A']).replace('</hierarchy>','<node scrollable="true" resource-id="header" bounds="[0,0][1080,80]"/></hierarchy>')
  const d=driver([xml]),result=await scrollPages(d,{resource_id:'title'},{mode:'read',scroll_resource_id:'header'})
  assert.equal(result.status,'anchor_not_visible');assert.deepEqual(d.events,[])
})
test('unlabelled content container can be selected by empty resource ID and exact class',async()=>{
  const xml=page(['A','B']).replace('resource-id="list"','resource-id=""').replace('</hierarchy>','<node scrollable="true" resource-id="header" class="android.widget.HorizontalScrollView" bounds="[0,0][1080,80]"/></hierarchy>')
  const result=await scrollPages(driver([xml]),{resource_id:'title'},{mode:'read',scroll_resource_id:'',scroll_class_name:'androidx.recyclerview.widget.RecyclerView',max_items:2})
  assert.equal(result.status,'limit_reached');assert.deepEqual(result.items.map(i=>i.title),['A','B'])
})
test('scroll count zero observes once, and app switches stop before another scroll',async()=>{
  const zero=driver([page(['A'])]);assert.equal((await scrollPages(zero,{text:'X'},{mode:'find',max_scrolls:0})).scrolls,0);assert.deepEqual(zero.events,[])
  const d=driver([page(['A']),page(['B'],{package:'com.other.app'})]);const result=await scrollPages(d,{text:'X'},{mode:'find',interval_ms:100});assert.equal(result.status,'context_changed');assert.deepEqual(d.events,['scroll'])
})
test('malformed limits and missing list title selector are rejected before phone access',async()=>{
  const d={capture:()=>assert.fail('capture'),signal:new AbortController().signal}
  await assert.rejects(scrollPages(d,{resource_id:'title'},{mode:'read',max_scrolls:8}),/次数/)
  await assert.rejects(scrollPages(d,{package_name:'com.test.app'},{mode:'read'}),/标题锚点/)
  await assert.rejects(waitForUi(d,{},{condition:'changed'}),/fingerprint/)
})
test('cancelling a multi-page operation prevents further scrolling',async()=>{
  const controller=new AbortController(),d=driver([page(['A']),page(['B'])],controller)
  d.scroll=async()=>{d.events.push('scroll');controller.abort()}
  await assert.rejects(scrollPages(d,{text:'X'},{mode:'find',interval_ms:100}),/abort/i);assert.deepEqual(d.events,['scroll'])
})
test('row clipping excludes off-screen nodes and ambiguous wrapper rows do not mix item fields',async()=>{
  const xml=tree('<node scrollable="true" bounds="[0,500][1080,1000]"><node>'+node('不可见','','[0,0][100,100]')+node('A','resource-id="title"','[0,500][100,600]')+node('B','resource-id="title"','[0,700][100,800]')+'</node></node>')
  const d=driver([xml]);const result=await scrollPages(d,{resource_id:'title'},{mode:'read',max_scrolls:0});assert(!result.observation.elements.some(e=>e.text==='不可见'));assert.deepEqual(result.items.map(i=>i.texts),[['A'],['B']])
})
test('direct shared input interrupts a composite operation, then Agent can immediately observe',async t=>{
  const commands=[];let finish
  const png=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(1080,16);png.writeUInt32BE(2400,20)
  const video={input:{geometry:{width:576,height:1280,epoch:1},async send(c){commands.push(c)}},async read(){return new Promise(resolve=>finish=()=>resolve({done:true}))},async close(){finish?.()}}
  const backend={async list(){return[{serial:'test',state:'device'}]},async open(){return video},async dumpUi(){return tree(node('目标','clickable="true"'))},async screenshot(){return png}}
  const runtime=new AndroidRuntime(backend);t.after(()=>runtime.close())
  const action=runtime.tapTarget('a',{text:'目标'},{duration_ms:3000},new AbortController().signal),rejected=assert.rejects(action,/abort|输入/i)
  while(!commands.some(c=>c.phase==='down'))await new Promise(r=>setTimeout(r,1))
  await runtime.manual('viewer',{kind:'key',key:'home'});await rejected;assert.equal(runtime.state.mode,'idle');assert.equal((await runtime.waitUi('a',{text:'目标'},{},new AbortController().signal)).status,'met')
})
test('task records retain every page screenshot and structured partial list result',async t=>{
  const ledger=new TaskLedger();t.after(()=>ledger.close());ledger.begin('a','call','android_read_list',{})
  const ref={attachmentId:'page-one',mediaType:'image/png',bytes:24,width:1080,height:2400}
  ledger.finish('a','call','android_read_list',{isError:false,value:{status:'scroll_limit',pages:[{screenshot:ref}],items:[{title:'A',pages:[1]}],scrolls:0}})
  const task=ledger.get(ledger.status('a').id),op=task.operations[0];assert.equal(op.summary.itemCount,1);assert.deepEqual(ledger.evidence(`${op.id}~1`),ref);assert.equal(op.outcome,'scroll_limit')
})
