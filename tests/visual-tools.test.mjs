import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PNG } from 'pngjs'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { AndroidRuntime } from '../dist/runtime.js'
import { registerAndroidTools } from '../dist/tools.js'
import { transformScreen, imageDifference, decodeScreen } from '../dist/screen-image.js'

const signal = () => AbortSignal.timeout(10000)
function frame(paint = () => [0, 0, 0], width = 20, height = 30) {
  const png = new PNG({width,height})
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) png.data.set([...paint(x,y),255],(y*width+x)*4)
  return PNG.sync.write(png)
}
function fixture(t, frames = [frame()]) {
  let end, captures=0, trees=0
  const calls=[]
  const input={geometry:{width:10,height:15,epoch:1},async send(c){calls.push(c)},async gestureFrame(points){calls.push({kind:'gesture',points})}}
  const video={input,codec:1,deviceName:'fixture',read(){return new Promise(resolve=>{end=()=>resolve({done:true})})},async close(){end?.()}}
  const backend={async list(){return[{serial:'test',state:'device'}]},async open(){return video},async dumpUi(){trees++;return '<hierarchy rotation="0"><node text="" class="android.widget.EditText" focused="true" bounds="[0,0][20,10]"/></hierarchy>'},async screenshot(){return frames[Math.min(captures++,frames.length-1)]}}
  const runtime=new AndroidRuntime(backend)
  t.after(()=>runtime.close())
  return{runtime,backend,video,calls,get captures(){return captures},get trees(){return trees}}
}

test('pure screenshot bypasses unavailable UI tree; crop pixels retain original coordinate mapping and single-use IDs',async t=>{
  const f=fixture(t,[frame((x,y)=>[x*10,y*7,100])])
  const result=await f.runtime.observe('a',signal(),{mode:'screenshot',region:{x:4,y:6,width:8,height:10},scale:2})
  assert.equal(f.trees,0);assert.equal(result.observation.rotation,null);assert.deepEqual(result.observation.elements,[])
  assert.equal(result.observation.width,20);assert.equal(result.observation.height,30)
  const cropped=PNG.sync.read(result.png)
  assert.equal(cropped.width,16);assert.equal(cropped.height,20)
  assert.deepEqual([...cropped.data.subarray(0,4)],[40,42,100,255])
  const map=result.observation.image_transform
  assert.equal(map.region.x,4);assert.equal(map.scale,2)
  // Cropped pixel 8,8 maps to original 8,10; video coordinates are half-size.
  await f.runtime.tap('a',result.observation.observation_id,{x:map.region.x+8/map.scale,y:map.region.y+8/map.scale},signal())
  const down=f.calls.find(c=>c.phase==='down');assert.equal(down.x,4);assert.equal(down.y,5)
  await assert.rejects(f.runtime.tap('a',result.observation.observation_id,{x:1,y:1},signal()),/失效/)
})

test('crop and zoom validate bounds and allocations; UI mode retains focused fields',async t=>{
  const f=fixture(t)
  await assert.rejects(f.runtime.observe('a',signal(),{scale:0}),/倍数/)
  await assert.rejects(f.runtime.observe('a',signal(),{region:{x:18,y:0,width:5,height:5}}),/范围/)
  assert.throws(()=>transformScreen(frame(),{region:{x:-1,y:0,width:2,height:2}}),/区域/)
  const hugeHeader=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(hugeHeader);hugeHeader.writeUInt32BE(8000,16);hugeHeader.writeUInt32BE(8000,20)
  assert.throws(()=>transformScreen(hugeHeader,{scale:4}),/大小限制/)
  assert.throws(()=>decodeScreen(hugeHeader),/大小限制/)
  const ui=await f.runtime.observe('a',signal());assert.equal(ui.observation.capture_mode,'ui');assert(ui.observation.elements[0].focused)
})

test('pixel comparison ignores PNG encoding and excludes changes outside selected region',async t=>{
  const a=frame(),b=frame((x)=>x<10?[255,255,255]:[0,0,0]),region={x:10,y:0,width:10,height:30}
  assert.equal(imageDifference(decodeScreen(a),decodeScreen(b),region,16),0)
  assert.equal(imageDifference(decodeScreen(a),decodeScreen(b),{x:0,y:0,width:20,height:30},16),.5)
  const f=fixture(t,[a,b])
  const result=await f.runtime.waitImage('a',{condition:'image_changed',region,timeout_ms:350,interval_ms:100},signal())
  assert.equal(result.status,'timed_out');assert.equal(result.changed_ratio,0);assert.equal(f.trees,0)
  assert(result.attempts>=2);assert(result.png.equals(b))
  await f.runtime.tap('a',result.observation.observation_id,{x:1,y:1},signal())
})

test('image_changed compares with first frame and returns a fresh actionable observation',async t=>{
  const f=fixture(t,[frame(),frame(()=>[40,0,0])])
  const result=await f.runtime.waitImage('a',{condition:'image_changed',timeout_ms:1000,interval_ms:100},signal())
  assert.equal(result.status,'met');assert.equal(result.changed_ratio,1);assert.equal(result.attempts,2)
  assert.equal(result.comparison,'first_frame');assert(result.elapsed_ms>=100)
  await f.runtime.swipe('a',result.observation.observation_id,{x1:1,y1:1,x2:5,y2:5,durationMs:100},signal())
})

