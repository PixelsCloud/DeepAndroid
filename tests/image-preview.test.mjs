import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdir, mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {RemoteFiles} from '../dist/remote-files.js'
import {createPanel} from '../dist/host.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
function fixture(data = png, overrides = {}) {
  let closed = 0, reads = 0, cancelled = 0
  const info = {mode: 0o100644, size: BigInt(data.length), mtime: 1n, ctime: 1n, ...overrides}
  const adb = {sync: {
    async lstat() { return {...info} },
    read() { reads++; return new ReadableStream({start(controller) {controller.enqueue(data); controller.close()}, cancel() {cancelled++}}) },
  }, async close() {closed++}}
  const remote = new RemoteFiles({client: {async createAdb({serial}) {assert.equal(serial, 'phone'); return adb}}})
  const preview = (version = '') => remote.preview('phone', '/sdcard/Pictures/test.png', version, new AbortController().signal)
  return {remote, adb, info, preview, counts: () => ({closed, reads, cancelled})}
}

test('preview reads bounded binary content with signature-derived MIME and closes ADB', async () => {
  for (const [data, mime] of [[png, 'image/png'], [Buffer.from([255,216,255,0]), 'image/jpeg'], [Buffer.from('GIF89a....'), 'image/gif'], [Buffer.from('RIFF0000WEBP'), 'image/webp']]) {
    const f = fixture(data), result = await f.preview(`file:${data.length}:1`)
    assert.equal(result.mime, mime); assert.deepEqual(result.data, data)
    assert.equal(f.counts().closed, 1)
  }
})

test('preview rejects oversized files, symlinks, stale versions and unsafe paths before reading', async () => {
  for (const [overrides, version, error] of [[{size: 21n*1024n*1024n}, '', /20 MiB/], [{mode: 0o120777}, '', /普通/], [{}, 'file:0:1', /变化/]]) {
    const f = fixture(png, overrides)
    await assert.rejects(f.preview(version), error)
    assert.equal(f.counts().reads, 0); assert.equal(f.counts().closed, 1)
  }
  const f = fixture()
  await assert.rejects(f.remote.preview('phone', '/sdcard/../secret', '', new AbortController().signal), /路径/)
  assert.equal(f.counts().closed, 0)
})

test('preview rejects disguised SVG/HTML, incomplete reads, changed files and growth beyond the limit', async () => {
  await assert.rejects(fixture(Buffer.from('<svg onload="alert(1)"></svg>')).preview(), /仅支持/)
  await assert.rejects(fixture(png, {size: 100n}).preview(), /变化/)
  const changed = fixture()
  let stat = 0
  changed.adb.sync.lstat = async () => ({...changed.info, mtime: ++stat === 1 ? 1n : 2n})
  await assert.rejects(changed.preview(), /变化/)
  const growing = fixture(Buffer.alloc(20*1024*1024+1), {size: 1n})
  await assert.rejects(growing.preview(), /20 MiB/)
  assert.equal(growing.counts().closed, 1)
})

test('aborting an in-flight preview closes its transport and rejects the read', async () => {
  const f = fixture(), abort = new AbortController()
  let controller, started
  const reading = new Promise(resolve => {started = resolve})
  f.adb.sync.read = () => new ReadableStream({start(value) {controller = value; started()}})
  f.adb.close = async () => {try {controller?.error(new Error('transport closed'))} catch {}}
  const pending = f.remote.preview('phone', '/sdcard/test.png', '', abort.signal)
  await reading; abort.abort()
  await assert.rejects(pending)
  assert(abort.signal.aborted)
})

test('preview HTTP requires client authorization and returns non-cacheable binary without a download job', async () => {
  await mkdir('.build/tests', {recursive: true})
  const dataDir = await mkdtemp(join(process.cwd(), '.build/tests/image-http-'))
  const panel = await createPanel({dataDir}), server = createServer(panel.handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/x-android/file-manager/preview?serial=phone&path=%2Fsdcard%2Ftest.png&version=file:68:1`
  const calls = []
  panel.files.remote.preview = async (...args) => {calls.push(args); return {data: png, mime: 'image/png'}}
  try {
    assert.equal((await fetch(url)).status, 403)
    assert.equal((await fetch(url, {headers: {'x-android-client': '1', origin: 'https://invalid.example'}})).status, 403)
    assert.equal(calls.length, 0)
    const res = await fetch(url, {headers: {'x-android-client': '1'}})
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/png')
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), png)
    assert.deepEqual(calls[0].slice(0,3), ['phone', '/sdcard/test.png', 'file:68:1'])
    assert.equal(panel.fileManager.list().length, 0)
    assert.equal(panel.state.state, 'idle')
  } finally {await panel.close(); await new Promise(resolve => server.close(resolve))}
})
