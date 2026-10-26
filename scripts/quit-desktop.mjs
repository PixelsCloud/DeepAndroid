import { chromium } from 'playwright-core'
import { readFile } from 'node:fs/promises'
const port=(await readFile(process.env.APPDATA+'/@deepseek-ai/dsh-desktop/DevToolsActivePort','utf8')).split('\n')[0]
const browser=await chromium.connectOverCDP('http://127.0.0.1:'+port)
const session=await browser.newBrowserCDPSession()
await session.send('Browser.close')
console.log('Requested normal desktop shutdown')
process.exit(0)
