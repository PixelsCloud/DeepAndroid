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
const scope=()=>page.getByRole('combobox',{name:'结果范围',exact:true})
async function count(n){await page.locator('[data-results-count]').filter({hasText:`符合条件 ${n} 份`}).waitFor()}
async function open(){await page.goto(origin());await page.getByRole('tab',{name:'结果',exact:true}).click()}
try{
 await open();await count(25);assert.equal(await page.locator('.result-list button').count(),20);await heading('结果24').waitFor()
 await button('重命名').click();await page.getByRole('textbox',{name:'结果标题',exact:true}).fill('   ');await button('保存名称').click();await page.locator('[data-result-rename-error]').filter({hasText:'标题须为'}).waitFor()
 await page.getByRole('textbox',{name:'结果标题',exact:true}).fill('我的热榜');await button('保存名称').click();await heading('我的热榜').waitFor();assert.equal(await page.locator('.result-table tbody tr').count(),1)
 checks.push('rename edits only the title and preserves table data')
 await search().fill('我的热榜');await count(1);await heading('我的热榜').waitFor();await search().fill('内容07');await count(1);await heading('结果07').waitFor()
 await button('清空筛选').click();await count(25);await page.getByLabel('开始日期',{exact:true}).fill('2026-10-23');await page.getByLabel('结束日期',{exact:true}).fill('2026-10-23');await count(5);assert.equal(await page.locator('.result-list button').count(),5)
 await page.getByLabel('开始日期',{exact:true}).fill('2026-10-25');await page.locator('[data-results-error]').filter({hasText:'开始日期不能晚于结束日期'}).waitFor();assert.equal(await page.locator('.result-detail h2').count(),0)
 await button('清空筛选').click();await count(25);await button('下一页').click();await page.locator('[data-results-page]').filter({hasText:'21–25 / 25'}).waitFor();assert.equal(await page.locator('.result-list button').count(),5)
 checks.push('literal full-content search, local calendar dates, invalid-range feedback and pagination work')
 await button('删除').click();await count(24);await button('撤销').click();await count(25)
 await button('上一页').click();await page.locator('[data-results-page]').filter({hasText:'1–20 / 25'}).waitFor();await search().fill('我的热榜');await count(1)
 const downloadWait=page.waitForEvent('download');await button('导出 Markdown').click();const download=await downloadWait;await download.saveAs(join(directory,'renamed.md'));assert((await readFile(join(directory,'renamed.md'),'utf8')).includes('我的热榜'))
 await button('删除').click();await count(0);await scope().selectOption('deleted');await count(1);await button('恢复结果').waitFor()
 checks.push('delete removes normal access, undo restores it and exports use the renamed title')
 await page.evaluate(()=>window.disposePanel());await panel.close();await new Promise(resolve=>server.close(resolve))
 panel=await createPanel({dataDir:directory},()=>[],images);assert.equal(panel.results.query({deleted:true}).total,1)
 server=serve(panel);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));await open();await scope().selectOption('deleted');await count(1);await button('恢复结果').click();await count(0)
 await scope().selectOption('active');await search().fill('我的热榜');await count(1);await heading('我的热榜').waitFor();await button('截图 1').click();await page.waitForFunction(()=>document.querySelector('.result-evidence img')?.naturalWidth===1);await button('关闭截图').click()
 checks.push('recent deletion and renaming survive restart; restore retains screenshot evidence')
 await page.route('**/x-android/results?*',async route=>{if(new URL(route.request().url()).searchParams.get('query')==='内容01'){await new Promise(resolve=>setTimeout(resolve,700));await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'旧查询失败，应被忽略'})});return}await route.continue()})
 await search().fill('内容01');await page.waitForTimeout(350);await search().fill('内容02');await heading('结果02').waitFor();await page.waitForTimeout(900);assert.equal(await heading('结果02').count(),1);assert.equal(await page.locator('[data-results-error]').isVisible(),false);await page.unroute('**/x-android/results?*')
 checks.push('a delayed prior search cannot replace the latest query result')
 await button('清空筛选').click();await count(25);await page.screenshot({path:'.build/evidence/result-management-desktop.png'});await page.setViewportSize({width:360,height:900});await page.screenshot({path:'.build/evidence/result-management-mobile.png'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 assert.deepEqual(errors,[]);await writeFile('.build/evidence/result-management-smoke.json',JSON.stringify({pass:true,kind:'actual management UI + isolated synthetic reports + restart; no model invocation or modification of user reports',directory,checks,errors},null,2));console.log(JSON.stringify({pass:true,checks,errors},null,2))
}catch(error){await writeFile('.build/evidence/result-management-failure.json',JSON.stringify({pass:false,error:String(error),directory,checks,errors},null,2));await page.screenshot({path:'.build/evidence/result-management-failure.png'}).catch(()=>{});throw error}
finally{await browser.close();await panel.close();await new Promise(resolve=>server.close(resolve))}
