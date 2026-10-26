import { chromium } from 'playwright-core'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import assert from 'node:assert/strict'
const port = (await readFile(process.env.APPDATA + '/@deepseek-ai/dsh-desktop/DevToolsActivePort', 'utf8')).split('\n')[0]
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith('dsh-app://app'))
assert(page, 'Harness Desktop page not found')
const panel = page.locator('.android-panel')
await panel.waitFor()
const rounds = []
for (let round = 1; round <= 3; round++) {
  if (round > 1) {
    await panel.getByRole('button', { name: '断开', exact: true }).click()
    await panel.getByRole('status').filter({ hasText: '已断开' }).waitFor()
    assert.equal(await panel.locator('canvas').count(), 0)
    await panel.getByRole('button', { name: '连接手机', exact: true }).click()
  }
  await page.waitForFunction(() => Number(document.querySelector('.android-panel')?.parentElement?.dataset.framesRendered) >= 5, null, { timeout: 25000 })
  const result = await panel.evaluate(el => ({
    frames: Number(el.parentElement.dataset.framesRendered),
    firstFrameMs: Number(el.parentElement.dataset.firstFrameMs),
    status: el.querySelector('[data-panel=phone] [role=status]').textContent,
    width: el.querySelector('canvas').width,
    height: el.querySelector('canvas').height,
    meta: el.querySelector('.android-meta').textContent,
  }))
  assert(result.width > 0 && result.height > 0)
  rounds.push({ round, ...result })
}
await mkdir('.build/evidence', { recursive: true })
await panel.screenshot({ path: '.build/evidence/harness-desktop-live.png' })
const report = { timestamp: new Date().toISOString(), harness: '0.2.1-rc.2', url: page.url(), originalPixelsButtonPresent: await page.getByRole('button', { name: 'Pixels Agent Bridge', exact: true }).count() > 0, rounds, finalState: 'streaming' }
await writeFile('.build/evidence/desktop-smoke.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
// Drop only this probe's CDP connection, leaving the user's window and live view open.
process.exit(0)
