import {test} from 'node:test'
import assert from 'node:assert/strict'
import {setTimeout as delay} from 'node:timers/promises'
import {planGesture} from '../dist/gestures.js'
import {InputController} from '../dist/input.js'
import {AndroidRuntime} from '../dist/runtime.js'
const signal=()=>new AbortController().signal
function inputFixture(){const calls=[];const writer={async injectTouch(p){calls.push(p)},async injectKeyCode(){},async injectText(){},async injectScroll(){},async setClipboard(){}};return{input:new InputController(writer),writer,calls}}
async function runtimeFixture(){const{input,calls}=inputFixture();await input.setGeometry(540,1200);let finish;const video={input,codec:1,deviceName:'gesture fixture',async resetVideo(){},async read(){return new Promise(resolve=>finish=()=>resolve({done:true}))},async close(){await input.close();finish?.()}};const png=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(1080,16);png.writeUInt32BE(2400,20);const backend={async list(){return[{serial:'phone',state:'device'}]},async open(){return video},async screenshot(){return png},async dumpUi(){return'<hierarchy rotation="0"><node text="fixture" bounds="[0,0][1080,2400]" enabled="true"/></hierarchy>'}};return{runtime:new AndroidRuntime(backend),input,calls}}
test('gesture plans contain two distinct contacts, clockwise rotation, translated endpoints and bounded double taps',()=>{
 const pinch=planGesture({kind:'pinch',center_x:500,center_y:1000,radius_px:100,scale:2},1000,2000);assert.deepEqual(pinch[0].points,[{x:400,y:1000},{x:600,y:1000}]);assert.deepEqual(pinch.at(-2).points,[{x:300,y:1000},{x:700,y:1000}]);assert.deepEqual(pinch.at(-1).points,[])
 const rotate=planGesture({kind:'rotate',center_x:500,center_y:1000,radius_px:100,angle_degrees:90},1000,2000);assert(Math.abs(rotate.at(-2).points[0].x-500)<0.01);assert.equal(rotate.at(-2).points[0].y,900)
 const swipe=planGesture({kind:'two_finger_swipe',center_x:500,center_y:1000,radius_px:100,dx:20,dy:-50},1000,2000);assert.deepEqual(swipe.at(-2).points,[{x:420,y:950},{x:620,y:950}]);assert.deepEqual(planGesture({kind:'double_tap',x:20,y:30},100,200).map(f=>f.at_ms),[0,50,170,220])
})
test('invalid or future out-of-bounds gesture paths fail before injection',()=>{
 for(const options of [{kind:'pinch',center_x:50,center_y:100,scale:4,radius_px:20},{kind:'pinch',center_x:50,center_y:100,scale:1},{kind:'rotate',center_x:50,center_y:100,angle_degrees:0},{kind:'two_finger_swipe',center_x:50,center_y:100,dx:100,dy:0},{kind:'double_tap',x:10,y:20,scale:2},{kind:'double_tap',x:NaN,y:20},{kind:'double_tap',x:10,y:20,gap_ms:500}])assert.throws(()=>planGesture(options,100,200))
})
test('two contacts use separate IDs and release in reverse order on normal completion or rotation',async()=>{
 const{input,calls}=inputFixture();await input.setGeometry(100,200);const a={x:20,y:50,...input.geometry},b={x:80,y:50,...input.geometry};await input.gestureFrame([a,b]);await input.gestureFrame([{...a,y:60},{...b,y:60}]);await input.setGeometry(200,100)
 assert.deepEqual(calls.map(p=>[p.pointerId,p.action]),[[1n,0],[2n,0],[1n,2],[2n,2],[2n,1],[1n,1]]);assert(calls.slice(-2).every(p=>p.videoWidth===200&&p.videoHeight===100));await assert.rejects(input.gestureFrame([a,b]),/失效|旋转/);assert.equal(calls.length,6);await input.close()
})
test('a failed second-finger write still attempts to release both contacts and does not strand the input queue',async()=>{
 const{input,writer,calls}=inputFixture();await input.setGeometry(100,200);writer.injectTouch=async p=>{calls.push(p);if(p.pointerId===2n&&p.action===0)throw new Error('write failed')};const p={x:20,y:50,...input.geometry};await assert.rejects(input.gestureFrame([p,{...p,x:80}]),/write failed/);assert.deepEqual(calls.slice(-2).map(p=>[p.pointerId,p.action]),[[2n,1],[1n,1]]);await input.send({kind:'key',key:'home'});await input.close()
})
test('actual runtime scales screenshot gesture coordinates and consumes the observation exactly once',async()=>{
 const{runtime,calls}=await runtimeFixture();try{const{observation}=await runtime.observe('a',signal());const sent=await runtime.gesture('a',observation.observation_id,{kind:'double_tap',x:400,y:800,gap_ms:60},signal());assert.equal(sent.status,'sent');assert.deepEqual(calls.filter(p=>p.action===0).map(p=>[p.pointerX,p.pointerY]),[[200,400],[200,400]]);await assert.rejects(runtime.gesture('a',observation.observation_id,{kind:'double_tap',x:400,y:800},signal()),/失效/)}finally{await runtime.close()}
})
test('runtime validates the complete path before any touch and does not silently clamp invalid endpoints',async()=>{
 const{runtime,calls}=await runtimeFixture();try{const{observation}=await runtime.observe('a',signal());await assert.rejects(runtime.gesture('a',observation.observation_id,{kind:'pinch',center_x:100,center_y:800,radius_px:80,scale:4},signal()),/超出/);assert.equal(calls.length,0)}finally{await runtime.close()}
})
test('cancellation releases both live contacts and no gesture moves occur afterward',async()=>{
 const{runtime,calls}=await runtimeFixture(),abort=new AbortController();try{const{observation}=await runtime.observe('a',signal());const work=runtime.gesture('a',observation.observation_id,{kind:'pinch',center_x:500,center_y:1000,scale:2,duration_ms:3000},abort.signal),rejected=assert.rejects(work,/cancel test/);while(calls.filter(p=>p.action===0).length<2)await delay(1);abort.abort(new Error('cancel test'));await rejected;assert.deepEqual(calls.slice(-2).map(p=>[p.pointerId,p.action]),[[2n,1],[1n,1]]);const count=calls.length;await delay(50);assert.equal(calls.length,count)}finally{await runtime.close()}
})
test('manual input aborts a running multi-touch gesture before it reaches the manual command',async()=>{
 const{runtime,calls}=await runtimeFixture();try{const{observation}=await runtime.observe('a',signal());const work=runtime.gesture('a',observation.observation_id,{kind:'rotate',center_x:500,center_y:1000,angle_degrees:90,duration_ms:3000},signal()),rejected=assert.rejects(work,/新的输入/);while(calls.filter(p=>p.action===0).length<2)await delay(1);await runtime.manual('viewer',{kind:'key',key:'home'});await rejected;assert.deepEqual(calls.slice(-2).map(p=>[p.pointerId,p.action]),[[2n,1],[1n,1]]);assert.equal(runtime.state.owner,null)}finally{await runtime.close()}
})
