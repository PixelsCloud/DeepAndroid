import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {chromium} from 'playwright-core'
import {createPanel} from '../dist/host.js'
await mkdir('.build/tests',{recursive:true});await mkdir('.build/evidence',{recursive:true})
const directory=await mkdtemp(join(process.cwd(),'.build/tests/restoration-')),errors=[],checks=[]
let panel,server,video,opens=0
async function serve(){
 panel=await createPanel({dataDir:directory})
 const open=panel.service.open.bind(panel.service);panel.service.open=async(...args)=>{video=await open(...args);opens++;return video}
 server=createServer((req,res)=>{
  if(req.url?.startsWith('/x-android/'))return panel.handler(req,res)
  if(req.url==='/favicon.ico'){res.writeHead(204);res.end();return}
  res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#15191e;color:white}#root{height:100vh;max-width:480px;margin:auto}</style><div id="root"></div><script type="module">import{mountPanel}from"/x-android/ui.js";window.disposePanel=mountPanel(document.getElementById("root"))</script>')
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${server.address().port}`
}
async function close(){await panel.close();await new Promise(resolve=>server.close(resolve))}
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true}),page=await browser.newPage({viewport:{width:480,height:1000}})
page.on('pageerror',e=>errors.push(e.message))
const frames=()=>page.waitForFunction(()=>Number(document.querySelector('#root')?.dataset.framesRendered)>0,null,{timeout:25000})
async function state(predicate){await panel.panelState.flush();await new Promise((resolve,reject)=>{const end=Date.now()+5000;const timer=setInterval(()=>{if(predicate(panel.panelState.value)){clearInterval(timer);resolve()}else if(Date.now()>end){clearInterval(timer);reject(new Error('State write not committed'))}},30)})}
try{
 let url=await serve();await page.goto(url);await frames();assert.equal(opens,1)
 const serial=panel.state.serial;assert(serial)
 await page.getByRole('tab',{name:'结果',exact:true}).click();await state(s=>s.panel==='results')
 await page.reload();await page.getByRole('tab',{name:'结果',exact:true,selected:true}).waitFor();await frames();assert.equal(opens,1)
 console.log('checkpoint',checks.length+1);checks.push('last internal tab and selected phone survive panel recreation; active capture is reused')
 await page.getByRole('tab',{name:'手机',exact:true}).click();await page.getByRole('button',{name:'断开',exact:true}).click();await page.getByRole('status').filter({hasText:'已断开'}).waitFor();await state(s=>s.connection==='disconnected')
 const before=opens;await page.reload();await page.getByRole('status').filter({hasText:'已断开'}).waitFor();await page.waitForTimeout(1300);assert.equal(opens,before)
 await page.getByRole('tab',{name:'调试',exact:true}).click();await state(s=>s.panel==='debug')
 await page.goto('about:blank');await close();url=await serve();await page.goto(url);await page.getByRole('tab',{name:'调试',exact:true,selected:true}).waitFor();await page.getByRole('tab',{name:'手机',exact:true}).click();await page.getByRole('status').filter({hasText:'已断开'}).waitFor();assert.equal(opens,before)
 console.log('checkpoint',checks.length+1);checks.push('explicit disconnect and Debug tab survive backend restart on a new port')
 await page.getByRole('button',{name:'连接手机',exact:true}).click();await frames();const first=opens;await video.close();await page.waitForFunction(()=>document.querySelector('[data-panel=phone] [role=status]')?.textContent?.includes('重试'),null,{timeout:10000});await frames();assert.equal(opens,first+1);assert.equal(panel.state.serial,serial)
 console.log('checkpoint',checks.length+1);checks.push('simulated transport loss reconnects the same real phone without an access mode')
 let tickets=0;await page.route('**/x-android/ticket',route=>{tickets++;return route.fulfill({status:503,contentType:'application/json',body:'{"error":"injected failure"}'})})
 await video.close();await page.getByRole('status').filter({hasText:'重连已停止'}).waitFor({timeout:15000});const stopped=tickets;assert(stopped>0&&stopped<=3);await page.waitForTimeout(1300);assert.equal(tickets,stopped)
 await page.screenshot({path:'.build/evidence/restoration-retry-limit.png'});await page.unroute('**/x-android/ticket')
 console.log('checkpoint',checks.length+1);checks.push('repeated ticket failure exhausts three total recovery attempts and stops')
 await page.getByRole('button',{name:'断开',exact:true}).click();await page.getByRole('status').filter({hasText:'已断开'}).waitFor();await page.goto('about:blank')
 // A remembered missing phone must never silently bind the other authorized one.
 await panel.panelState.update({serial:'remembered-missing-phone',connection:'connected',panel:'phone'})
 await page.route('**/x-android/devices',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({devices:[{serial:'another-authorized-phone',model:'Other',state:'device'}]})}))
 let wrongTickets=0;await page.route('**/x-android/ticket',route=>{wrongTickets++;return route.abort()})
 await page.goto(url);await page.getByRole('status').filter({hasText:'重连已停止'}).waitFor({timeout:15000});assert.equal(wrongTickets,0);assert.equal(await page.locator('select[aria-label="USB 手机"]').inputValue(),'remembered-missing-phone')
 console.log('checkpoint',checks.length+1);checks.push('a missing remembered phone never falls back to a different authorized phone')
 await page.goto('about:blank');await panel.panelState.update({serial:null,connection:'auto'})
 await page.unroute('**/x-android/devices');await page.route('**/x-android/devices',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({devices:[{serial:'phone-a',model:'A',state:'device'},{serial:'phone-b',model:'B',state:'device'}]})}))
 await page.goto(url);await page.getByRole('button',{name:'连接手机',exact:true}).waitFor({state:'visible'});await page.getByRole('button',{name:'刷新',exact:true}).click();await page.waitForTimeout(1300);assert.equal(wrongTickets,0)
 checks.push('multiple phones without a remembered choice require explicit Connect, including after Refresh')
 assert.deepEqual(errors,[]);await writeFile('.build/evidence/restoration-smoke.json',JSON.stringify({pass:true,directory,checks,opens,errors,scope:'Real USB video plus injected transport/ticket/catalog failures; no physical cable-unplug claim'},null,2));console.log(JSON.stringify({pass:true,checks,opens},null,2))
}catch(error){console.error('FAIL',error);throw error}finally{await browser.close();await close()}
