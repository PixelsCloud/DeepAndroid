import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { AndroidRuntime } from '../dist/runtime.js'
import { parseHierarchy } from '../dist/observation.js'
import { diagnoseError } from '../dist/diagnostics.js'
const xml = '<hierarchy rotation="0"><node text="设置" bounds="[100,200][300,400]" clickable="true" enabled="true" class="android.widget.TextView"/><node text="secret" content-desc="secret" password="true" class="android.widget.EditText" bounds="[0,0][90,90]"/></hierarchy>'
function fixture() {
  const calls = []; let end
  const png = Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png.writeUInt32BE(1080,16); png.writeUInt32BE(2400,20)
  const input = { geometry: { width: 576, height: 1280, epoch: 1 }, async send(command) { calls.push(command) } }
  const video = { input, codec: 1, deviceName: 'test', async read() { return new Promise(resolve => { end = () => resolve({ done: true }) }) }, async resetVideo() {}, async close() { end?.() } }
  const backend = { async list() { return [{ serial: 'phone-a', state: 'device', model: 'test' }] }, async open() { return video }, async screenshot() { return png }, async dumpUi() { return xml }, async openApp(_serial,packageName) { calls.push({kind:'open_app',packageName}) },async listApps(){return [{name:'设置',package_name:'com.android.settings',system:true}]} }
  return { runtime: new AndroidRuntime(backend), video, backend, calls, endStream: () => end?.() }
}
const signal = () => new AbortController().signal
test('audio capture errors are reported independently and leave the video connection and controls usable',async()=>{
 const{runtime,video,calls}=fixture();video.audio={status:'success',async read(){throw new Error('audio capture ended')}};const events=[],unsubscribe=runtime.subscribe(event=>events.push(event))
 try{await runtime.ensure('phone-a');await delay(1);assert.equal(runtime.state.state,'streaming');assert.equal(runtime.audioStatus,'errored');assert(events.some(event=>event.type==='audio-state'&&event.status==='errored'));await runtime.key('a','home',signal());assert(calls.some(command=>command.kind==='key'&&command.key==='home'))}finally{unsubscribe();await runtime.close()}
})
test('conversations share the phone; actions invalidate every old observation and scale coordinates',async t=>{
 const {runtime,calls}=fixture();t.after(()=>runtime.close())
 const a=await runtime.observe('a',signal()),b=await runtime.observe('b',signal())
 await assert.rejects(runtime.tap('b',a.observation.observation_id,{elementId:'e1'},signal()),/失效/)
 await runtime.tap('a',a.observation.observation_id,{elementId:'e1'},signal())
 const down=calls.find(c=>c.phase==='down');assert.equal(down.x,106);assert.equal(down.y,160)
 await assert.rejects(runtime.tap('b',b.observation.observation_id,{elementId:'e1'},signal()),/失效/)
 await runtime.observe('b',signal());assert.equal(runtime.state.owner,null)
})

test('direct manual input interrupts a gesture and both conversations can continue without permission',async t=>{
 const {runtime,calls}=fixture();t.after(()=>runtime.close());const {observation}=await runtime.observe('a',signal())
 const tap=runtime.tap('a',observation.observation_id,{elementId:'e1',durationMs:3000},signal()),failed=assert.rejects(tap,error=>diagnoseError(error).code==='INPUT_INTERRUPTED')
 while(!calls.some(c=>c.phase==='down'))await delay(1)
 await runtime.manual('viewer',{kind:'key',key:'home'});await failed
 assert(calls.findIndex(c=>c.kind==='release'&&calls.indexOf(c)>calls.findIndex(c=>c.phase==='down'))<calls.findIndex(c=>c.kind==='key'))
 await runtime.observe('b',signal());await runtime.key('a','home',signal());assert.equal(runtime.state.mode,'idle')
})

