import { chromium } from 'playwright-core'
import { readFile } from 'node:fs/promises'
const port = (await readFile(process.env.APPDATA + '/@deepseek-ai/dsh-desktop/DevToolsActivePort', 'utf8')).split('\n')[0]
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
for (const page of browser.contexts().flatMap(context => context.pages())) {
  console.log('PAGE', page.url(), await page.title())
  console.log((await page.locator('body').innerText()).slice(0, 7000))
  console.log('ANDROID', await page.getByRole('button', { name: 'Android', exact: true }).count())
}
process.exit(0)
