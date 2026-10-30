import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {build} from 'esbuild'
import {chromium} from 'playwright-core'

await mkdir('.build/tests',{recursive:true});await mkdir('.build/evidence',{recursive:true})
const directory=await mkdtemp(join(process.cwd(),'.build/tests/more-menu-'))
await build({stdin:{contents:`import {mountPanel} from './src/ui.ts';window.dispose=mountPanel(document.getElementById('root'))`,resolveDir:process.cwd()},outfile:join(directory,'test.js'),bundle:true,format:'esm',platform:'browser',target:'chrome130'})
const calls=[],saved={maxSize:1280,maxFps:30,videoBitRate:4000000,audio:false,audioSource:'output'}
let recording=null,deviceReads=0
const json=(res,value)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value))}
const server=createServer(async(req,res)=>{
 const path=req.url.split('?')[0];let text='';for await(const chunk of req)text+=chunk;const body=text?JSON.parse(text):null
 if(body)calls.push({path,body})
 if(path==='/test.js'){res.setHeader('content-type','text/javascript');res.end(await readFile(join(directory,'test.js')));return}
 if(path==='/x-android/panel-state')return json(res,{state:{panel:'phone',connection:'disconnected',serial:null,autoOpen:false}})
 if(path==='/x-android/devices'){deviceReads++;return json(res,{devices:[]})}
 if(path==='/x-android/task-feed')return json(res,{tasks:[],warning:null})
 if(path==='/x-android/media-settings'){if(body)Object.assign(saved,body);return json(res,{saved,active:null,audio_status:'disabled',recording})}
 if(path==='/x-android/clipboard')return json(res,{text:'手机剪贴板示例'})
 if(path==='/x-android/recordings'){if(body?.action==='start'){recording={id:'record',duration_ms:500,started_at:new Date().toISOString()};return json(res,recording)}recording=null;return json(res,{id:'record',status:'saved',local_path:'fixture.mkv'})}
 if(path.startsWith('/x-android/'))return json(res,{})
 res.setHeader('content-type','text/html;charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#10151d}#root{height:100%}</style><div id="root"></div><script type="module" src="/test.js"></script>')
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true})
const page=await browser.newPage({viewport:{width:920,height:760}});page.setDefaultTimeout(8000)
const errors=[];page.on('pageerror',error=>errors.push(error.message))
const menu=page.locator('.android-more'),more=page.locator('[data-action=more]')
async function open(){await more.click();await menu.waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('[data-action=more]').getAttribute('aria-expanded')==='true')}
async function checkBounds(){const box=await menu.boundingBox(),view=page.viewportSize();assert(box.x>=7&&box.y>=7&&box.x+box.width<=view.width-7&&box.y+box.height<=view.height-7,JSON.stringify({box,view}));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)}
try{
 await page.goto('http://127.0.0.1:'+server.address().port);await more.waitFor()
 const before=await page.locator('.android-workspace').boundingBox();await open()
 assert.deepEqual(await page.locator('.android-workspace').boundingBox(),before)
 assert.equal(await page.locator('dialog:modal').count(),0)
 assert.equal(await menu.getAttribute('popover'),'auto');await checkBounds()
 await more.click();await menu.waitFor({state:'hidden'})
 await open();await page.keyboard.press('Escape');await menu.waitFor({state:'hidden'});assert(await more.evaluate(el=>el===document.activeElement))
 await more.press('Enter');await menu.waitFor({state:'visible'})
 const reads=deviceReads;await page.getByRole('button',{name:'刷新',exact:true}).click();await menu.waitFor({state:'hidden'});await page.waitForTimeout(150);assert(deviceReads>reads,'Outside click must execute without modal interception')
 for(const viewport of [{width:360,height:760},{width:920,height:760},{width:480,height:360}]){
  await page.setViewportSize(viewport);await open()
  for(const tab of ['设备','剪贴板','画面','录制']){
   await menu.getByRole('tab',{name:tab,exact:true}).click();await checkBounds()
   await page.screenshot({path:`.build/evidence/more-menu-${viewport.width}-${tab}.png`})
  }
  await page.keyboard.press('Escape');await menu.waitFor({state:'hidden'})
 }
 await page.setViewportSize({width:920,height:760});await open();await menu.getByRole('tab',{name:'设备',exact:true}).click()
 await menu.getByRole('button',{name:'音量 ＋',exact:true}).click();await page.waitForTimeout(100);assert(await menu.isVisible())
 assert(calls.some(call=>call.path==='/x-android/system-key'&&call.body.key==='volumeUp'))
 await menu.getByRole('button',{name:'旋转',exact:true}).click();await menu.waitFor({state:'hidden'});assert(calls.some(call=>call.body.action==='rotate'))
 await open();await menu.getByRole('tab',{name:'剪贴板',exact:true}).click();await menu.getByRole('button',{name:'读取手机',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-clipboard-text]').value==='手机剪贴板示例')
 await menu.locator('textarea').fill('保留写入功能');await menu.getByRole('button',{name:'写入手机',exact:true}).click();await page.waitForTimeout(100);assert(calls.some(call=>call.body.action==='set'&&call.body.text==='保留写入功能'))
 await page.keyboard.press('Escape');await open();await menu.getByRole('tab',{name:'剪贴板',exact:true}).click();assert.equal(await menu.locator('textarea').inputValue(),'')
 await menu.getByRole('tab',{name:'画面',exact:true}).click();await menu.locator('[data-media-fps]').fill('45');await menu.locator('[data-media-save]').click();await page.waitForTimeout(100);assert(calls.some(call=>call.path==='/x-android/media-settings'&&call.body.maxFps===45&&call.body.apply===false))
 await menu.getByRole('tab',{name:'录制',exact:true}).click();await menu.locator('[data-record-start]').click();await page.waitForFunction(()=>!document.querySelector('[data-record-stop]').disabled)
 await page.keyboard.press('Escape');await open();await menu.getByRole('tab',{name:'录制',exact:true}).click();assert(await menu.locator('[data-record-stop]').isEnabled());await menu.locator('[data-record-stop]').click();await menu.locator('[data-record-download]').waitFor({state:'visible'})
 await menu.getByRole('button',{name:'关闭更多操作'}).click();await open();await page.getByRole('tab',{name:'任务',exact:true}).click();await menu.waitFor({state:'hidden'})
 await page.evaluate(()=>window.dispose());assert.equal(await menu.count(),0);assert.deepEqual(errors,[])
 await writeFile('.build/evidence/more-menu-smoke.json',JSON.stringify({pass:true,checks:'non-modal anchored menu; 3 viewport sizes × 4 panels; toggle/outside/Esc/focus; unchanged controls, clipboard, settings, recording and disposal',errors},null,2))
 console.log('PASS: anchored non-modal menu, 12 responsive panels, dismissal and all retained action groups')
}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
