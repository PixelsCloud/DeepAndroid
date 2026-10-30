import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {chromium} from 'playwright-core'
import {createPanel} from '../dist/host.js'
await mkdir('.build/evidence',{recursive:true});await mkdir('.build/tests',{recursive:true})
const directory=await mkdtemp(join(process.cwd(),'.build/tests/manage-results-'))
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=','base64')
const source={observation_id:'ui_fixture',captured_at:'2026-10-24T10:00:00.000Z',serial:'fixture',screenshot:{attachmentId:'fixture-image',mediaType:'image/png',width:1,height:1,bytes:png.length}}
const images={async readImage(){return{data:png}}}
let panel=await createPanel({dataDir:directory},()=>[],images)
for(let i=0;i<25;i++){
 const label=String(i).padStart(2,'0'),saved=await panel.results.save('fixture','call-'+i,'fixture-task',{title:'结果'+label,status:'complete',columns:['内容'],rows:[{cells:['内容'+label],observation_ids:[source.observation_id]}]},()=>source,new AbortController().signal)
 await writeFile(join(directory,'results',saved.id+'.json'),JSON.stringify({...saved,created_at:`2026-10-${i<5?'23':'24'}T10:${label}:00.000Z`}))
}
await panel.close();panel=await createPanel({dataDir:directory},()=>[],images)
function serve(current){return createServer(async(req,res)=>{
 if(req.url?.startsWith('/x-android/'))return current.handler(req,res)
 if(req.url==='/favicon.ico'){res.writeHead(204);res.end();return}
 res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#15191e;color:#e4e8eb}#root{height:100%}</style><div id="root"></div><script type="module">import{mountPanel}from"/x-android/ui.js";window.disposePanel=mountPanel(document.getElementById("root"))</script>')
})}
let server=serve(panel);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true}),context=await browser.newContext({viewport:{width:860,height:1000},timezoneId:'Asia/Shanghai',acceptDownloads:true}),page=await context.newPage(),errors=[],checks=[]
page.on('pageerror',error=>errors.push(error.message))
const origin=()=>`http://127.0.0.1:${server.address().port}`
const button=name=>page.getByRole('button',{name,exact:true})
const heading=name=>page.getByRole('heading',{name,exact:true})
const search=()=>page.getByRole('searchbox',{name:'搜索结果',exact:true})

