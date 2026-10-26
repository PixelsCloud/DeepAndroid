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
const directory=await mkdtemp(join(process.cwd(),'.build/tests/live-detail-reading-'));await mkdir(join(directory,'images'))
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
const agent={id:'detail-reading-smoke',session:{requestContext:()=>({provider:'integration',model:'vision-fixture'})},options:{}}
let call=0
async function run(name,args={}){const result=await registry.execute({callId:`navigation-${++call}`,name,arguments:args,agent,signal:AbortSignal.timeout(145000)});results.push({name,args,result});assert.equal(result.isError,false,JSON.stringify(result));console.log(name,result.value.status??'ok',result.value.verification??'',result.value.items?.length??'');return result.value}
const answers=process.argv[2]==='answers'
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.waitForFunction(()=>Number(document.querySelector('#root')?.dataset.framesRendered)>0,null,{timeout:25000})
  assert.equal(await page.locator('.android-task').isVisible(),false)
  await run('android_open_app',{app_name:'知乎'});let current=await run('android_observe')
  for(let back=0;back<2&&!current.elements.some(e=>e.text==='热榜');back++){await run('android_key',{key:'back'});current=await run('android_observe')}
  await run('android_tap_target',{text:'热榜',exact:true,package_name:'com.zhihu.android',max_attempts:1})
  assert.equal((await run('android_wait',{resource_id:'com.zhihu.android:id/metrics_text',package_name:'com.zhihu.android',max_attempts:3})).status,'met')
  const top=await run('android_scroll_find',{text:'知乎日报',exact:true,resource_id:'com.zhihu.android:id/text',package_name:'com.zhihu.android',scroll_resource_id:'',scroll_class_name:'androidx.recyclerview.widget.RecyclerView',direction:'up',max_scrolls:7});assert.equal(top.status,'found')
  const list=await run('android_read_list',{resource_id:'com.zhihu.android:id/title',package_name:'com.zhihu.android',scroll_resource_id:'',scroll_class_name:'androidx.recyclerview.widget.RecyclerView',max_items:3,max_scrolls:0});assert.equal(list.items.length,3)
  const rows=[],reads=[]
  for(const item of list.items){
    const located=await run('android_find',{text:item.title,exact:true,resource_id:'com.zhihu.android:id/title',package_name:'com.zhihu.android',max_attempts:2});assert.equal(located.status,'found')
    const opened=await run('android_tap_target',{text:item.title,exact:true,resource_id:'com.zhihu.android:id/title',package_name:'com.zhihu.android',max_attempts:2});assert.equal(opened.action_sent,true)
    const heading=await run('android_wait',{text:item.title,exact:true,package_name:'com.zhihu.android',max_attempts:3})
    let answerView
    if(answers){
      const answer=await run('android_find',{class_name:'android.widget.TextView',package_name:'com.zhihu.android',max_attempts:2})
      const excerpt=answer.matches.find(element=>element.resource_id.replace(/_/g,'').toLowerCase().endsWith('/tvanswerexcerpt'));assert(excerpt,'First answer excerpt must be exposed before opening it')
      await run('android_tap',{observation_id:answer.observation_id,element_id:excerpt.element_id})
      answerView=await run('android_wait',{resource_id:'com.zhihu.android:id/custom_recycler_view',package_name:'com.zhihu.android',max_attempts:3});assert.equal(answerView.status,'met')
    }
    const reading=await run('android_read_page',{class_name:'android.widget.TextView',package_name:'com.zhihu.android',...(answers?{scroll_class_name:'androidx.recyclerview.widget.RecyclerView',scroll_resource_id:'com.zhihu.android:id/custom_recycler_view'}:{scroll_class_name:'android.webkit.WebView',scroll_resource_id:''}),...((answers?answerView.elements.some(element=>element.text===item.title):heading.status==='met')?{expected_title:item.title}:answers?{}:{mode:'screenshots'}),max_scrolls:3,max_chars:12000})
    console.log('DETAIL',reads.length+1,reading.status,reading.items.length,reading.characters,reading.pages.length)
    assert(reading.items.length>0||reading.reading_mode==='screenshots','An inaccessible text body must fall back to original screenshot collection');assert(reading.saved_result?.id);assert.equal(reading.kind,'page');assert(['from_current_view','screenshots_from_current_view'].includes(reading.coverage))
    const excerpt=reading.items.map(part=>part.texts.join(' ')).filter(text=>text!==item.title).join('\n').slice(0,1000)
    rows.push({cells:[item.title,excerpt||null,reading.reading_mode==='screenshots'?`已采集 ${reading.pages.length} 屏截图，尚未执行文字识别`:`${reading.items.length} 段 / ${reading.characters} 字 / ${reading.pages.length} 屏`,`${reading.reading_mode==='screenshots'?(answers?'本次进入回答正文并采集原始截图，待当前视觉模型阅读与核对；未执行 OCR':'详情标题未能通过界面文字匹配，保留截图待视觉模型核对身份及正文；未执行 OCR'):'从当前详情开始的原始文字片段'}；未声称阅读全文；停止条件：${reading.status}`],observation_ids:reading.pages.map(capture=>capture.observation_id)})
    reads.push({title:item.title,mode:reading.reading_mode??'text',status:reading.status,paragraphs:reading.items.length,characters:reading.characters,pages:reading.pages.length})
    await run('android_key',{key:'back'})
    if(answers){const question=await run('android_observe');assert(question.elements.some(element=>element.package_name==='com.zhihu.android'));await run('android_key',{key:'back'})}
    const restored=await run('android_find',{text:item.title,exact:true,resource_id:'com.zhihu.android:id/title',package_name:'com.zhihu.android',max_attempts:3});assert.equal(restored.status,'found','Back must restore the list and freshly locate the original title')
  }
  const reportTitle=answers?'知乎热榜前 3 条回答截图（真机验收）':'知乎热榜前 3 条详情阅读（真机验收）'
  const saved=await run('android_save_result',{title:reportTitle,status:'partial',expected_count:3,reason:'本验收未调用模型，保存的是实际暴露的文字片段或原始截图及范围；达到范围上限或连续性不足时明确停止，不将摘录当作全文或模型摘要。',columns:['标题','正文摘录','已读范围','未完成说明'],rows})
  assert.equal(saved.result_status,'partial');await run('android_key',{key:'home'});const home=await run('android_observe');assert(home.elements.some(element=>element.package_name==='com.miui.home'));await run('android_release');ctx.emit('agent/status',{agent,status:'idle'});await panel.tasks.flush()
  await page.getByRole('tab',{name:'任务',exact:true}).click();await page.locator('.task-reports button').filter({hasText:'整理结果'}).first().click();await page.getByRole('heading',{name:reportTitle,exact:true}).waitFor();assert.equal(await page.locator('.result-table tbody tr').count(),3)
  await page.getByRole('button',{name:'截图 1',exact:true}).first().click();await page.waitForFunction(()=>document.querySelector('.result-evidence img')?.naturalWidth>0);await page.screenshot({path:'.build/evidence/detail-reading-evidence.png'});await page.getByRole('button',{name:'关闭截图',exact:true}).click()
  await page.setViewportSize({width:860,height:1100});await page.screenshot({path:'.build/evidence/detail-reading-results.png'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  assert.equal(panel.results.taskResults(saved.task_id??panel.tasks.summaries()[0].id).length,5)
  assert.deepEqual(errors,[]);await writeFile(answers?'.build/evidence/answer-reading-smoke.json':'.build/evidence/detail-reading-smoke.json',JSON.stringify({pass:true,answers,directory,reads,resultId:saved.result_id,scope:'Real USB + actual native Harness ToolRuntime + Results/evidence UI; exposed text fragments or original screenshots only, no OCR or model summaries or desktop chat',errors,results},null,2));console.log('PASS 3 list titles → fresh detail entry/read → Back and re-find each title → combined sourced report → Home')
} catch(error){await writeFile('.build/evidence/detail-reading-failure.json',JSON.stringify({pass:false,error:String(error),directory,results},null,2));throw error}
finally {await browser.close();await panel.close();await new Promise(resolve=>server.close(resolve));await ctx.fiber.dispose()}