test('viewer detach keeps capture; manual action invalidates old observations', async t => {
  const { runtime } = fixture(); t.after(() => runtime.close())
  const { observation } = await runtime.observe('a',signal())
  const detach = runtime.subscribe(() => {}); detach(); await runtime.viewerClosed('v')
  assert.equal(runtime.state.state,'streaming')
  await runtime.manual('v',{kind:'key',key:'home'})
  assert.equal(runtime.state.mode,'idle')
  await assert.rejects(runtime.tap('a', observation.observation_id,{x:1,y:1},signal()), /失效/)
})
test('cancellation and rotation reject old coordinates without issuing a touch', async t => {
  const { runtime, video, calls } = fixture(); t.after(() => runtime.close())
  const { observation } = await runtime.observe('a',signal()); video.input.geometry.epoch++
  await assert.rejects(runtime.tap('a',observation.observation_id,{x:1,y:1},signal()),/失效/)
  const abort = new AbortController(); abort.abort()
  await assert.rejects(runtime.key('a','home',abort.signal), /abort/i)
  assert(!calls.some(c => c.kind === 'pointer' || c.kind === 'key'))
})
test('hierarchy redacts password fields, bounds output, and rejects XML declarations', () => {
  const tree = parseHierarchy(xml,1080,2400)
  assert.equal(tree.elements.length,2); assert.equal(tree.elements[1].text,''); assert.equal(tree.elements[1].description,'')
  assert.throws(()=>parseHierarchy('<!DOCTYPE x><hierarchy/>',1,1),/声明/)
})
test('empty focused AutoCompleteTextView search fields are editable and accept native input with a fresh observation',async()=>{
 const{runtime,backend,calls}=fixture();backend.dumpUi=async()=>'<hierarchy><node class="android.widget.AutoCompleteTextView" resource-id="android:id/search_src_text" text="" focused="true" enabled="true" bounds="[20,100][800,200]"/></hierarchy>'
 try{const capture=await runtime.observe('search',signal());assert.equal(capture.observation.elements.length,1);assert.equal(capture.observation.elements[0].editable,true);await runtime.inputText('search',capture.observation.observation_id,'fixture.png',signal());assert(calls.some(command=>command.kind==='text'&&command.text==='fixture.png'))}finally{await runtime.close()}
})

test('cancelling an active gesture frees ownership for the next conversation', async t => {
  const { runtime, calls } = fixture(); t.after(() => runtime.close())
  const { observation } = await runtime.observe('a',signal()); const abort = new AbortController()
  const action = runtime.tap('a',observation.observation_id,{elementId:'e1',durationMs:3000},abort.signal)
  const rejected = assert.rejects(action,/abort/i)
  while(!calls.some(c=>c.phase==='down')) await delay(1)
  abort.abort(); await rejected
  assert.equal(runtime.state.owner,null); assert.equal(runtime.state.mode,'idle')
  await runtime.observe('b',signal())
})

test('a new native operation can reconnect after disconnect without a permission switch',async t=>{
 const {runtime}=fixture();t.after(()=>runtime.close());await runtime.observe('a',signal());await runtime.disconnect()
 await runtime.observe('b',signal());assert.equal(runtime.state.state,'streaming');assert.equal(runtime.state.mode,'idle')
})

test('unexpected stream end allows the next operation to reconnect directly',async t=>{
 const {runtime,endStream}=fixture();t.after(()=>runtime.close());await runtime.observe('a',signal());endStream()
 for(let i=0;i<100&&runtime.state.state!=='error';i++)await delay(1)
 assert.equal(runtime.state.state,'error');await runtime.observe('b',signal());assert.equal(runtime.state.state,'streaming')
})

test('ending one conversation neither cancels another active operation nor clears its binding',async t=>{
 const {runtime,calls}=fixture();t.after(()=>runtime.close());await runtime.observe('a',signal());const b=await runtime.observe('b',signal()),abort=new AbortController()
 const action=runtime.tap('b',b.observation.observation_id,{elementId:'e1',durationMs:3000},abort.signal),failed=assert.rejects(action,/abort/i)
 while(!calls.some(c=>c.phase==='down'))await delay(1)
 await runtime.endSession('a',true);assert.equal(runtime.state.owner,'b');assert.equal((await runtime.list('a')).binding,null);assert.equal((await runtime.list('b')).binding,'phone-a')
 abort.abort();await failed;assert.equal(runtime.state.owner,null)
})

