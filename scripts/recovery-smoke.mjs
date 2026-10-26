import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createPanel } from '../dist/host.js'
import { registerAndroidTools } from '../dist/tools.js'

// Real USB phone, real native tool registry, and the shipped panel UI share one runtime.
// Closing only this test's video transport simulates loss without resetting shared ADB or USB.
await mkdir('.build/evidence',{recursive:true})
const panel=await createPanel({adbPath:'D:/android/sdk/platform-tools/adb.exe'})
let video, opens=0
const open=panel.service.open.bind(panel.service)
panel.service.open=async(...args)=>{video=await open(...args);opens++;return video}
const ctx=new Context();ctx.provide('systemPrompt',{tools(){}});const registry=new ToolRuntime(ctx)
ctx.provide('llm',{async resolveModelInfo(){return {inputModalities:['text']}}})
let image=0
ctx.provide('attachments',{async saveImage({data}){return {attachmentId:`recovery-${++image}`,mediaType:'image/png',width:1080,height:2400,bytes:data.length}}})
registerAndroidTools(ctx,panel.runtime)
const server=createServer(async(req,res)=>{
  if(req.url?.startsWith('/x-android/'))return panel.handler(req,res)
  if(req.url==='/ui.js'){res.setHeader('content-type','text/javascript');res.end(await readFile(new URL('../dist/ui.js',import.meta.url)));return}
  if(req.url==='/favicon.ico'){res.writeHead(204);res.end();return}
  res.setHeader('content-type','text/html; charset=utf-8')
  res.end('<!doctype html><html><meta charset="utf-8"><style>body{margin:0;background:#15191e;color:white}#root{height:100vh;max-width:480px;margin:auto}</style><div id="root"></div><script type="module">import{mountPanel}from"/ui.js";window.disposePanel=mountPanel(document.getElementById("root"))</script></html>')
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const url=`http://127.0.0.1:${server.address().port}`
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true})
const page=await browser.newPage({viewport:{width:480,height:1080}}),results=[],checks=[],errors=[]
page.on('pageerror',error=>errors.push(error.message))
let call=0
const agent=id=>({id,session:{requestContext:()=>({provider:'test',model:'no-model'})},options:{}})
async function execute(name,args={},id='recovery-a',signal=AbortSignal.timeout(30000)) {
  const result=await registry.execute({callId:`recovery-${++call}`,name,arguments:args,agent:agent(id),signal})
  results.push({name,args,session:id,isError:result.isError,content:result.isError?result.content:undefined})
  return result
}
async function run(name,args={},id='recovery-a') {const r=await execute(name,args,id);assert.equal(r.isError,false,JSON.stringify(r));return r.value}
async function active(){for(let i=0;i<100&&!panel.state.owner;i++)await delay(10);assert(panel.state.owner)}
async function frames(){await page.waitForFunction(()=>document.querySelector('.android-video canvas')&&Number(document.querySelector('#root')?.dataset.framesRendered)>0,null,{timeout:25000})}
const button=name=>page.getByRole('button',{name,exact:true})
async function target(){
  await run('android_open_app',{package_name:'com.android.settings'});await delay(500)
  const o=await run('android_observe'),element=o.elements.find(e=>e.text==='设置')
  assert(element,'Observed Settings label is required as a harmless gesture target')
  return {observation_id:o.observation_id,element_id:element.element_id,duration_ms:3000}
}
try {
  await page.goto(url);await frames();assert.equal(await button('人工接管').count(),0);assert.equal(await button('允许 Agent').count(),0);assert.equal(opens,1);checks.push('video connected')
  const press=await target()
  const action=execute('android_tap',press)
  await active();await delay(80);await button('主页').click()
  assert.equal((await action).isError,true)
  await run('android_key',{key:'home'},'recovery-b')
  checks.push('panel Home interrupts active native gesture; another conversation immediately operates without permission')
  assert.equal((await execute('android_tap',press)).isError,true)
  checks.push('manual input invalidates prior observation without a persistent control gate')

  const cancelled=await target(),abort=new AbortController()
  const holding=execute('android_tap',cancelled,'recovery-a',abort.signal)
  await delay(80);abort.abort();assert.equal((await holding).isError,true)
  assert.equal(panel.state.owner,null)
  await run('android_observe',{},'recovery-b')
  checks.push('cancel releases the real gesture and permits another conversation')

  ctx.emit('agent/status',{agent:agent('recovery-b'),status:'idle'})
  assert.equal(panel.state.owner,null)
  await run('android_observe')
  ctx.emit('agent/disposed',{agent:agent('recovery-a')})
  assert.equal((await panel.runtime.list('recovery-a')).binding,null)
  checks.push('Harness lifecycle cleans up only its session and disposed binding')

  const before=opens
  await page.evaluate(()=>window.disposePanel())
  for(let i=0;i<100&&panel.state.state!=='streaming';i++)await delay(10)
  assert.equal(panel.state.state,'streaming')
  await page.evaluate(async()=>{const {mountPanel}=await import('/ui.js');window.disposePanel=mountPanel(document.getElementById('root'))})
  await frames();assert.equal(opens,before)
  checks.push('closing and reopening the panel reuses the same live device connection')

  await video.close()
  await page.getByRole('alert').waitFor({state:'visible'})
  assert.equal(panel.state.state,'error')
  await button('断开').click();await page.getByRole('status').filter({hasText:'已断开'}).waitFor()
  await button('连接手机').click();await frames()
  await run('android_observe')
  checks.push('simulated transport loss and reconnect require no permission switch')

  await button('断开').click();await page.getByRole('status').filter({hasText:'已断开'}).waitFor()
  const disconnectedOpens=opens
  await run('android_observe');assert.equal(opens,disconnectedOpens+1);assert.equal(panel.state.state,'streaming')
  await button('连接手机').click();await frames()
  await run('android_key',{key:'home'});await delay(500)
  const home=await run('android_observe');assert(home.elements.some(e=>e.package_name==='com.miui.home'))
  await run('android_release')
  checks.push('native operation reconnects directly after disconnect; phone restored to Home')
  assert.deepEqual(errors,[])
  await page.screenshot({path:'.build/evidence/recovery-panel.png'})
  await writeFile('.build/evidence/recovery-smoke.json',JSON.stringify({pass:true,kind:'real USB + Harness ToolRuntime + actual panel buttons; simulated connection loss, not physical unplug',checks,opens,errors,results},null,2))
  console.log(JSON.stringify({pass:true,checks,opens,errors},null,2))
} catch(error) {
  await writeFile('.build/evidence/recovery-failure.json',JSON.stringify({pass:false,error:String(error),checks,opens,state:panel.state,errors},null,2))
  await page.screenshot({path:'.build/evidence/recovery-failure.png'}).catch(()=>{})
  throw error
} finally {await browser.close();await panel.close();await ctx.fiber.dispose();await new Promise(resolve=>server.close(resolve))}
