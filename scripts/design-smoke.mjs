import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {chromium} from 'playwright-core'
import {createPanel} from '../dist/host.js'
import {directoryPage} from '../dist/file-manager-model.js'
await mkdir('.build/tests',{recursive:true});await mkdir('.build/evidence',{recursive:true})
const panel=await createPanel({dataDir:await mkdtemp(join(process.cwd(),'.build/tests/design-'))})
panel.service.list=async()=>[{serial:'design-phone',model:'Pixel 9',state:'device'}]
panel.fileManager.listDirectory=async(serial,path)=>directoryPage(serial,path,Array.from({length:12},(_,i)=>({name:`旅行照片_${String(i+1).padStart(2,'0')}.jpeg`,path:path+`/photo-${i}.jpeg`,type:'file',bytes:75468,mtime_seconds:'1',modified_at:'2026-10-29T12:00:00Z',version:'file:75468:1'})),false,{})
panel.tasks.begin('design','call','android_open_app',{app_name:'知乎热榜阅读'},()=>{})
panel.tasks.finish('design','call','android_open_app',{isError:false,value:{status:'sent'}});panel.tasks.complete('design')
const source={observation_id:'proof',captured_at:new Date().toISOString(),serial:'fixture',screenshot:{attachmentId:'proof',mediaType:'image/png',bytes:20,width:1,height:1}}
for(let i=0;i<4;i++)await panel.results.save('design','result-'+i,'task',{title:['知乎热榜前三条详情与回答阅读报告','每日热点整理','旅行攻略与目的地清单','本周阅读记录'][i],status:'complete',summary:'已整理本次阅读内容。可以查看各条记录，结合截图依据核对，并导出为表格或 Markdown。',columns:['标题','摘要'],rows:[{cells:['今日热点','阅读内容与重点摘要'],observation_ids:['proof']}]},()=>source,new AbortController().signal)
const server=createServer((req,res)=>{if(req.url?.startsWith('/x-android/'))return panel.handler(req,res);res.setHeader('content-type','text/html;charset=utf-8');res.end('<!doctype html><style>body{margin:0;background:#0d1117}#root{height:calc(100dvh - 40px);margin-top:40px} .host{height:40px;position:absolute;top:0;color:#aaa;font:12px system-ui;padding:10px 16px;box-sizing:border-box}</style><div class="host">Android · 设备工作台</div><div id="root"></div><script type="module">import{mountPanel}from"/x-android/ui.js";window.dispose=mountPanel(document.getElementById("root"))</script>')})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true}),page=await browser.newPage(),errors=[],checks=[]
page.on('pageerror',e=>errors.push(e.message))
try{
 await page.route('**/x-android/panel-state',route=>route.request().method()==='GET'?route.fulfill({json:{state:{serial:null,connection:'disconnected',panel:'phone',autoOpen:false}}}):route.continue())
 await page.setViewportSize({width:560,height:860});await page.goto('http://127.0.0.1:'+server.address().port)
 await page.getByRole('option',{name:/Pixel 9/}).waitFor({state:'attached'})
 for(const width of [360,560,1040]){
  await page.setViewportSize({width,height:860})
  for(const name of ['手机','文件','任务','结果','调试']){
   await page.getByRole('tab',{name,exact:true}).click()
   if(name==='文件')await page.getByRole('button',{name:'旅行照片_01.jpeg',exact:true}).waitFor()
   if(name==='结果')await page.locator('.result-list button').first().waitFor()
   if(name==='任务'){
    assert.equal(await page.locator('[data-task-metrics]').isVisible(),false)
    await page.locator('.task-detail-fold summary').click();assert(await page.locator('[data-task-metrics]').isVisible())
    await page.waitForTimeout(1100);assert(await page.locator('[data-task-metrics]').isVisible())
    await page.locator('.task-detail-fold summary').click()
   }
   if(name==='结果'){
    assert(await page.locator('[data-results-query]').isVisible())
    assert.equal(await page.locator('[data-results-from],.result-filter-fold,[data-results-count]').count(),0)
   }
   if(name==='调试'){
    await page.locator('[data-doctor-report] details summary').waitFor()
    assert.equal(await page.locator('.android-meta').isVisible(),false)
    await page.locator('[data-doctor-report] details summary').click();assert(await page.getByText(/^ADB：/).isVisible())
    await page.locator('[data-doctor-report] details summary').click()
   }
   await page.waitForTimeout(200)
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${width} ${name} overflow`)
   const bounds=await page.locator('.android-panel-tabs').boundingBox();assert(bounds.y>=40)
   await page.screenshot({path:`.build/evidence/design-${width}-${name}.png`})
   checks.push(`${width}px ${name}`)
  }
 }
 await page.setViewportSize({width:560,height:860})
 const beforeToast=await page.locator('[data-panel=debug] .view-heading').boundingBox()
 await page.evaluate(()=>document.getElementById('root').dispatchEvent(new CustomEvent('android-toast',{bubbles:true,detail:{message:'部分结果文件无法读取，其他结果仍可查看',kind:'error'}})))
 await page.waitForTimeout(250)
 const toast=await page.locator('.android-toast').boundingBox(),tabs=await page.locator('.android-panel-tabs').boundingBox(),heading=await page.locator('[data-panel=debug] .view-heading').boundingBox()
 assert(toast.y>=tabs.y+tabs.height);assert.deepEqual(heading,beforeToast)
 assert.equal(await page.locator('.android-notice-space').count(),0)
 await page.screenshot({path:'.build/evidence/design-toast.png'})
 await page.getByRole('button',{name:'关闭错误提示'}).click()
 assert.deepEqual(await page.locator('[data-panel=debug] .view-heading').boundingBox(),beforeToast)
 await page.evaluate(()=>window.dispose());assert.equal(await page.locator('.android-toasts').count(),0)
 assert.deepEqual(errors,[]);await writeFile('.build/evidence/design-smoke.json',JSON.stringify({pass:true,checks,errors},null,2));console.log('PASS 15 responsive pages, floating notifications without layout shift and cleanup')
}finally{await browser.close();await panel.close();await new Promise(r=>server.close(r))}
