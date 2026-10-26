import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {chromium} from 'playwright-core'
import {createPanel} from '../dist/host.js'
await mkdir('.build/tests',{recursive:true});await mkdir('.build/evidence',{recursive:true})
const directory=await mkdtemp(join(process.cwd(),'.build/tests/task-ui-')),panel=await createPanel({dataDir:directory}),stopped={a:0,b:0},errors=[]
panel.service.list=async()=>[]
const a=panel.tasks.begin('a','open-a','android_open_app',{app_name:'任务 A'},()=>stopped.a++),b=panel.tasks.begin('b','open-b','android_open_app',{app_name:'任务 B'},()=>stopped.b++)
panel.tasks.finish('a','open-a','android_open_app',{isError:false,value:{status:'sent'}});panel.tasks.finish('b','open-b','android_open_app',{isError:false,value:{status:'sent'}})
const source={observation_id:'proof',captured_at:new Date().toISOString(),serial:'fixture',screenshot:{attachmentId:'proof',mediaType:'image/png',bytes:20,width:1,height:1}},input=title=>({title,status:'complete',columns:['内容'],rows:[{cells:['正确的旧结果'],observation_ids:['proof']}]})
const old=await panel.results.save('a','old',a.taskId,input('任务 A 的旧结果'),()=>source,new AbortController().signal)
for(let n=0;n<24;n++)await panel.results.save('other',String(n),'other-task',input('其他结果 '+n),()=>source,new AbortController().signal)
const server=createServer((req,res)=>{if(req.url?.startsWith('/x-android/'))return panel.handler(req,res);res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#15191e;color:white}#root{height:100vh;max-width:480px;margin:auto}</style><div id="root"></div><script type="module">import{mountPanel}from"/x-android/ui.js";window.disposePanel=mountPanel(document.getElementById("root"))</script>')});await new Promise(r=>server.listen(0,'127.0.0.1',r))
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true}),page=await browser.newPage({viewport:{width:480,height:1050}});page.on('pageerror',e=>errors.push(e.message))
let release,held=false,hold=false
try{
 await page.route('**/x-android/task-feed',async route=>{if(!hold)return route.continue();hold=false;const response=await route.fetch();held=true;await new Promise(r=>release=r);await route.fulfill({response})})
 await page.goto(`http://127.0.0.1:${server.address().port}`);assert.equal(await page.locator('.android-task').isVisible(),false);await page.getByRole('tab',{name:'任务',exact:true}).click();await page.getByRole('combobox',{name:'最近手机任务',exact:true}).waitFor();await page.locator('[data-task-step]').filter({hasText:'等待 Harness 下一步'}).waitFor()
 hold=true;for(let n=0;n<50&&!held;n++)await page.waitForTimeout(50);assert(held)
 await page.getByRole('combobox',{name:'最近手机任务',exact:true}).selectOption(a.taskId);assert((await page.locator('[data-task-title]').innerText()).includes('旧结果'))
 await page.getByRole('button',{name:'停止任务',exact:true}).click();for(let n=0;n<50&&!stopped.a;n++)await page.waitForTimeout(20);assert.deepEqual(stopped,{a:1,b:0});release();await page.locator('[data-task-status]').filter({hasText:'正在停止'}).waitFor();assert.equal(await page.getByRole('combobox',{name:'最近手机任务',exact:true}).inputValue(),a.taskId)
 panel.tasks.complete('a');await page.locator('[data-task-status]').filter({hasText:'已停止'}).waitFor()
 await page.getByRole('button',{name:'生成继续草稿',exact:true}).click();await page.getByRole('dialog',{name:'继续任务草稿',exact:true}).waitFor();assert.equal(await page.getByRole('textbox',{name:'继续任务草稿内容',exact:true}).evaluate(el=>el.scrollTop),0);await page.getByRole('button',{name:'关闭草稿',exact:true}).click()
 await page.getByRole('tab',{name:'结果',exact:true}).click();await page.getByRole('searchbox',{name:'搜索结果',exact:true}).fill('不存在的筛选');await page.getByText('没有符合条件的结果，请调整搜索、日期或清空筛选。',{exact:true}).waitFor()
 await page.getByRole('tab',{name:'任务',exact:true}).click();await page.locator('.task-reports button').first().click();await page.getByRole('heading',{name:old.title,exact:true}).waitFor();assert.equal(await page.getByRole('searchbox',{name:'搜索结果',exact:true}).inputValue(),'');assert.equal(await page.locator('.result-table td').first().innerText(),'正确的旧结果');assert((await page.locator('[data-results-page]').innerText()).includes('25'))
 await page.getByRole('button',{name:'删除',exact:true}).click();await page.getByRole('button',{name:'撤销',exact:true}).waitFor();await page.waitForTimeout(1300);assert.equal(await page.locator('.task-reports button').count(),0)
 assert.deepEqual(errors,[]);await writeFile('.build/evidence/task-ui-smoke.json',JSON.stringify({pass:true,directory,stopped,errors,checks:['thinking phase shown without claiming an active phone gesture','changing task during a delayed old poll immediately updates the Stop target','old poll cannot revive stopped state or override selected task','task result button clears unrelated filters and opens its exact result on the second page','deleted reports disappear from task links']},null,2));console.log('PASS task selection/stop race, stale poll, thinking state, exact older-result navigation and deletion')
}finally{release?.();await browser.close();await panel.close();await new Promise(r=>server.close(r))}
