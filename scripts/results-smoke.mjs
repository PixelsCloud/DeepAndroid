import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {randomUUID} from 'node:crypto'
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {chromium} from 'playwright-core'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {createPanel} from '../dist/host.js'
import {registerAndroidTools} from '../dist/tools.js'
import {pngSize} from '../dist/observation.js'
await mkdir('.build/evidence',{recursive:true});await mkdir('.build/tests',{recursive:true})
const directory=await mkdtemp(join(process.cwd(),'.build/tests/live-results-'));await mkdir(join(directory,'images'))
const images={async saveImage({data}){const attachmentId=randomUUID();await writeFile(join(directory,'images',attachmentId+'.png'),data);return{attachmentId,mediaType:'image/png',bytes:data.length,...pngSize(data)}},async readImage(ref){assert.match(ref.attachmentId,/^[a-f0-9-]{36}$/);return{data:await readFile(join(directory,'images',ref.attachmentId+'.png'))}}}
let panel=await createPanel({dataDir:directory},()=>registry.schemas().map(t=>t.name),images)
const ctx=new Context();ctx.provide('systemPrompt',{tools(){}});const registry=new ToolRuntime(ctx);ctx.provide('attachments',images);ctx.provide('llm',{async resolveModelInfo(){return{inputModalities:['text','image']}}});registerAndroidTools(ctx,panel.runtime)
function serve(current){return createServer(async(req,res)=>{
 if(req.url?.startsWith('/x-android/'))return current.handler(req,res)
 if(req.url==='/favicon.ico'){res.writeHead(204);res.end();return}
 res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#15191e;color:#e4e8eb}#root{height:100%}</style><div id="root"></div><script type="module">import{mountPanel}from"/x-android/ui.js";window.disposePanel=mountPanel(document.getElementById("root"))</script>')
})}
let server=serve(panel);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true}),context=await browser.newContext({viewport:{width:860,height:1000},permissions:['clipboard-read','clipboard-write'],acceptDownloads:true}),page=await context.newPage(),errors=[],results=[]
page.on('pageerror',error=>errors.push(error.message))
const agent={id:'results-smoke',session:{requestContext:()=>({provider:'integration',model:'vision-fixture'})},options:{}}
let call=0
async function run(name,args={}){const result=await registry.execute({callId:`results-${++call}`,name,arguments:args,agent,signal:AbortSignal.timeout(145000)});results.push({name,args,result});assert.equal(result.isError,false,JSON.stringify(result));console.log(name,result.value.status??'ok',result.value.items?.length??'');return result.value}
async function frames(){await page.waitForFunction(()=>Number(document.querySelector('#root')?.dataset.framesRendered)>0,null,{timeout:25000})}
const origin=()=>`http://127.0.0.1:${server.address().port}`
try{
 await page.goto(origin());await frames();await page.getByRole('tab',{name:'结果',exact:true}).click();await page.getByText('暂无结果。让 Agent 读取内容并保存结果后，会显示在这里。',{exact:true}).waitFor();await page.getByRole('tab',{name:'手机',exact:true}).click()
 await run('android_open_app',{app_name:'知乎'});let current=await run('android_observe')
 for(let back=0;back<2&&!current.elements.some(e=>e.text==='热榜');back++){await run('android_key',{key:'back'});current=await run('android_observe')}
 assert(current.elements.some(e=>e.text==='热榜'));await run('android_tap_target',{text:'热榜',exact:true,package_name:'com.zhihu.android',max_attempts:1})
 assert.equal((await run('android_wait',{resource_id:'com.zhihu.android:id/metrics_text',package_name:'com.zhihu.android',max_attempts:3})).status,'met')
 assert.equal((await run('android_scroll_find',{text:'知乎日报',exact:true,resource_id:'com.zhihu.android:id/text',package_name:'com.zhihu.android',scroll_resource_id:'',scroll_class_name:'androidx.recyclerview.widget.RecyclerView',direction:'up',max_scrolls:7})).status,'found')
 const list=await run('android_read_list',{resource_id:'com.zhihu.android:id/title',package_name:'com.zhihu.android',scroll_resource_id:'',scroll_class_name:'androidx.recyclerview.widget.RecyclerView',max_items:20,max_scrolls:7});assert.equal(list.status,'limit_reached');assert.equal(list.items.length,20);assert(list.saved_result?.id);assert.equal(panel.results.get(list.saved_result.id).origin,'device')
 const rows=list.items.map(item=>({cells:[item.texts.find(text=>/^\d+$/.test(text))??null,item.title,item.texts.find(text=>/热度/.test(text))??null],observation_ids:item.pages.map(number=>list.pages[number-1].observation_id),note:''}))
 const saved=await run('android_save_result',{title:'知乎热榜（真机验收）',status:'complete',expected_count:20,columns:['排名','标题','热度'],rows,reason:'排名图标没有暴露为元素文字时留空；本次验收仅保存直接读到的字段，未调用模型推断。'});assert.equal(saved.result_status,'partial');assert.equal(panel.results.summaries().length,2)
 await run('android_key',{key:'home'});await run('android_release');ctx.emit('agent/status',{agent,status:'idle'});await panel.tasks.flush();await panel.results.flush()
 await page.getByRole('tab',{name:'结果',exact:true}).click();await page.getByRole('heading',{name:'知乎热榜（真机验收）',exact:true}).waitFor();assert.equal(await page.locator('.result-table tbody tr').count(),20);assert(await page.locator('.result-table').getByText('未读到',{exact:true}).count()>0)
 await page.screenshot({path:'.build/evidence/results-desktop.png'});await page.getByRole('button',{name:'截图 1',exact:true}).first().click();await page.waitForFunction(()=>document.querySelector('.result-evidence img')?.naturalWidth>0)
 await page.screenshot({path:'.build/evidence/results-evidence.png'});await page.getByRole('button',{name:'关闭截图',exact:true}).click();await page.setViewportSize({width:480,height:1000});await page.screenshot({path:'.build/evidence/results-mobile.png'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 await page.getByRole('button',{name:'复制表格',exact:true}).click();await page.getByText('已复制，可粘贴到表格或文档。',{exact:true}).waitFor();const clipboard=await page.evaluate(()=>navigator.clipboard.readText());assert(clipboard.includes(rows[0].cells[1]));assert(clipboard.includes('未读到'))
 const downloads={}
 for(const [label,ext] of [['导出 Markdown','md'],['导出 CSV','csv'],['导出依据包','zip']]){const pending=page.waitForEvent('download');await page.getByRole('button',{name:label,exact:true}).click();const download=await pending,path=join(process.cwd(),'.build/evidence',`results-export.${ext}`);await download.saveAs(path);downloads[ext]=path}
 const csv=await readFile(downloads.csv),md=await readFile(downloads.md,'utf8');assert.deepEqual([...csv.slice(0,3)],[239,187,191]);assert(md.includes('知乎热榜（真机验收）'));assert(md.includes('未读到'))
 await promisify(execFile)('python',['-c','import csv,io,json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; r=list(csv.reader(io.StringIO(z.read("report.csv").decode("utf-8-sig")))); assert len(r)==21; doc=json.loads(z.read("evidence.json")); assert len(doc["rows"])==20; assert len([n for n in z.namelist() if n.endswith(".png")])==len(doc["sources"]); assert all(z.read(n).startswith(bytes([137,80,78,71])) for n in z.namelist() if n.endswith(".png"))',downloads.zip],{windowsHide:true})
 const stored=panel.results.get(saved.result_id)
 await page.evaluate(()=>window.disposePanel());await panel.close();await new Promise(resolve=>server.close(resolve));await ctx.fiber.dispose()
 panel=await createPanel({dataDir:directory},()=>[],images);assert.deepEqual(panel.results.get(saved.result_id),stored)
 server=serve(panel);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));await page.goto(origin());await frames();await page.getByRole('tab',{name:'结果',exact:true}).click();await page.getByRole('heading',{name:'知乎热榜（真机验收）',exact:true}).waitFor();await page.getByRole('button',{name:'截图 1',exact:true}).first().click();await page.waitForFunction(()=>document.querySelector('.result-evidence img')?.naturalWidth>0)
 assert.deepEqual(errors,[])
 await writeFile('.build/evidence/results-smoke.json',JSON.stringify({pass:true,kind:'real USB + actual native Harness ToolRuntime + actual Results UI + exported files; no model invocation or desktop chat',directory,resultId:saved.result_id,rawResultId:list.saved_result.id,rows:rows.length,pages:list.pages.length,status:saved.result_status,downloads,persistedAfterRestart:true,errors,results},null,2));console.log('PASS real list → raw capture → native organized result → screenshot → copy → Markdown/CSV/ZIP → persistent restart')
}catch(error){await writeFile('.build/evidence/results-failure.json',JSON.stringify({pass:false,error:String(error),directory,results},null,2));throw error}
finally{await browser.close();await panel.close();await new Promise(resolve=>server.close(resolve));await ctx.fiber.dispose()}
