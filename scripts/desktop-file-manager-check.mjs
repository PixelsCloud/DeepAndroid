import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chromium } from 'playwright-core'

const tag = process.argv[2] ?? '170'
assert(/^\d{3}$/.test(tag))
const version = JSON.parse(await readFile('package.json', 'utf8')).version
const port = (await readFile('.build/evidence/desktop-' + tag + '-port.txt', 'utf8')).trim()
assert(/^\d+$/.test(port))
const origin = 'http://127.0.0.1:' + port
const headers = { 'x-android-client': '1', 'content-type': 'application/json' }
async function api(path, value) {
  const response = await fetch(origin + '/x-android' + path, { method: value ? 'POST' : 'GET', headers, body: value ? JSON.stringify(value) : undefined })
  assert(response.ok, path + ': ' + response.status)
  return response.json()
}
const health = await api('/health'), records = await api('/records'), saved = (await api('/panel-state')).state
assert.equal(health.pluginVersion, version)
assert.equal(health.owner, null)
assert(!records.tasks.some(task => task.status === 'running'))
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
const page = await browser.newPage({ viewport: { width: 840, height: 1000 }, extraHTTPHeaders: headers }), errors = []
page.on('pageerror', error => errors.push(error.message))
try {
  await page.goto(origin + '/x-android/health')
  await page.setContent('<!doctype html><style>html,body{margin:0;height:100%;background:#15191e;color:white}#root{height:100%}</style><div id="root"></div><script type="module">import{mountPanel}from"/x-android/ui.js";window.disposePanel=mountPanel(document.getElementById("root"))</script>')
  await page.getByRole('tab', { name: '手机', exact: true }).click()
  await page.getByRole('button', { name: '连接手机', exact: true }).waitFor()
  if (!(await api('/health')).viewers) await page.getByRole('button', { name: '连接手机', exact: true }).click()
  await page.waitForFunction(() => Number(document.getElementById('root')?.dataset.framesRendered) > 0, null, { timeout: 30000 })
  await page.getByRole('tab', { name: '文件', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.android-files-root')?.dataset.loaded === 'true')
  assert.equal(await page.getByRole('button', { name: '上传文件', exact: true }).isDisabled(), false)
  assert.equal(await page.getByRole('combobox', { name: '文件管理设备' }).inputValue(), 'e2b3b128')
  await page.getByRole('tab', { name: '手机', exact: true }).click()
  const check = await promisify(execFile)(process.execPath, ['scripts/desktop-delivery-check.mjs', 'after', port, tag], { windowsHide: true, timeout: 30000 })
  assert.deepEqual(errors, [])
  await writeFile('.build/evidence/desktop-' + tag + '-file-manager.json', JSON.stringify({ pass: true, port, version, checks: ['Normal Desktop backend serves the new Files UI and reads the actual phone directory', 'Phone video decodes in an owned Chrome viewer against that same Desktop backend', 'All original report/screenshot/profile hashes survive the normal Desktop restart'], delivery: JSON.parse(check.stdout), errors, scope: 'Owned headless Chrome mounts the normal Desktop backend plugin. This does not claim automation of the native Electron window. No chat, model call or phone mutation; original panel preferences are restored.' }, null, 2))
  console.log(check.stdout.trim())
} finally {
  await browser.close()
  await api('/panel-state', saved)
}
