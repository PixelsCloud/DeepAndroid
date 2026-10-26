import { chromium } from 'playwright-core'
import { readFile } from 'node:fs/promises'
const port=(await readFile(process.env.APPDATA+'/@deepseek-ai/dsh-desktop/DevToolsActivePort','utf8')).split('\n')[0]
const browser=await chromium.connectOverCDP('http://127.0.0.1:'+port)
const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('dsh-app://app'))
if(page){
  const panel=page.locator('.android-panel')
  if(await panel.count()){
    const disconnect=panel.getByRole('button',{name:'断开',exact:true})
    if(await disconnect.isEnabled()){await disconnect.click();await panel.getByRole('status').filter({hasText:'已断开'}).waitFor()}
  }
  console.log('Android connection stopped before desktop update')
}
process.exit(0)