test('stability resets on a changed frame and detects cumulative drift against the anchor',async t=>{
  const f=fixture(t,[frame(),frame(()=>[8,0,0]),frame(()=>[16,0,0]),frame(()=>[24,0,0]),frame(()=>[24,0,0])])
  const result=await f.runtime.waitImage('a',{condition:'image_stable',timeout_ms:1800,interval_ms:100,stable_ms:400,pixel_threshold:16},signal())
  assert.equal(result.status,'met');assert(result.attempts>=7);assert(result.elapsed_ms>=650)
  assert(result.stable_for_ms>=400);assert.equal(f.trees,0)
})

test('image wait rejects invalid options, reports geometry change, propagates capture errors and cancellation',async t=>{
  const f=fixture(t,[frame(),frame(()=>[0,0,0],30,20)])
  await assert.rejects(f.runtime.waitImage('a',{condition:'image_changed',change_ratio:1},signal()),/比例/)
  await assert.rejects(f.runtime.waitImage('a',{condition:'image_changed',pixel_threshold:255},signal()),/阈值/)
  assert.equal(f.captures,0)
  const result=await f.runtime.waitImage('a',{condition:'image_changed',interval_ms:100,timeout_ms:1000},signal())
  assert.equal(result.status,'geometry_changed')
  f.backend.screenshot=async()=>{throw new Error('capture broken')}
  await assert.rejects(f.runtime.waitImage('a',{condition:'image_stable'},signal()),/capture broken/)
  f.backend.screenshot=async()=>frame()
  const abort=new AbortController(),pending=f.runtime.waitImage('a',{condition:'image_stable',stable_ms:5000},abort.signal)
  const rejected=assert.rejects(pending,/abort/i);await delay(50);abort.abort();await rejected
  assert.equal(f.runtime.state.owner,null)
})

test('manual control interrupts image wait and invalidates every earlier observation',async t=>{
  const f=fixture(t),before=await f.runtime.observe('a',signal(),{mode:'screenshot'})
  const pending=f.runtime.waitImage('a',{condition:'image_stable',stable_ms:5000},signal())
  const rejected=assert.rejects(pending);await delay(50)
  await f.runtime.manual('viewer',{kind:'key',key:'home'});await rejected
  await assert.rejects(f.runtime.tap('a',before.observation.observation_id,{x:1,y:1},signal()),/失效/)
})

test('image deadline survives garbage collection during screenshot processing',async()=>{
  // PNG allocation can collect temporary AbortSignal.timeout sources in Node 22.
  // Force GC in a separate process so this regression is deterministic without changing the test runner.
  const program=`
    import {AndroidRuntime} from './dist/runtime.js';
    import {PNG} from 'pngjs';
    let end;
    const png=PNG.sync.write(new PNG({width:20,height:30}));
    const video={codec:1,deviceName:'test',input:{geometry:{width:20,height:30,epoch:1},async send(){}},read(){return new Promise(resolve=>{end=()=>resolve({done:true})})},async close(){end?.()}};
    const runtime=new AndroidRuntime({async list(){return[{serial:'test',state:'device'}]},async open(){return video},async screenshot(){global.gc();return png}});
    try{const result=await runtime.waitImage('a',{condition:'image_changed',timeout_ms:350,interval_ms:100},new AbortController().signal);console.log(JSON.stringify({status:result.status,elapsed:result.elapsed_ms}));}finally{await runtime.close()}
  `
  const {stdout}=await promisify(execFile)(process.execPath,['--expose-gc','--input-type=module','-e',program],{timeout:8000,windowsHide:true})
  const result=JSON.parse(stdout.trim());assert.equal(result.status,'timed_out');assert(result.elapsed<1500)
})

test('post-action capture is opt-in, bypasses UI tree, and is usable for the next action',async t=>{
  const f=fixture(t),before=await f.runtime.observe('a',signal())
  const tapped=await f.runtime.tap('a',before.observation.observation_id,{x:2,y:2},signal(),{return_screenshot:true,screenshot_delay_ms:0})
  assert.equal(tapped.status,'sent');assert(tapped.png);assert.equal(tapped.observation.capture_mode,'screenshot');assert.equal(f.trees,1)
  const swiped=await f.runtime.swipe('a',tapped.observation.observation_id,{x1:1,y1:1,x2:5,y2:5,durationMs:100},signal(),{return_screenshot:true,screenshot_delay_ms:0})
  assert(swiped.png);assert.notEqual(swiped.observation.observation_id,tapped.observation.observation_id)
  const captures=f.captures;await f.runtime.key('a','back',signal());assert.equal(f.captures,captures)
  const key=await f.runtime.key('a','home',signal(),{return_screenshot:true,screenshot_delay_ms:0});assert(key.png)
})

