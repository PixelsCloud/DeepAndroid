import { chromium } from 'playwright-core'
import { readFile } from 'node:fs/promises'
const port=(await readFile(process.env.APPDATA+'/@deepseek-ai/dsh-desktop/DevToolsActivePort','utf8')).split('\n')[0]
const browser=await chromium.connectOverCDP('http://127.0.0.1:'+port)
const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('dsh-app://app'))
if(!page)throw new Error('Harness window not ready')
await page.getByRole('button',{name:'Android',exact:true}).waitFor({timeout:30000})
if(!await page.locator('.android-panel').count())await page.getByRole('button',{name:'Android',exact:true}).click()
const panel=page.locator('.android-panel')
await panel.getByRole('button',{name:'主页',exact:true}).waitFor()
await panel.locator('select[aria-label="USB 手机"] option').first().waitFor({state:'attached'})
if(await panel.getByRole('button',{name:'连接手机',exact:true}).isEnabled())await panel.getByRole('button',{name:'连接手机',exact:true}).click()
await page.waitForFunction(()=>Number(document.querySelector('.android-panel')?.parentElement?.dataset.framesRendered)>=5,null,{timeout:25000})
console.log(await panel.innerText())
await page.bringToFront()
process.exit(0)
