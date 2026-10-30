import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {chromium} from 'playwright-core'
import {createPanel} from '../dist/host.js'
await mkdir('.build/evidence',{recursive:true})
const panel=await createPanel(),inputs=[]
panel.tasks.begin('layout-fixture','layout-call','android_open_app',{app_name:'示例任务'},()=>{});panel.tasks.finish('layout-fixture','layout-call','android_open_app',{isError:false,value:{status:'sent'}});panel.tasks.complete('layout-fixture')
const manual=panel.runtime.manual.bind(panel.runtime)
panel.runtime.manual=(viewer,command)=>{inputs.push(command);return manual(viewer,command)}
const server=createServer(async(req,res)=>{
 if(req.url?.startsWith('/x-android/'))return panel.handler(req,res)
 if(req.url==='/favicon.ico'){res.writeHead(204);res.end();return}
 res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#15191e;color:#e4e8eb}#root{height:100%}</style><div id="root"></div><script type="module">import{mountPanel}from"/x-android/ui.js";window.disposePanel=mountPanel(document.getElementById("root"))</script>')
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true}),page=await browser.newPage(),errors=[],layouts=[]
page.on('pageerror',e=>errors.push(e.message))
try {
 await page.setViewportSize({width:480,height:960});await page.goto(`http://127.0.0.1:${server.address().port}`)
 await page.waitForFunction(()=>Number(document.querySelector('#root')?.dataset.framesRendered)>0,null,{timeout:25000})
 await page.waitForFunction(()=>document.querySelector('[data-task-title]')?.textContent?.includes('示例任务'))
 assert.equal(await page.locator('.android-task').isVisible(),false)
 for(const size of [{width:360,height:820},{width:480,height:960},{width:860,height:900}]){
  await page.setViewportSize(size);await page.waitForTimeout(150)
  const layout=await page.evaluate(()=>{
   const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}}
   return{video:rect('.android-video'),rail:rect('.android-phone-keys'),canvas:rect('canvas'),buttons:[...document.querySelectorAll('.android-phone-keys button')].map(b=>({text:b.textContent,top:b.getBoundingClientRect().top})),overflow:document.documentElement.scrollWidth>innerWidth,title:!!document.querySelector('.android-top'),debugHidden:document.querySelector('[data-panel=debug]').hidden}
  })
  assert(layout.rail.x>=layout.video.right);assert(Math.abs(layout.rail.y-layout.video.y)<1);assert(layout.buttons.every((b,i)=>!i||b.top>layout.buttons[i-1].top));assert(layout.canvas.bottom<=layout.video.bottom+1);assert(!layout.overflow);assert(!layout.title);assert(layout.debugHidden);assert(layout.video.height>size.height*0.60)
  layouts.push({size,...layout});await page.screenshot({path:`.build/evidence/layout-phone-${size.width}.png`})
 }
 await page.getByRole('tab',{name:'任务',exact:true}).click();assert.equal(await page.locator('.android-task').isVisible(),true);assert.equal(await page.locator('.android-video').isVisible(),false);await page.screenshot({path:'.build/evidence/layout-tasks.png'});await page.getByRole('tab',{name:'手机',exact:true}).click();assert.equal(await page.locator('.android-task').isVisible(),false)
 await page.getByRole('button',{name:'主页',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.android-input-status')?.style.color!=='rgb(230, 143, 143)');assert(inputs.some(c=>c.kind==='key'&&c.key==='home'))
 await page.getByRole('tab',{name:'调试',exact:true}).click();await page.getByText(/已发现.*台已授权手机/).waitFor();assert.equal(await page.locator('.android-meta').isVisible(),false);await page.locator('.video-detail-fold summary').click();assert.equal(await page.locator('.android-meta').isVisible(),true);assert.equal(await page.locator('.android-video').isVisible(),false)
 await page.screenshot({path:'.build/evidence/layout-debug.png'})
 await page.getByRole('button',{name:'常用任务',exact:true}).click();await page.locator('[data-template] option').first().waitFor({state:'attached'})
 await page.getByRole('tab',{name:'手机',exact:true}).click();await page.waitForFunction(()=>Number(document.querySelector('#root')?.dataset.framesRendered)>5)
 assert.equal(panel.state.state,'streaming');assert.equal(await page.locator('.android-meta').isVisible(),false);assert.equal(await page.locator('[data-action=disconnect]').isDisabled(),false)
 await page.getByRole('button',{name:'断开',exact:true}).click();await page.getByRole('status').filter({hasText:'已断开'}).waitFor();await page.getByRole('button',{name:'连接手机',exact:true}).click();await page.waitForFunction(()=>Number(document.querySelector('#root')?.dataset.framesRendered)>0,null,{timeout:25000})
 assert.deepEqual(errors,[]);await writeFile('.build/evidence/layout-smoke.json',JSON.stringify({pass:true,layouts,checks:['right-side top-aligned controls at 360/480/860px','no Android heading','technical info and management only in Debug tab','manual Home input, tab switching and reconnect work'],errors},null,2));console.log('PASS responsive phone layout, Debug tab, manual input and reconnect')
}finally{await browser.close();await panel.close();await new Promise(resolve=>server.close(resolve))}
