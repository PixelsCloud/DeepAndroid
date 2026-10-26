import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createPanel } from '../dist/host.js'
import { registerAndroidTools } from '../dist/tools.js'
import { pngSize } from '../dist/observation.js'
await mkdir('.build/evidence',{recursive:true});await mkdir('.build/tests',{recursive:true})
const directory=await mkdtemp(join(process.cwd(),'.build/tests/live-management-'));await mkdir(join(directory,'images'))
const images={async saveImage({data}){const attachmentId=randomUUID();await writeFile(join(directory,'images',attachmentId+'.png'),data);return {attachmentId,mediaType:'image/png',bytes:data.length,...pngSize(data)}},async readImage(ref){assert.match(ref.attachmentId,/^[a-f0-9-]{36}$/);return {data:await readFile(join(directory,'images',ref.attachmentId+'.png'))}}}
let panel=await createPanel({dataDir:directory,maxCalls:4,taskTimeoutMs:30000},()=>[],images)
const ctx=new Context();ctx.provide('systemPrompt',{tools(){}});const registry=new ToolRuntime(ctx)
ctx.provide('llm',{async resolveModelInfo(){return {inputModalities:['text','image']}}});ctx.provide('attachments',images);registerAndroidTools(ctx,panel.runtime)
function serve(current){const server=createServer(async(req,res)=>{
  if(req.url?.startsWith('/x-android/'))return current.handler(req,res)
  if(req.url==='/ui.js'){res.setHeader('content-type','text/javascript');res.end(await readFile(new URL('../dist/ui.js',import.meta.url)));return}
  if(req.url==='/favicon.ico'){res.writeHead(204);res.end();return}
  res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#15191e;color:white}#root{height:100vh;max-width:480px;margin:auto}</style><div id="root"></div><script type="module">import{mountPanel}from"/ui.js";window.disposePanel=mountPanel(document.getElementById("root"))</script>')
});return server}
let server=serve(panel);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
let url=`http://127.0.0.1:${server.address().port}`
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true})
const context=await browser.newContext({viewport:{width:480,height:1200},permissions:['clipboard-read','clipboard-write']}),page=await context.newPage()
const errors=[],checks=[],cancelled=[];page.on('pageerror',error=>errors.push(error.message))
const agent=id=>({id,session:{requestContext:()=>({provider:'integration',model:'test-model'})},options:{},cancel(cause){cancelled.push({id,cause})}})
let call=0
async function execute(name,args={},id='management-a'){return registry.execute({callId:`management-${++call}`,name,arguments:args,agent:agent(id),signal:AbortSignal.timeout(65000)})}
async function run(name,args={},id='management-a'){const result=await execute(name,args,id);assert.equal(result.isError,false,JSON.stringify(result));return result.value}
const button=name=>page.getByRole('button',{name,exact:true}),headers={'x-android-client':'1','content-type':'application/json'}
async function frames(){await page.waitForFunction(()=>document.querySelector('.android-video canvas')&&Number(document.querySelector('#root')?.dataset.framesRendered)>0,null,{timeout:25000})}
async function post(path,input){return fetch(url+'/x-android'+path,{method:'POST',headers,body:JSON.stringify(input)})}
try {
  await page.goto(url);await frames()
  const devices=await run('android_devices');assert.equal(devices.task.limits.maxCalls,4)
  await run('android_open_app',{app_name:'设置'})
  await run('android_find',{text:'我的设备',max_attempts:1})
  await run('android_observe')
  const limited=await execute('android_key',{key:'home'});assert.equal(limited.isError,true);assert.equal(cancelled.length,1)
  for(let i=0;i<100&&panel.state.owner;i++)await delay(10)
  assert.equal(panel.state.owner,null);checks.push('real native task stops at the call limit and releases phone ownership')

  await page.getByRole('tab',{name:'调试',exact:true}).click();await button('任务记录').click()
  await page.getByRole('button',{name:/达到限额/}).click()
  await page.locator('.record-detail').getByText('达到限额 · 4/4 次调用',{exact:true}).waitFor()
  await page.getByRole('button',{name:'查看截图',exact:true}).first().click()
  await page.waitForFunction(()=>[...document.querySelectorAll('.record-detail img')].some(image=>image.complete&&image.naturalWidth>0))
  assert(await page.getByRole('button',{name:'后续观察截图',exact:true}).count()>0)
  await page.screenshot({path:'.build/evidence/management-records.png'})
  checks.push('record panel shows the limit reason and actual screenshot evidence')
  ctx.emit('agent/status',{agent:agent('management-a'),status:'idle'})

  await button('常用任务').click();await page.locator('[data-template] option').first().waitFor({state:'attached'})
  await page.locator('[data-template]').selectOption('ranking')
  await page.locator('[data-parameter=count]').fill('20');await button('生成任务').click()
  await page.waitForFunction(()=>document.querySelector('[data-prompt]').value.includes('前 20 条'))
  await button('复制到剪贴板').click();await page.getByText('已复制。到 Harness 聊天粘贴并发送即可执行。',{exact:true}).waitFor()
  assert((await page.evaluate(()=>navigator.clipboard.readText())).includes('前 20 条'))
  await page.getByText('保存自定义模板',{exact:true}).click()
  await page.locator('[data-template-title]').fill('设置关键词读取')
  await page.locator('[data-template-body]').fill('使用 Android 原生工具打开 {{app}}，搜索 {{keyword}}，读取结果后返回桌面。')
  await button('保存模板').click();await page.waitForFunction(()=>document.querySelector('[data-template]').selectedOptions[0]?.textContent==='设置关键词读取')
  await page.locator('[data-parameter=app]').fill('设置');await page.locator('[data-parameter=keyword]').fill('电池')
  await button('生成任务').click();await page.waitForFunction(()=>document.querySelector('[data-prompt]').value.includes('搜索 电池'))
  assert.equal(panel.tasks.summaries().length,1);checks.push('parameterized drafts copy correctly and save without starting another Agent loop')

  await button('连接诊断').click();await page.getByText(/已发现.*台已授权手机/).waitFor()
  await page.getByText('连接与任务设置',{exact:true}).click()
  await page.locator('[data-setting=maxCalls]').fill('6');await page.locator('[data-setting=timeout]').fill('30')
  await button('保存设置').click()
  for(let i=0;i<100&&panel.tasks.limits.maxCalls!==6;i++)await delay(20)
  assert.equal(panel.tasks.limits.maxCalls,6)
  assert.equal((await post('/settings',{adbPath:'C:/invalid/adb.exe',maxCalls:6,taskTimeoutMs:30000})).status,409)
  checks.push('diagnostics detect ADB automatically and connected phone blocks changing its executable')

  await run('android_key',{key:'home'},'management-b')
  const home=await run('android_observe',{},'management-b');assert(home.elements.some(e=>e.package_name==='com.miui.home'))
  await run('android_release',{},'management-b');ctx.emit('agent/status',{agent:agent('management-b'),status:'idle'})
  panel.tasks.limits={maxCalls:100,timeoutMs:200}
  const timeout=await execute('android_observe',{},'management-timeout');assert.equal(timeout.isError,true)
  assert(cancelled.some(entry=>entry.id==='management-timeout'&&entry.cause.reason.includes('时限')))
  ctx.emit('agent/status',{agent:agent('management-timeout'),status:'idle'})
  checks.push('deadline cancels an active real phone observation and retains its stopping reason')
  const summary=panel.tasks.summaries(),sample=panel.tasks.get(summary.find(task=>task.sessionId==='management-a').id)
  await page.evaluate(()=>window.disposePanel());await panel.close();await new Promise(resolve=>server.close(resolve));await ctx.fiber.dispose()

  panel=await createPanel({dataDir:directory},()=>[],images)
  assert.equal(panel.preferences.value.maxCalls,6);assert.equal(panel.tasks.summaries().length,3)
  assert(panel.templates.list().some(template=>template.title==='设置关键词读取'))
  server=serve(panel);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));url=`http://127.0.0.1:${server.address().port}`
  const imageRecord=sample.operations.find(operation=>operation.screenshot)
  const evidence=await fetch(url+'/x-android/evidence/'+imageRecord.id,{headers});assert.equal(evidence.status,200);assert((await evidence.arrayBuffer()).byteLength>100)
  await page.goto(url);await frames();await page.getByRole('tab',{name:'调试',exact:true}).click();await button('任务记录').click();await page.waitForFunction(()=>document.querySelectorAll('.record-list button').length===3)
  checks.push('settings, custom templates, task records and image evidence survive a panel service restart')
  await page.screenshot({path:'.build/evidence/management-restored.png'})
  assert.deepEqual(errors,[])
  await writeFile('.build/evidence/management-smoke.json',JSON.stringify({pass:true,directory,checks,errors,cancelled,taskCount:panel.tasks.summaries().length},null,2))
  console.log(JSON.stringify({pass:true,checks,errors},null,2))
} catch(error) {
  await writeFile('.build/evidence/management-failure.json',JSON.stringify({pass:false,error:String(error),checks,errors,tasks:panel.tasks.summaries()},null,2))
  await page.screenshot({path:'.build/evidence/management-failure.png'}).catch(()=>{});throw error
} finally {await browser.close();await panel.close();await new Promise(resolve=>server.close(resolve));await ctx.fiber.dispose()}