test('cancelling while connecting stops the caller without cancelling the shared viewer connection', async t => {
  const { runtime, backend, video } = fixture(); t.after(() => runtime.close())
  let resolveOpen, opening = false
  backend.open = () => { opening = true; return new Promise(resolve => { resolveOpen = resolve }) }
  const abort = new AbortController(), action = runtime.observe('a',abort.signal)
  const rejected = assert.rejects(action,/abort/i)
  while(!opening) await delay(1)
  abort.abort(); await rejected
  assert.equal(runtime.state.owner,null); assert.equal(runtime.state.state,'connecting')
  resolveOpen(video); await runtime.ensure('phone-a')
  assert.equal(runtime.state.state,'streaming'); await runtime.observe('b',signal())
})

test('an Agent gesture waits for an ongoing manual drag to finish, without a control mode',async t=>{
 const {runtime,calls}=fixture();t.after(()=>runtime.close());await runtime.observe('a',signal())
 const point={x:100,y:200,width:576,height:1280,epoch:1}
 await runtime.manual('v',{kind:'pointer',phase:'down',...point})
 const action=runtime.key('b','home',signal());await delay(10);assert(!calls.some(c=>c.kind==='key'))
 await runtime.manual('v',{kind:'pointer',phase:'up',...point});await action;assert.equal(calls.filter(c=>c.kind==='key').length,1)
})

test('a binding is kept after disconnect, but an explicit choice can switch devices directly',async t=>{
 const {runtime,backend}=fixture();t.after(()=>runtime.close());await runtime.observe('a',signal());await runtime.disconnect()
 backend.list=async()=>[{serial:'phone-b',state:'device'}];assert.equal((await runtime.list('a')).binding,'phone-a')
 await runtime.bind('a','phone-b');assert.equal((await runtime.list('a')).binding,'phone-b')
})

test('app lookup refuses ambiguity and missing names, while exact launch uses the observed package',async t=>{
  const {runtime,backend,calls}=fixture();t.after(()=>runtime.close())
  backend.listApps=async()=>[{name:'设置',package_name:'com.a.settings',system:true},{name:'设置',package_name:'com.b.settings',system:false},{name:'设置助手',package_name:'com.c.helper',system:false}]
  assert.equal((await runtime.openAppByName('a','设置',signal())).status,'ambiguous')
  assert.equal((await runtime.openAppByName('a','助手',signal())).status,'not_found')
  assert(!calls.some(c=>c.kind==='open_app'))
  const opened=await runtime.openAppByName('a','设置助手',signal());assert.equal(opened.app.package_name,'com.c.helper')
  assert.deepEqual(calls.filter(c=>c.kind==='open_app').map(c=>c.packageName),['com.c.helper'])
  const apps=await runtime.apps('a','设置',1,signal());assert.equal(apps.matched_count,3);assert.equal(apps.apps.length,1);assert.equal(apps.truncated,true)
  assert.equal(apps.next_offset,1)
  const next=await runtime.apps('a','设置',2,signal(),apps.next_offset);assert.equal(next.apps.length,2);assert.equal(next.next_offset,null);assert.equal(next.truncated,false)
})

test('find retries observations within its budget, returns only latest IDs and never replays an action',async t=>{
  const {runtime,backend,calls}=fixture();t.after(()=>runtime.close())
  let reads=0;backend.dumpUi=async()=>{reads++;return xml.replace('设置',reads===2?'目标':'等待')}
  const result=await runtime.find('a',{text:'目标',exact:true},3,100,signal())
  assert.equal(result.status,'found');assert.equal(result.attempts,2);assert.equal(reads,2);assert.equal(result.matches.length,1)
  assert(!calls.some(c=>['key','pointer','text','open_app'].includes(c.kind)))
  await runtime.tap('a',result.observation.observation_id,{elementId:result.matches[0].element_id},signal())
  assert.equal(calls.filter(c=>c.phase==='down').length,1)
})

test('find reports missing targets and unavailable trees without infinite retry',async t=>{
  const {runtime,backend}=fixture();t.after(()=>runtime.close());let reads=0
  backend.dumpUi=async()=>{reads++;return xml}
  const result=await runtime.find('a',{text:'不存在'},3,100,signal());assert.equal(result.status,'not_found');assert.equal(reads,3)
  backend.dumpUi=async()=>{throw new Error('unavailable')}
  const unavailable=await runtime.find('a',{text:'不存在'},1,100,signal());assert.equal(unavailable.status,'tree_unavailable');assert.equal(unavailable.observation.tree_error,'unavailable')
  await assert.rejects(runtime.find('a',{text:'a'},4,100,signal()),/次数/)
  await assert.rejects(runtime.find('a',{},1,100,signal()),/提供/)
})