test('post-action validation precedes input and capture failures never replay the action',async t=>{
  const f=fixture(t),before=await f.runtime.observe('a',signal())
  await assert.rejects(f.runtime.tap('a',before.observation.observation_id,{x:2,y:2},signal(),{screenshot_delay_ms:100}),/return_screenshot/)
  assert(!f.calls.some(c=>c.phase==='down'))
  f.backend.screenshot=async()=>{throw new Error('capture unavailable')}
  const result=await f.runtime.tap('a',before.observation.observation_id,{x:2,y:2},signal(),{return_screenshot:true,screenshot_delay_ms:0})
  assert.equal(result.status,'sent');assert.match(result.screenshot_error,/unavailable/)
  assert.equal(f.calls.filter(c=>c.phase==='down').length,1);assert.equal(result.observation,undefined)
})

test('manual input cancels post-action delay without taking a misleading screenshot',async t=>{
  const f=fixture(t),before=await f.runtime.observe('a',signal())
  const pending=f.runtime.tap('a',before.observation.observation_id,{x:2,y:2},signal(),{return_screenshot:true,screenshot_delay_ms:5000})
  const rejected=assert.rejects(pending)
  while(!f.calls.some(c=>c.phase==='up'))await delay(10)
  await f.runtime.manual('viewer',{kind:'key',key:'home'});await rejected
  assert.equal(f.captures,1);assert.equal(f.runtime.state.owner,null)
})

test('Harness validates visual schemas, supplies image attachments and rejects text-only actions before input',async t=>{
  const f=fixture(t),ctx=new Context();ctx.provide('systemPrompt',{tools(){}});const registry=new ToolRuntime(ctx)
  let vision=true,attachmentFailure=false,n=0
  ctx.provide('llm',{async resolveModelInfo(){return{inputModalities:vision?['text','image']:['text']}}})
  ctx.provide('attachments',{async saveImage({data}){if(attachmentFailure)throw new Error('disk full');const png=PNG.sync.read(data);return{attachmentId:'screen-'+(++n),mediaType:'image/png',bytes:data.length,width:png.width,height:png.height}}})
  registerAndroidTools(ctx,f.runtime);t.after(()=>ctx.fiber.dispose())
  const agent={id:'a',options:{},session:{requestContext:()=>({provider:'test',model:'test'})}}
  let id=0;const call=(name,args)=>registry.execute({name,arguments:args,callId:'visual-'+(++id),agent,signal:signal()})
  const crop=await call('android_observe',{mode:'screenshot',region:{x:2,y:4,width:6,height:8},scale:2})
  assert.equal(crop.isError,false,JSON.stringify(crop));assert.equal(crop.value.width,20);assert.equal(crop.value.screenshot.width,12)
  assert(crop.content.some(c=>c.type==='image'));assert.equal(crop.value.screen_fingerprint,undefined)
  assert.equal((await call('android_observe',{mode:'screenshot',region:{x:0,y:0,width:3}})).isError,true)
  const tapped=await call('android_tap',{observation_id:crop.value.observation_id,x:2,y:4,return_screenshot:true,screenshot_delay_ms:0})
  assert.equal(tapped.isError,false,JSON.stringify(tapped));assert.equal(tapped.value.action_sent,true);assert(tapped.content.some(c=>c.type==='image'))
  const gesture=await call('android_gesture',{observation_id:tapped.value.observation_id,kind:'double_tap',x:2,y:4,return_screenshot:true,screenshot_delay_ms:0})
  assert.equal(gesture.isError,false,JSON.stringify(gesture));assert(gesture.content.some(c=>c.type==='image'))
  const ui=await call('android_observe',{})
  const text=await call('android_input_text',{observation_id:ui.value.observation_id,text:'abc',return_screenshot:true,screenshot_delay_ms:0})
  assert.equal(text.isError,false,JSON.stringify(text));assert(text.content.some(c=>c.type==='image'))
  const waited=await call('android_wait',{condition:'image_stable',timeout_ms:600,stable_ms:100,interval_ms:100})
  assert.equal(waited.isError,false,JSON.stringify(waited));assert.equal(waited.value.status,'met');assert(waited.content.some(c=>c.type==='image'))
  assert.equal((await call('android_wait',{condition:'image_changed',text:'victory'})).isError,true)
  assert.equal((await call('android_wait',{condition:'stable',change_ratio:.1})).isError,true)
  attachmentFailure=true
  const failure=await call('android_key',{key:'home',return_screenshot:true,screenshot_delay_ms:0})
  assert.equal(failure.isError,false);assert.equal(failure.value.action_sent,true);assert.match(failure.value.screenshot_error,/disk full/)
  vision=false;attachmentFailure=false;const previous=f.calls.length,captures=f.captures
  assert.equal((await call('android_key',{key:'home',return_screenshot:true})).isError,true)
  assert.equal((await call('android_observe',{mode:'screenshot'})).isError,true)
  assert.equal((await call('android_wait',{condition:'image_changed'})).isError,true)
  assert.equal(f.calls.length,previous);assert.equal(f.captures,captures)
})
