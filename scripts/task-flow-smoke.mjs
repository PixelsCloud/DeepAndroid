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
const directory=await mkdtemp(join(process.cwd(),'.build/tests/live-task-flow-'));await mkdir(join(directory,'images'))
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
const page=await browser.newPage({viewport:{width:480,height:1200},permissions:['clipboard-read','clipboard-write']}),errors=[],results=[];page.on('pageerror',e=>errors.push(e.message))
const agent={id:'task-flow-smoke',session:{requestContext:()=>({provider:'integration',model:'vision-fixture'})},options:{},cancel(){cancelCalls++}}
let cancelCalls=0,call=0
async function run(name,args={}){const result=await registry.execute({callId:`navigation-${++call}`,name,arguments:args,agent,signal:AbortSignal.timeout(145000)});results.push({name,args,result});assert.equal(result.isError,false,JSON.stringify(result));console.log(name,result.value.status??'ok',result.value.verification??'',result.value.items?.length??'');return result.value}
const zhihu=process.argv[2]==='zhihu',appName=zhihu?'知乎':'设置'
const readArgs=zhihu?{resource_id:'com.zhihu.android:id/title',package_name:'com.zhihu.android',scroll_resource_id:'',scroll_class_name:'androidx.recyclerview.widget.RecyclerView',max_items:20,max_scrolls:7}:{resource_id:'android:id/title',package_name:'com.android.settings',max_items:20,max_scrolls:7}
async function top(){return run('android_scroll_find',zhihu?{text:'知乎日报',exact:true,resource_id:'com.zhihu.android:id/text',package_name:'com.zhihu.android',scroll_resource_id:'',scroll_class_name:'androidx.recyclerview.widget.RecyclerView',direction:'up',max_scrolls:7}:{text:'我的设备',exact:true,package_name:'com.android.settings',direction:'up',scroll_resource_id:'com.android.settings:id/scroll_headers',max_scrolls:7})}
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.waitForFunction(()=>Number(document.querySelector('#root')?.dataset.framesRendered)>0,null,{timeout:25000})
  const connectedAt=panel.state.connectedAt
  await run('android_open_app',{app_name:appName})
  let observation=await run('android_observe')
  if(zhihu){for(let n=0;n<2&&!observation.elements.some(e=>e.text==='热榜');n++){await run('android_key',{key:'back'});observation=await run('android_observe')}await run('android_tap_target',{text:'热榜',exact:true,package_name:'com.zhihu.android',max_attempts:1});await run('android_wait',{resource_id:'com.zhihu.android:id/metrics_text',package_name:'com.zhihu.android',max_attempts:3})}else if(observation.elements.some(e=>e.editable&&e.focused))await run('android_key',{key:'back'})
  await top()
  const active=registry.execute({callId:'task-stop-read',name:'android_read_list',arguments:{...readArgs,interval_ms:1500},agent,signal:AbortSignal.timeout(145000)})
  await page.getByRole('tab',{name:'任务',exact:true}).click()
  await page.locator('[data-task-progress]').filter({hasText:/已读 [1-9]/}).waitFor({timeout:25000})
  await page.screenshot({path:'.build/evidence/tasks-running.png'})
  await page.getByRole('button',{name:'停止任务',exact:true}).click()
  const stopped=await active;assert.equal(stopped.isError,true);assert.equal(cancelCalls,1)
  const taskId=panel.tasks.status(agent.id).id
  assert.equal(panel.state.state,'streaming');assert.equal(panel.state.connectedAt,connectedAt)
  ctx.emit('agent/status',{agent,status:'idle'});await panel.tasks.flush()
  await page.locator('[data-task-status]').filter({hasText:'已停止'}).waitFor()
  const partial=panel.results.taskResults(taskId)[0];assert(partial);assert(partial.row_count>0&&partial.row_count<20);assert.equal(partial.status,'partial')
  await page.getByRole('button',{name:'查看最近截图',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[aria-label="任务截图"] img')?.naturalWidth>0);await page.getByRole('button',{name:'关闭任务截图',exact:true}).click()
  await page.getByRole('button',{name:'生成继续草稿',exact:true}).click();await page.getByRole('dialog',{name:'继续任务草稿',exact:true}).waitFor()
  const draft=await page.getByRole('textbox',{name:'继续任务草稿内容',exact:true}).inputValue();assert(draft.includes('先调用原生工具重新观察'));assert(draft.includes(appName));assert(draft.includes(taskId));await page.getByRole('button',{name:'复制草稿',exact:true}).click();await page.getByText('已复制。请在原对话检查后发送。',{exact:true}).waitFor();assert.equal((await page.evaluate(()=>navigator.clipboard.readText())).replace(/\r\n/g,'\n'),draft)
  await page.screenshot({path:'.build/evidence/tasks-continuation.png'});await page.getByRole('button',{name:'关闭草稿',exact:true}).click()
  await page.locator('.task-reports button').first().click();await page.getByRole('heading',{name:'列表读取（中断保留）',exact:true}).waitFor();assert.equal(await page.locator('.result-table tbody tr').count(),partial.row_count)
  for(const size of [{width:360,height:820},{width:860,height:1000}]){await page.setViewportSize(size);await page.screenshot({path:`.build/evidence/tasks-stopped-${size.width}.png`});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)}
  await page.getByRole('tab',{name:'手机',exact:true}).click()
  // Continue through the same native registry as a new round. No model/chat message is sent by this test.
  await run('android_observe');await top()
  const completed=await run('android_read_list',readArgs);assert.equal(completed.items.length,20)
  const saved=await run('android_save_result',{title:`任务恢复验收：${appName} 20 项`,status:'complete',columns:['标题'],expected_count:20,rows:completed.items.map(item=>({cells:[item.title],observation_ids:item.pages.map(number=>completed.pages[number-1].observation_id)}))});assert.equal(saved.result_status,'complete')
  await run('android_key',{key:'home'});await run('android_release');ctx.emit('agent/status',{agent,status:'idle'})
  // Explicit history selection stays selected when the newest task arrives.
  await page.getByRole('tab',{name:'任务',exact:true}).click();await page.getByRole('combobox',{name:'最近手机任务',exact:true}).selectOption(taskId);await page.locator('[data-task-status]').filter({hasText:'已停止'}).waitFor();await page.waitForTimeout(1200);assert.equal(await page.getByRole('combobox',{name:'最近手机任务',exact:true}).inputValue(),taskId)
  assert.deepEqual(errors,[]);await writeFile(zhihu?'.build/evidence/task-flow-zhihu-smoke.json':'.build/evidence/task-flow-smoke.json',JSON.stringify({pass:true,appName,directory,taskId,partialRows:partial.row_count,completeRows:completed.items.length,cancelCalls,videoPreserved:true,errors,scope:'Real USB + actual Harness native ToolRuntime + panel Stop/copy/result/evidence; simulated Agent cancellation callback, no model invocation or chat send',results},null,2));console.log('PASS live progress → panel Stop → partial rows/evidence retained → copy continuation draft → open exact result → new native round completes 20 rows → Home')
} catch(error){await writeFile('.build/evidence/task-flow-failure.json',JSON.stringify({pass:false,error:String(error),directory,results},null,2));throw error}
finally {await browser.close();await panel.close();await new Promise(resolve=>server.close(resolve));await ctx.fiber.dispose()}
