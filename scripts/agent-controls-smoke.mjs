import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {setTimeout as delay} from 'node:timers/promises'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {apply} from '../dist/agent.js'
import {DeviceService} from '../dist/device.js'
import {pngSize} from '../dist/observation.js'

await mkdir('.build/tests',{recursive:true});await mkdir('.build/evidence',{recursive:true})
const directory=await mkdtemp(join(process.cwd(),'.build/tests/agent-controls-')),ctx=new Context(),serial='e2b3b128',fixturePath='/fixture/'+randomUUID(),html=await readFile('tests/android-gesture-fixture.html'),device=new DeviceService(),run=promisify(execFile)
let provider;ctx.provide('systemPrompt',{tools(value){provider=value}});const registry=new ToolRuntime(ctx)
ctx.provide('attachments',{async saveImage({data}){const attachmentId=randomUUID();await writeFile(join(directory,attachmentId+'.png'),data);return{attachmentId,mediaType:'image/png',bytes:data.length,...pngSize(data)}},async readImage(ref){return{data:await readFile(join(directory,ref.attachmentId+'.png'))}}})
ctx.provide('llm',{async resolveModelInfo(){return{inputModalities:['text','image']}}})
const agent={id:'controls-acceptance',options:{},cancel(){},session:{requestContext:()=>({provider:'fixture',model:'vision'})}},steps=[],checks=[];let n=0,phoneState=null,fixtureQuery=null,reverse=false,browserPackage='com.android.chrome',rotationRestore
const server=createServer(async(req,res)=>{const url=new URL(req.url??'/','http://localhost');if(url.pathname===fixturePath+'/events'&&req.method==='POST'){let body='';for await(const chunk of req){body+=chunk;if(body.length>65536){res.writeHead(413);res.end();return}}phoneState=JSON.parse(body);res.writeHead(204);res.end();return}if(url.pathname===fixturePath){fixtureQuery=url.search;res.writeHead(200,{'content-type':'text/html;charset=utf-8','cache-control':'no-store'});res.end(html);return}res.writeHead(404);res.end()})
const sockets=new Set();server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket))})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port
const adb=async(...args)=>(await run((await device.adbInfo()).path,['-s',serial,...args],{windowsHide:true,timeout:15000,maxBuffer:4*1024**2})).stdout
async function call(name,args={},signal=AbortSignal.timeout(90000)){const result=await registry.execute({name,arguments:args,callId:'controls-'+ ++n,agent,signal});steps.push({tool:name,status:result.value?.status,isError:result.isError});assert.equal(result.isError,false,name+': '+JSON.stringify(result));return result.value}
async function wait(test,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){if(await test())return;await delay(50)}throw new Error('验收条件未满足：'+test.toString())}
async function fixtureRect(kind){const observed=await call('android_find',{class_name:'android.webkit.WebView',max_attempts:1});await writeFile(join(directory,'webview-observation.json'),JSON.stringify(observed,null,2));assert.equal(observed.matches.length,1,JSON.stringify(observed.matches));const[left,top,right]=observed.matches[0].bounds,scale=(right-left)/phoneState.viewport.width,rect=phoneState[kind];return{observation_id:observed.observation_id,center_x:left+(rect.left+rect.width/2)*scale,center_y:top+(rect.top+rect.height/2)*scale,radius_px:Math.min(rect.width,rect.height)*scale*0.14}}
async function zone(){return fixtureRect('zone')}
async function gesture(options){const target=await zone(),before=phoneState.completed_count;const sent=await call('android_gesture',{...target,...options});assert.equal(sent.status,'sent');await wait(()=>phoneState.contacts===0&&phoneState.completed_count>before);return structuredClone(phoneState.last_completed)}
try{
 await apply(ctx,{dataDir:directory});assert.equal(provider({scope:agent}).schemas.length,44)
 await call('android_bind',{serial});const initial=await call('android_device_state');assert.equal(initial.screen.keyguard_showing,false);assert.equal(initial.keyboard.shown,false);assert(initial.foreground?.package_name)
 const settings=await call('android_app_info',{package_name:'com.android.settings'});assert.equal(settings.status,'installed');assert.equal(typeof settings.version_code,'string');assert.equal((await call('android_app_info',{package_name:'com.pixelsandroid.absent130'})).status,'not_installed')
 const details=await call('android_open_uri',{uri:'package:com.android.settings'});assert.equal(details.status,'sent');assert.equal((await call('android_device_state')).foreground.package_name,details.activity.split('/')[0]);await call('android_key',{key:'home'})
 const stop=await call('android_stop_app',{package_name:'com.android.settings'});assert.equal(stop.status,'stopped',JSON.stringify(stop));assert.equal((await call('android_stop_app',{package_name:'com.android.settings'})).already_stopped,true);await call('android_open_app',{package_name:'com.android.settings'});assert.equal((await call('android_app_info',{package_name:'com.android.settings'})).stopped,false);await call('android_key',{key:'home'});checks.push({test:'native state/app metadata → app-details URI → confirmed stop → idempotent stop → restart confirmed',pass:true,initial,settings,stop})
 await adb('reverse','--no-rebind',`tcp:${port}`,`tcp:${port}`);reverse=true
 const url=`http://127.0.0.1:${port}${fixturePath}?literal=a'b$&marker=one;two`,opened=await call('android_open_uri',{uri:url,package_name:browserPackage});assert.equal(opened.status,'sent',JSON.stringify(opened))
 await wait(()=>phoneState?.ready,15000);assert.equal(new URLSearchParams(fixtureQuery).get('literal'),"a'b$");assert.equal(new URLSearchParams(fixtureQuery).get('marker'),'one;two');assert.equal((await call('android_device_state')).foreground.package_name,browserPackage)
 const input=await fixtureRect('input');await call('android_tap',{observation_id:input.observation_id,x:input.center_x,y:input.center_y});await wait(async()=>(await call('android_device_state')).keyboard.shown===true);await call('android_key',{key:'back'});await wait(async()=>(await call('android_device_state')).keyboard.shown===false)
 const pinch=await gesture({kind:'pinch',scale:1.6,duration_ms:600});assert.equal(pinch.max_contacts,2);assert(Math.abs(pinch.scale-1.6)<0.05,JSON.stringify(pinch))
 const rotate=await gesture({kind:'rotate',angle_degrees:45,duration_ms:600});assert.equal(rotate.max_contacts,2);assert(Math.abs(rotate.angle-45)<3,JSON.stringify(rotate))
 const swipe=await gesture({kind:'two_finger_swipe',dx:0,dy:-100,duration_ms:600});assert.equal(swipe.max_contacts,2);assert(swipe.dy< -15,JSON.stringify(swipe))
 const target=await zone(),count=phoneState.completed_count;const double=await call('android_gesture',{observation_id:target.observation_id,kind:'double_tap',x:target.center_x,y:target.center_y,gap_ms:120});assert.equal(double.status,'sent');await wait(()=>phoneState.contacts===0&&phoneState.completed_count>=count+2)
 const stale=await registry.execute({name:'android_gesture',arguments:{observation_id:target.observation_id,kind:'double_tap',x:target.center_x,y:target.center_y},callId:'stale-'+ ++n,agent,signal:AbortSignal.timeout(10000)});assert.equal(stale.isError,true)
 const cancelTarget=await zone(),cancel=new AbortController(),before=phoneState.completed_count,cancelled=registry.execute({name:'android_gesture',arguments:{...cancelTarget,kind:'rotate',angle_degrees:90,duration_ms:3000},callId:'cancel-'+ ++n,agent,signal:cancel.signal});await wait(()=>phoneState.contacts===2);cancel.abort(new Error('user cancellation acceptance'));const stopped=await cancelled;assert.equal(stopped.isError,true);await wait(()=>phoneState.contacts===0&&phoneState.completed_count>before)
 const cancelledSession=structuredClone(phoneState.last_completed)
 const rotationBefore=await call('android_device_state'),rotationTarget=await zone(),rotationWork=registry.execute({name:'android_gesture',arguments:{...rotationTarget,kind:'rotate',angle_degrees:90,duration_ms:3000},callId:'rotation-'+ ++n,agent,signal:AbortSignal.timeout(15000)})
 await wait(()=>phoneState.contacts===2);rotationRestore=(await adb('shell','wm','user-rotation')).trim();assert(/^(free|lock [0-3])$/.test(rotationRestore));await adb('shell','wm','user-rotation','lock',rotationBefore.screen.rotation%2?'0':'1')
 const interrupted=await rotationWork;assert.equal(interrupted.isError,true);await wait(()=>phoneState.contacts===0);const rotated=await call('android_device_state');assert.notEqual(rotated.screen.orientation,rotationBefore.screen.orientation)
 await adb('shell','wm','user-rotation',...rotationRestore.split(' '));rotationRestore=undefined;await wait(async()=>(await call('android_device_state')).screen.rotation===rotationBefore.screen.rotation);await delay(400)
 const recovered=await gesture({kind:'pinch',scale:1.3,duration_ms:400});assert.equal(recovered.max_contacts,2);assert(Math.abs(recovered.scale-1.3)<0.06);checks.push({test:'real display rotation interrupts both contacts, restores original user-rotation policy, and a fresh two-finger gesture still works',pass:true,rotated,recovered})
 const unhandled=await call('android_open_uri',{uri:'dsh-unhandled130://missing',package_name:'com.android.settings'});assert.equal(unhandled.status,'failed');checks.push({test:'Android browser receives literal URI, keyboard state, two distinct contacts and verified gesture effects; cancellation releases both; stale observation and no-handler link rejected',pass:true,pinch,rotate,swipe,cancelled:cancelledSession,unhandled})
 await call('android_key',{key:'home'});const final=await call('android_device_state');assert.equal(final.foreground.package_name,'com.miui.home');await call('android_release')
 await writeFile('.build/evidence/agent-controls-smoke.json',JSON.stringify({pass:true,directory,steps,checks,final,scope:'Actual USB and headless Harness agent entry/ToolRuntime. Phone-local fixture receives real Android touch events over one owned temporary adb reverse rule. No desktop panel/browser, no APK installation, no chat or model invocation.'},null,2));console.log('PASS 32 model-visible native tools: state, app info, URI, confirmed/idempotent stop, actual two-finger zoom/rotation/swipe, double tap, cancellation and return Home')
}catch(error){await writeFile('.build/evidence/agent-controls-failure.json',JSON.stringify({error:String(error),directory,steps,checks,phoneState},null,2));throw error}
finally{if(rotationRestore)await adb('shell','wm','user-rotation',...rotationRestore.split(' ')).catch(()=>{});await call('android_key',{key:'home'}).catch(()=>{});await ctx.fiber.dispose();if(reverse)await adb('reverse','--remove',`tcp:${port}`).catch(()=>{});await new Promise(resolve=>{server.close(resolve);for(const socket of sockets)socket.destroy()})}
