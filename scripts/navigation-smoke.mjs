import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createPanel } from '../dist/host.js'
import { registerAndroidTools } from '../dist/tools.js'
import { pngSize } from '../dist/observation.js'
await mkdir('.build/evidence',{recursive:true});await mkdir('.build/tests',{recursive:true})
const directory=await mkdtemp(join(process.cwd(),'.build/tests/live-navigation-'));await mkdir(join(directory,'images'))
const images={async saveImage({data}){const attachmentId=randomUUID();await writeFile(join(directory,'images',attachmentId+'.png'),data);return{attachmentId,mediaType:'image/png',bytes:data.length,...pngSize(data)}},async readImage(ref){assert.match(ref.attachmentId,/^[a-f0-9-]{36}$/);return{data:await readFile(join(directory,'images',ref.attachmentId+'.png'))}}}
const panel=await createPanel({dataDir:directory},()=>registry.schemas().map(t=>t.name),images)
const ctx=new Context();ctx.provide('systemPrompt',{tools(){}});const registry=new ToolRuntime(ctx)
ctx.provide('llm',{async resolveModelInfo(){return{inputModalities:['text','image']}}});ctx.provide('attachments',images);registerAndroidTools(ctx,panel.runtime)
const server=createServer(async(req,res)=>{
  if(req.url?.startsWith('/x-android/'))return panel.handler(req,res)
  if(req.url==='/favicon.ico'){res.writeHead(204);res.end();return}
  res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#15191e;color:white}#root{height:100vh;max-width:480px;margin:auto}</style><div id="root"></div><script type="module">import{mountPanel}from"/x-android/ui.js";window.disposePanel=mountPanel(document.getElementById("root"))</script>')
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true})
const page=await browser.newPage({viewport:{width:480,height:1200}}),errors=[],results=[];page.on('pageerror',e=>errors.push(e.message))
const agent={id:'navigation-smoke',session:{requestContext:()=>({provider:'integration',model:'vision-fixture'})},options:{}}
let call=0
async function run(name,args={}){const result=await registry.execute({callId:`navigation-${++call}`,name,arguments:args,agent,signal:AbortSignal.timeout(145000)});results.push({name,args,result});assert.equal(result.isError,false,JSON.stringify(result));console.log(name,result.value.status??'ok',result.value.verification??'',result.value.items?.length??'');return result.value}
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.waitForFunction(()=>Number(document.querySelector('#root')?.dataset.framesRendered)>0,null,{timeout:25000})
  await run('android_open_app',{package_name:'com.android.settings'})
  const start=await run('android_scroll_find',{text:'我的设备',exact:true,package_name:'com.android.settings',direction:'up',scroll_resource_id:'com.android.settings:id/scroll_headers',max_scrolls:7});assert.equal(start.status,'found')
  const ready=await run('android_wait',{text:'我的设备',exact:true,max_attempts:3});assert.equal(ready.status,'met')
  const tapped=await run('android_tap_target',{text:'我的设备',exact:true,max_attempts:2});assert.equal(tapped.action_sent,true);assert.equal(tapped.verification.status,'changed')
  await run('android_key',{key:'back'});const returned=await run('android_wait',{text:'我的设备',exact:true});assert.equal(returned.status,'met')
  const read=await run('android_read_list',{resource_id:'android:id/title',package_name:'com.android.settings',max_items:20,max_scrolls:7})
  assert.equal(read.status,'limit_reached');assert.equal(read.items.length,20);assert.equal(new Set(read.items.map(i=>i.title)).size,20);assert(read.scrolls>0);assert(read.pages.length>1)
  const found=await run('android_scroll_find',{text:'我的设备',exact:true,direction:'up',package_name:'com.android.settings',max_scrolls:7});assert.equal(found.status,'found')
  const same=await run('android_wait',{condition:'stable',max_attempts:3,interval_ms:100});assert.equal(same.status,'met')
  const missing=await run('android_scroll_find',{text:'__not_a_real_row__',exact:true,package_name:'com.android.settings',max_scrolls:7});assert(['unchanged','scroll_limit'].includes(missing.status));assert(missing.scrolls<=7)
  await run('android_key',{key:'home'});await run('android_release');ctx.emit('agent/status',{agent,status:'idle'})
  await panel.tasks.flush()
  const task=panel.tasks.get(panel.tasks.summaries()[0].id),operation=task.operations.find(op=>op.tool==='android_read_list')
  assert.equal(operation.summary.itemCount,20);assert.equal(operation.pages.length,read.pages.length)
  await page.getByRole('tab',{name:'调试',exact:true}).click();await page.getByRole('button',{name:'任务记录',exact:true}).click();await page.locator('.record-list button').first().click()
  const readRow=page.locator('.record-step').filter({has:page.getByText(/^跨屏读取 ·/)});await readRow.getByRole('button',{name:'第 2 屏依据',exact:true}).click()
  await page.waitForFunction(()=>[...document.querySelectorAll('.record-detail img')].some(i=>i.complete&&i.naturalWidth>0))
  await page.screenshot({path:'.build/evidence/navigation-records.png'})
  assert.deepEqual(errors,[])
  await writeFile('.build/evidence/navigation-smoke.json',JSON.stringify({pass:true,kind:'real USB phone + native Harness ToolRuntime + actual records UI; no model invocation',directory,itemTitles:read.items.map(i=>i.title),readScrolls:read.scrolls,readPages:read.pages.length,found:found.matches.map(i=>i.text),missingStatus:missing.status,errors,results},null,2))
  console.log('PASS fresh tap verification → 20 deduplicated rows → cross-screen target → bounded missing target → page evidence in UI → Home')
} catch(error){await writeFile('.build/evidence/navigation-failure.json',JSON.stringify({pass:false,error:String(error),directory,results},null,2));throw error}
finally {await browser.close();await panel.close();await new Promise(resolve=>server.close(resolve));await ctx.fiber.dispose()}
