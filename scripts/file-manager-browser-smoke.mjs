import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { directoryPage } from '../dist/file-manager-model.js'

await mkdir('.build/tests', { recursive: true })
await mkdir('.build/evidence', { recursive: true })
const directory = await mkdtemp(join(process.cwd(), '.build/tests/file-manager-browser-'))
await build({ stdin: { contents: 'export {mountFileManager} from "./src/browser-file-manager.ts"; export {mountToasts} from "./src/browser-toast.ts"', resolveDir: process.cwd() }, outfile: join(directory, 'files.js'), bundle: true, platform: 'browser', format: 'esm', target: 'chrome130' })
const requests = [], jobs = [], checks = [], errors = [], uploads = []
let releaseRead, blocked, failDirectory = false, extra = false, unsafe = false
const entry = (path, type = 'file') => ({ name: path.split('/').at(-1), path, type, bytes: 10, mtime_seconds: '1', modified_at: '2026-10-26T00:00:00Z', version: type + ':10:1' })
const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const read = async () => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks) }
  if (url.pathname === '/files.js') { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(join(directory, 'files.js'))); return }
  if (url.pathname === '/x-android/devices') return json(res, { devices: ['a', 'b'].map(serial => ({ serial, model: 'Phone ' + serial, state: 'device' })) })
  if (url.pathname === '/x-android/file-manager/places') { if (req.method === 'POST') await read(); return json(res, { places: {}, lastSerial: null }) }
  if (url.pathname === '/x-android/file-manager/directory') {
    const serial = url.searchParams.get('serial'), path = url.searchParams.get('path')
    requests.push({ serial, path })
    if (blocked?.serial === serial && blocked.path === path) { const own = blocked; blocked = null; own.started(); await new Promise(resolve => { releaseRead = resolve }) }
    if (failDirectory) return json(res, { error: '设备连接已断开（测试注入）' }, 500)
    const entries = path === '/sdcard/Download' ? [entry(path + '/' + serial + '.txt'), entry(path + '/demo.apk'), entry(path + '/folder', 'directory'), ...(extra ? [entry(path + '/new.txt')] : []), ...(unsafe ? [entry(path + '/<img src=x onerror=window.__fmInjected=true>.txt')] : [])] : []
    return json(res, directoryPage(serial, path, entries, false, {}))
  }
  if (url.pathname === '/x-android/file-manager/jobs' && req.method === 'GET') return json(res, { jobs, transfers: [], recordings: [] })
  if (url.pathname === '/x-android/file-upload' && req.method === 'POST') { uploads.push(await read()); return json(res, { id: randomUUID() }) }
  if (url.pathname === '/x-android/file-manager/jobs' && req.method === 'POST') {
    const input = JSON.parse(await read()), job = { ...input, id: randomUUID(), started_at: new Date().toISOString(), status: input.operation === 'install' ? 'failed' : 'completed', phase: 'finished', ...(input.operation === 'install' ? { error: 'INSTALL_FAILED_USER_RESTRICTED' } : {}) }
    jobs.unshift(job); return json(res, job, 202)
  }
  if (url.pathname.startsWith('/x-android/file-manager/jobs/')) return json(res, jobs.find(job => job.id === url.pathname.split('/').at(-1)))
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end('<!doctype html><style>html,body{margin:0;background:#15191e;color:#e4e8eb;height:100%}#root{height:100%;padding:16px;box-sizing:border-box}*{box-sizing:border-box}button{background:transparent;color:inherit;border:1px solid #8885;border-radius:7px;padding:7px}button:disabled{opacity:.4}</style><div id="root" class="android-files-root"></div><script type="module">import{mountFileManager,mountToasts}from"/files.js";mountToasts(document.getElementById("root"));window.files=mountFileManager(document.getElementById("root"),()=>"");window.files.show(true)</script>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
const page = await browser.newPage({ viewport: { width: 840, height: 960 } })
page.on('pageerror', error => errors.push(error.message))
async function until(test) { for (let n = 0; n < 200; n++) { if (await test()) return; await delay(25) } throw Error('Browser acceptance condition timed out: ' + test) }
const loaded = serial => page.waitForFunction(serial => { const root = document.getElementById('root'); return root.dataset.currentSerial === serial && root.dataset.loaded === 'true' }, serial)
function block(serial, path) { let started; const pending = new Promise(resolve => { started = resolve }); blocked = { serial, path, started }; return pending }
async function menu(name) { await page.getByRole('button', { name: '更多操作', exact: true }).click(); await page.getByRole('menuitem', { name, exact: true }).click() }
try {
  await page.goto('http://127.0.0.1:' + server.address().port)
  await page.getByRole('option', { name: '请选择手机' }).waitFor({ state: 'attached' })
  assert.equal(requests.length, 0)
  await page.getByRole('combobox', { name: '文件管理设备' }).selectOption('a'); await loaded('a')
  checks.push('Two authorized devices require explicit selection; directory access works without video or phone-page selection')

  const initialRead = block('a', '/sdcard/Download')
  await page.getByRole('button', { name: '刷新目录' }).click(); await initialRead
  await page.getByRole('combobox', { name: '文件管理设备' }).selectOption('b'); await loaded('b')
  releaseRead(); await delay(100)
  assert.equal(await page.getByRole('button', { name: 'a.txt', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'b.txt', exact: true }).count(), 1)
  checks.push('Delayed old-device directory response cannot overwrite the selected device or its entries')

  await page.getByRole('checkbox', { name: '选择 b.txt', exact: true }).check()
  const pickerRead = block('b', '/sdcard/Download')
  await menu('复制到…'); await pickerRead
  const dialog = page.getByRole('dialog', { name: '复制到…' })
  await dialog.getByRole('textbox', { name: '目标文件夹', exact: true }).fill('/sdcard/Pictures')
  releaseRead(); await delay(100)
  assert.equal(await dialog.getByRole('textbox', { name: '目标文件夹', exact: true }).inputValue(), '/sdcard/Pictures')
  await dialog.getByRole('button', { name: '前往', exact: true }).click()
  await dialog.getByText('目标：/sdcard/Pictures', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: '选择此目录', exact: true }).click()
  await until(() => jobs.some(job => job.operation === 'copy'))
  assert.equal(jobs.find(job => job.operation === 'copy').destination, '/sdcard/Pictures/b.txt')
  checks.push('Folder picker preserves user-edited paths across a delayed initial listing and commits the explicitly visited destination')

  const transfer = await page.evaluateHandle(() => { const data = new DataTransfer(); data.items.add(new File(['drag bytes'], '拖放文件.txt', { type: 'text/plain' })); return data })
  await page.locator('.fm').dispatchEvent('drop', { dataTransfer: transfer })
  await until(() => jobs.some(job => job.operation === 'push'))
  assert.equal(jobs.find(job => job.operation === 'push').serial, 'b')
  assert.equal(jobs.find(job => job.operation === 'push').path, '/sdcard/Download/拖放文件.txt')
  assert.equal(uploads[0].toString(), 'drag bytes')
  checks.push('Drag-and-drop uses actual browser File bytes and pins device and destination when the upload is queued')

  await page.getByRole('checkbox', { name: '选择 b.txt', exact: true }).check()
  const backgroundRead = block('b', '/sdcard/Download')
  await page.getByRole('button', { name: '刷新目录' }).click(); await backgroundRead
  await page.getByRole('checkbox', { name: '选择 demo.apk', exact: true }).check()
  extra = true; releaseRead(); await loaded('b')
  assert.equal(await page.getByRole('checkbox', { name: '选择 b.txt', exact: true }).isChecked(), true)
  assert.equal(await page.getByRole('checkbox', { name: '选择 demo.apk', exact: true }).isChecked(), true)
  assert.equal(await page.getByRole('checkbox', { name: '选择 new.txt', exact: true }).isChecked(), false)
  const all = page.getByRole('checkbox', { name: '选择当前已加载文件', exact: true })
  await all.check(); assert.equal(await page.locator('tbody input:checked').count(), 4)
  await all.uncheck(); assert.equal(await page.locator('tbody input:checked').count(), 0)
  checks.push('Selection changes made during refresh survive unchanged entry versions; new files stay unselected; stable select-all and clear-all work')
  unsafe = true; await page.getByRole('button', { name: '刷新目录' }).click(); await loaded('b'); await page.getByRole('button', { name: '<img src=x onerror=window.__fmInjected=true>.txt', exact: true }).waitFor(); assert.equal(await page.locator('tbody img').count(), 0); assert.equal(await page.evaluate(() => window.__fmInjected), undefined); checks.push('HTML-looking names from a directory listing are text only and cannot inject DOM or run handlers')

  await page.getByRole('checkbox', { name: '选择 demo.apk', exact: true }).check()
  await menu('安装 APK')
  await page.getByRole('dialog', { name: '安装 APK' }).getByRole('button', { name: '取消', exact: true }).click()
  assert(!jobs.some(job => job.operation === 'install'))
  await menu('安装 APK')
  await page.getByRole('dialog', { name: '安装 APK' }).getByRole('button', { name: '开始安装', exact: true }).click()
  await until(() => jobs.some(job => job.operation === 'install'))
  assert.equal(jobs.find(job => job.operation === 'install').path, '/sdcard/Download/demo.apk')
  await page.getByText(/INSTALL_FAILED_USER_RESTRICTED/).waitFor()
  checks.push('APK installation requires explicit confirmation, binds the selected phone path and displays the actual service refusal')

  failDirectory = true
  await page.getByRole('button', { name: '刷新目录' }).click()
  await page.getByText('无法读取此目录', { exact: true }).waitFor()
  assert.equal(await page.locator('tbody input').count(), 0)
  assert.equal(await page.getByRole('button', { name: '上传文件', exact: true }).isDisabled(), true)
  assert.equal(await page.getByText('这个文件夹是空的', { exact: true }).count(), 0)
  checks.push('Injected device disconnection clears stale entries and selection, displays a read error and prevents uploads to an unreadable target')
  assert.deepEqual(errors, [])
  await writeFile('.build/evidence/file-manager-browser-smoke.json', JSON.stringify({ pass: true, checks, errors, scope: 'Owned Chrome with full FileManager browser module and explicit HTTP fixtures. Race, multi-device and disconnection checks are injected; these do not claim physical USB disconnect or a second real phone.' }, null, 2))
  console.log('PASS file manager browser races: ' + checks.length)
} finally {
  releaseRead?.(); await browser.close(); await new Promise(resolve => server.close(resolve))
}