async function count(n){await page.locator('[data-results-page]').filter({hasText:new RegExp(' / '+n+'$')}).waitFor()}
async function open(){await page.goto(origin());await page.getByRole('tab',{name:'结果',exact:true}).click()}
const row=title=>page.locator('[data-result-id]').filter({has:page.locator('strong',{hasText:title})})
const modal=page.getByRole('dialog',{name:'结果详情',exact:true})
try{
 await open();await count(25);assert.equal(await page.locator('[data-result-id]').count(),20)
 assert.equal(await modal.isVisible(),false);assert.equal(await page.locator('[data-results-from],.result-filter-fold,[data-results-count]').count(),0)
 await row('结果24').click();assert.equal(await modal.isVisible(),false)
 await row('结果24').dblclick();await heading('结果24').waitFor()
 await button('重命名').click();await page.getByRole('textbox',{name:'结果标题',exact:true}).fill('我的热榜');await button('保存名称').click();await heading('我的热榜').waitFor()
 const downloadWait=page.waitForEvent('download');await button('导出 Markdown').click();const download=await downloadWait;await download.saveAs(join(directory,'renamed.md'));assert((await readFile(join(directory,'renamed.md'),'utf8')).includes('我的热榜'))
 await button('截图 1').click();await page.waitForFunction(()=>document.querySelector('.result-evidence img')?.naturalWidth===1);await button('关闭截图').click();assert(await modal.isVisible())
 await button('关闭结果详情').click();assert.equal(await modal.isVisible(),false)
 checks.push('Single click selects; double click opens a modal with working rename, export and nested evidence preview')
 await search().fill('我的热榜');await count(1);await row('我的热榜').focus();await page.keyboard.press('Enter');await heading('我的热榜').waitFor()
 await page.keyboard.press('Escape');await modal.waitFor({state:'hidden'})
 await search().fill('');await count(25);await button('下一页').click();await page.locator('[data-results-page]').filter({hasText:'21–25 / 25'}).waitFor();assert.equal(await page.locator('[data-result-id]').count(),5)
 await page.locator('[data-result-id]').first().dblclick();await modal.locator('h2').waitFor();await button('删除').click();const confirmation=page.getByRole('dialog',{name:'删除结果',exact:true});await confirmation.waitFor();await confirmation.getByRole('button',{name:'取消',exact:true}).click();assert(await modal.isVisible());await count(25);await button('删除').click();await confirmation.getByRole('button',{name:'确认删除',exact:true}).click();await modal.waitFor({state:'hidden'});await count(24);await button('撤销').click();await count(25)
 checks.push('Search, pagination, Enter/Escape and delete/undo work without inline details')
 await page.locator('[data-result-id]').first().click()
 const preservedId=await page.locator('[data-result-id][aria-pressed=true]').getAttribute('data-result-id')
 const deleteId=await page.locator('[data-result-id]').last().getAttribute('data-result-id')
 await page.locator('.result-row').last().locator('.result-row-delete').click();await confirmation.waitFor();await page.keyboard.press('Escape');assert.equal(await page.locator('[data-result-id="'+deleteId+'"]').count(),1);await count(25);await page.locator('.result-row').last().locator('.result-row-delete').click();await page.screenshot({path:'.build/evidence/result-delete-confirm.png'});await confirmation.getByRole('button',{name:'确认删除',exact:true}).click();await count(24)
 assert.equal(await page.locator('[data-result-id="'+deleteId+'"]').count(),0);assert.equal(await page.locator('[data-result-id="'+preservedId+'"]').count(),1);assert.equal(await modal.isVisible(),false)
 await button('撤销').click();await count(25)
 assert.equal(await page.locator('.result-toolbar [data-results-delete]').count(),0)
 await search().fill('no-matching-result');await count(0);assert.equal(await page.locator('.result-row-delete').count(),0)
 await search().fill('');await count(25)
 checks.push('Right-side delete removes its own unselected row without opening details or deleting the selected row; undo works')
 await page.route('**/x-android/results?*',async route=>{if(new URL(route.request().url()).searchParams.get('query')==='内容01'){await new Promise(resolve=>setTimeout(resolve,700));await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'旧查询失败，应被忽略'})});return}await route.continue()})
 await search().fill('内容01');await page.waitForTimeout(350);await search().fill('内容02');await row('结果02').waitFor();await page.waitForTimeout(900);assert.equal(await row('结果02').count(),1);assert.equal(await page.locator('.android-toast[data-kind=error]').count(),0);await page.unroute('**/x-android/results?*')
 checks.push('A delayed prior search cannot replace the latest result list')
 await search().fill('');await count(25)
 while(await page.locator('.android-toast').count())await page.locator('.android-toast button').first().click()
 for(const width of [360,640,920,1040]){
  await page.setViewportSize({width,height:900});await page.waitForTimeout(150)
  const geometry=await page.evaluate(()=>{const r=s=>document.querySelector(s).getBoundingClientRect();return{search:r('[data-results-query]').y,refresh:r('[data-results-refresh]').y,list:r('.result-list').height,panel:r('.android-results-root').height}})
  assert(Math.abs(geometry.search-geometry.refresh)<2);assert(geometry.list>geometry.panel*.75)
  const widths=await page.evaluate(()=>{const rect=s=>document.querySelector(s).getBoundingClientRect();return{search:rect('[data-results-query]').width,toolbar:rect('.result-toolbar').width,panel:rect('.android-results-root').width,list:rect('.result-list').width,item:rect('.result-row').width,shadow:getComputedStyle(document.querySelector('[data-result-id][aria-pressed=true]')??document.querySelector('[data-result-id]')).boxShadow}})
  assert(widths.search>=100);assert(Math.abs(widths.toolbar-widths.panel)<2);assert(Math.abs(widths.list-widths.panel)<2);assert(widths.item>=widths.list-18);assert.equal(widths.shadow,'none')
  const remove=await page.locator('.result-row-delete').first().boundingBox(),entry=await page.locator('.result-row').first().boundingBox();assert(remove.x+remove.width<=entry.x+entry.width);assert(remove.x>entry.x+entry.width-55)
  await page.screenshot({path:'.build/evidence/results-list-'+width+'.png'})
  await page.locator('[data-result-id]').first().dblclick();await modal.locator('h2').waitFor();await page.screenshot({path:'.build/evidence/results-dialog-'+width+'.png'})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  await button('关闭结果详情').click()
 }
 checks.push('360/640/1040px layouts keep search and refresh in one row and give the list the remaining height')
 assert.deepEqual(errors,[]);await writeFile('.build/evidence/result-management-smoke.json',JSON.stringify({pass:true,checks,errors},null,2));console.log(JSON.stringify({pass:true,checks,errors},null,2))
}catch(error){await page.screenshot({path:'.build/evidence/result-management-failure.png'}).catch(()=>{});throw error}
finally{await browser.close();await panel.close();await new Promise(resolve=>server.close(resolve))}