test('manual input interrupts pending find retries without blocking the next observation',async t=>{
 const {runtime,backend}=fixture();t.after(()=>runtime.close());let reads=0;backend.dumpUi=async()=>{reads++;return xml}
 const action=runtime.find('a',{text:'不存在'},3,1000,signal()),failed=assert.rejects(action,/abort|输入/i)
 while(!reads)await delay(1)
 await runtime.manual('v',{kind:'key',key:'home'});await failed;assert.equal(reads,1);await runtime.observe('a',signal())
})

test('text input requires observed focus, supports replacement, and consumes the observation only once',async t=>{
  const {runtime,backend,calls}=fixture();t.after(()=>runtime.close())
  let current=await runtime.observe('a',signal())
  await assert.rejects(runtime.inputText('a',current.observation.observation_id,'电池',signal()),/聚焦/)
  assert(!calls.some(c=>c.kind==='text'))
  backend.dumpUi=async()=>'<hierarchy><node text="旧文字" focused="true" enabled="true" class="android.widget.EditText" bounds="[0,100][1000,200]"/></hierarchy>'
  current=await runtime.observe('a',signal());assert.equal(current.observation.elements[0].focused,true)
  await runtime.inputText('a',current.observation.observation_id,'电池',signal(),true)
  assert.deepEqual(calls.filter(c=>c.kind==='text'||c.kind==='key'),[{kind:'key',key:'selectAll'},{kind:'text',text:'电池',method:'paste'}])
  await assert.rejects(runtime.inputText('a',current.observation.observation_id,'重复',signal()),/失效/)
})

test('release cleans up only its conversation and preserves another fresh observation',async t=>{
 const {runtime,calls}=fixture();t.after(()=>runtime.close());await runtime.observe('a',signal());const b=await runtime.observe('b',signal())
 await runtime.release('a');await runtime.tap('b',b.observation.observation_id,{elementId:'e1'},signal());assert.equal(calls.filter(c=>c.phase==='down').length,1)
})
test('ending a conversation wakes its operation while a manual pointer is held',async t=>{
 const {runtime,calls}=fixture();t.after(()=>runtime.close());await runtime.observe('a',signal())
 await runtime.manual('v',{kind:'pointer',phase:'down',x:10,y:20,width:576,height:1280,epoch:1})
 const action=runtime.key('a','home',signal()),failed=assert.rejects(action,/任务已结束/)
 await delay(1);await runtime.endSession('a');await failed;assert(!calls.some(c=>c.kind==='key'))
 await runtime.viewerClosed('v');await runtime.key('b','home',signal())
})
test('closing an inactive viewer does not cancel another conversation operation',async t=>{
 const {runtime,calls}=fixture();t.after(()=>runtime.close());const current=await runtime.observe('a',signal())
 const action=runtime.tap('a',current.observation.observation_id,{elementId:'e1',durationMs:100},signal())
 while(!calls.some(c=>c.phase==='down'))await delay(1)
 await runtime.viewerClosed('inactive');await action;assert(calls.some(c=>c.phase==='up'))
})
test('old Agent cleanup finishes before a new manual pointer is pressed',async t=>{
 const {runtime,calls}=fixture();t.after(()=>runtime.close());const current=await runtime.observe('a',signal())
 const action=runtime.tap('a',current.observation.observation_id,{elementId:'e1',durationMs:3000},signal()),failed=assert.rejects(action,/abort|输入/i)
 while(!calls.some(c=>c.phase==='down'))await delay(1)
 await runtime.manual('v',{kind:'pointer',phase:'down',x:10,y:20,width:576,height:1280,epoch:1});await failed
 assert.equal(calls.at(-1).phase,'down');await delay(10);assert.equal(calls.at(-1).phase,'down')
 await runtime.viewerClosed('v');assert.equal(calls.at(-1).kind,'release')
})
