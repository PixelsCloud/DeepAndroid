import { chromium } from 'playwright-core'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'
const run = promisify(execFile)
const preview = process.argv[2]
assert(preview, 'Pass preview URL, optionally followed by --desktop')
const desktop = process.argv.includes('--desktop')
const adb = async (...args) => (await run('adb', ['-s','e2b3b128',...args], { encoding:'utf8', timeout:20000, windowsHide:true })).stdout
let browser, page
if (desktop) {
  const port=(await readFile(process.env.APPDATA+'/@deepseek-ai/dsh-desktop/DevToolsActivePort','utf8')).split('\n')[0]
  browser=await chromium.connectOverCDP('http://127.0.0.1:'+port)
  page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('dsh-app://app'))
} else {
  browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true})
  page=await browser.newPage({viewport:{width:480,height:1080}});await page.goto(preview)
}
assert(page,'Control page not found')
const panel=page.locator('.android-panel')
const errors=[];page.on('pageerror',e=>errors.push(e.message))
const state=async()=>await(await fetch(preview+'/fixture-state')).json()
async function until(predicate,label) {
  const end=Date.now()+7000
  while(Date.now()<end){const s=await state();if(predicate(s))return s;await new Promise(r=>setTimeout(r,60))}
  throw new Error(label+'; state='+JSON.stringify(await state())+'; panel='+await panel.innerText())
}
async function anchor() {
  await adb('shell','uiautomator','dump','/data/local/tmp/dsh-android-control-ui.xml')
  const xml=await adb('shell','cat','/data/local/tmp/dsh-android-control-ui.xml')
  const target=await page.evaluate(xml=>{
    const doc=new DOMParser().parseFromString(xml,'application/xml')
    const node=[...doc.querySelectorAll('node')].find(n=>n.getAttribute('class')==='android.webkit.WebView'&&n.getAttribute('text')==='Android 控制验收')
    return node?.getAttribute('bounds')
  },xml)
  assert(target,'Phone fixture must be visible; dismiss unrelated Chrome overlays first')
  const [x1,y1,x2,y2]=target.match(/\d+/g).map(Number)
  const s=await state(),d=s.pixelRatio
  return {x:x1,y:y1,d}
}
async function point(id,fx=.5,fy=.5) {
  const a=await anchor(),s=await state(),b=s.boxes[id]
  const px=a.x+(b.x+b.width*fx)*a.d,py=a.y+(b.y+b.height*fy)*a.d
  const canvas=panel.locator('canvas'),box=await canvas.boundingBox()
  const physical=await adb('shell','wm','size');const match=physical.match(/(?:Override|Physical) size: (\d+)x(\d+)/)
  const w=Number(match[1]),h=Number(match[2])
  const size=await canvas.evaluate(c=>({w:c.width,h:c.height}))
  const scale=Math.min(box.width/size.w,box.height/size.h)
  return {x:box.x+(box.width-size.w*scale)/2+px/w*size.w*scale,y:box.y+(box.height-size.h*scale)/2+py/h*size.h*scale}
}
const checks=[]
try {
  await panel.waitFor()
  if(await panel.getByRole('button',{name:'连接手机',exact:true}).isEnabled())await panel.getByRole('button',{name:'连接手机',exact:true}).click()
  await page.waitForFunction(()=>Number(document.querySelector('.android-panel')?.parentElement?.dataset.framesRendered)>=5,null,{timeout:25000})
  await until(s=>s.boxes?.tap,'Fixture must be loaded')
  const start=await state()
  const positions=desktop?[null]:[320,480,720]
  let total=0
  for(const width of positions){
    if(width)await page.setViewportSize({width,height:1080})
    const p=await point('tap')
    for(let i=0;i<(desktop?20:34);i++){await page.mouse.click(p.x,p.y,{delay:35});total++}
    await until(s=>s.clicks===start.clicks+total,'Tap count must match exactly')
  }
  checks.push({test:'scaled taps',count:total,result:'pass'})
  if(!desktop)await page.setViewportSize({width:480,height:1080})
  const hold=await point('hold'),longs=(await state()).longPresses
  await page.mouse.move(hold.x,hold.y);await page.mouse.down();await new Promise(r=>setTimeout(r,800));await page.mouse.up()
  await until(s=>s.longPresses===longs+1,'Long press must reach phone');checks.push({test:'long press',result:'pass'})
  const dragStart=await point('drag',.2,.4),dragEnd=await point('drag',.8,.7),old=await state()
  await page.mouse.move(dragStart.x,dragStart.y);await page.mouse.down();await page.mouse.move(dragEnd.x,dragEnd.y,{steps:20});await page.mouse.up()
  await until(s=>s.dragMoves>old.dragMoves&&!s.pressed&&s.ups>old.ups,'Drag must move and release');checks.push({test:'drag',result:'pass'})
  const p=await point('drag'),ups=(await state()).ups
  await page.mouse.move(p.x,p.y);await page.mouse.down();await until(s=>s.pressed,'Pointer must be down')
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')))
  await until(s=>!s.pressed&&s.ups>ups,'Blur must release phone touch');await page.mouse.up();checks.push({test:'blur release',result:'pass'})
  const input=await point('text');await page.mouse.click(input.x,input.y,{delay:50})
  const sample='中文 Pixels 123！\n第二行🙂'
  await panel.getByRole('textbox',{name:'输入到手机的文字'}).fill(sample)
  await panel.getByRole('button',{name:'输入文字',exact:true}).click()
  await until(s=>s.text===sample,'Unicode paste must equal the requested text');checks.push({test:'Chinese multiline emoji paste',result:'pass'})
  const inputAgain=await point('text');await page.mouse.click(inputAgain.x,inputAgain.y,{delay:40})
  await page.keyboard.press('Control+A');await page.keyboard.press('Backspace');await until(s=>s.text==='','Select all and backspace must clear phone field')
  await page.keyboard.type('Keyboard42');await page.keyboard.press('Enter');await page.keyboard.type('Z')
  await until(s=>s.text==='Keyboard42\nZ','Physical keyboard must reach phone field');checks.push({test:'keyboard, select all, backspace, Enter',result:'pass'})
  await panel.getByRole('button',{name:'返回',exact:true}).click()
  await new Promise(r=>setTimeout(r,500))
  const listStart=await point('list',.5,.8),listEnd=await point('list',.5,.2),before=(await state()).scrollY
  await page.mouse.move(listStart.x,listStart.y);await page.mouse.down();await page.mouse.move(listEnd.x,listEnd.y,{steps:20});await page.mouse.up()
  await until(s=>s.scrollY>before,'Swipe must scroll phone list');checks.push({test:'swipe scroll',result:'pass'})
  const wheel=await point('list'),wheelBefore=(await state()).scrollY
  await page.mouse.move(wheel.x,wheel.y);await page.mouse.wheel(0,300)
  await until(s=>s.scrollY>wheelBefore,'Wheel must scroll phone list');checks.push({test:'mouse wheel',result:'pass'})
  await mkdir('.build/evidence',{recursive:true})
  await panel.screenshot({path:`.build/evidence/${desktop?'desktop':'browser'}-controls.png`})
  const report={timestamp:new Date().toISOString(),desktop,checks,errors,final:await state()}
  assert.deepEqual(errors,[])
  await writeFile(`.build/evidence/${desktop?'desktop':'browser'}-controls.json`,JSON.stringify(report,null,2))
  console.log(JSON.stringify({checks,errors},null,2))
  if(!desktop){await panel.getByRole('button',{name:'断开',exact:true}).click();await browser.close()}
  process.exit(0)
}catch(error){console.error(error);console.error('PHONE_STATE',await state());await panel.screenshot({path:'.build/evidence/control-error.png'});if(!desktop)await browser.close();process.exit(1)}
