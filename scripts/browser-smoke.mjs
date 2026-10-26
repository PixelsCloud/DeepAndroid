import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const url = process.argv[2]
assert(url, 'Pass the preview URL')
await mkdir('.build/evidence', { recursive: true })
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
const page = await browser.newPage({ viewport: { width: 480, height: 920 } })
const errors = []
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => { if (message.type() === 'error') console.error('Browser:', message.text()) })
try {
  await page.goto(url)
  await page.locator('select[aria-label="USB 手机"] option').first().waitFor({ state: 'attached' })
  assert.equal(await page.evaluate(() => typeof VideoDecoder), 'function')
  const rounds = []
  for (let round = 1; round <= 3; round++) {
    if (round > 1) await page.getByRole('button', { name: '连接手机', exact: true }).click()
    await page.waitForFunction(() => Number(document.querySelector('#root')?.dataset.framesRendered) >= 5, null, { timeout: 25000 })
    const result = await page.evaluate(() => ({
      firstFrameMs: Number(document.querySelector('#root').dataset.firstFrameMs),
      frames: Number(document.querySelector('#root').dataset.framesRendered),
      width: document.querySelector('canvas').width,
      height: document.querySelector('canvas').height,
      status: document.querySelector('[data-panel=phone] [role=status]').textContent,
      meta: document.querySelector('.android-meta').textContent,
    }))
    assert(result.width > 0 && result.height > 0)
    rounds.push({ round, ...result })
    if (round === 3) await page.screenshot({ path: '.build/evidence/browser-live.png' })
    await page.getByRole('button', { name: '断开', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '已断开' }).waitFor()
    assert.equal(await page.locator('canvas').count(), 0)
  }
  assert.deepEqual(errors, [])
  await writeFile('.build/evidence/browser-smoke.json', JSON.stringify({ url, rounds, errors }, null, 2))
  console.log(JSON.stringify({ rounds, errors }, null, 2))
  console.log('PASS: browser WebCodecs rendering, disconnect and reconnect (3 rounds)')
} finally { await browser.close() }
