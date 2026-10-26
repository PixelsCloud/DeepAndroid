import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { bundledAdbPath, bundledAdbGroup, verifyRuntimeAssets } from '../dist/runtime-assets.js'

test('shipped ADB, required DLLs, notices and scrcpy match the runtime manifest', async () => {
  assert.equal((await verifyRuntimeAssets('adb')).version, '37.0.1-15733141')
  assert.equal((await verifyRuntimeAssets('scrcpy')).version, '5.0.1')
  assert.equal((await verifyRuntimeAssets('adbMac')).version, '37.0.1')
  assert.equal(bundledAdbGroup('darwin','arm64'), 'adbMac')
  assert.equal(bundledAdbGroup('darwin','x64'), 'adbMac')
  assert.equal(bundledAdbPath('darwin','arm64'), bundledAdbPath('darwin','x64'))
  assert(bundledAdbPath('darwin','arm64').replaceAll('\\','/').endsWith('/vendor/adb/macos/adb'))
  assert.equal(bundledAdbPath('win32','arm64'), undefined)
  assert(bundledAdbPath('win32','x64').endsWith('adb.exe'))
})

test('macOS ADB and its bundled library contain Intel and Apple Silicon native slices', async () => {
  for (const name of ['adb', 'lib64/libc++.dylib']) {
    const data = await readFile(new URL('../vendor/adb/macos/' + name, import.meta.url))
    assert.equal(data.readUInt32BE(0), 0xcafebabe, 'Expected universal Mach-O: ' + name)
    assert.equal(data.readUInt32BE(4), 2)
    const architectures = []
    for (let index = 0; index < 2; index++) {
      const entry = 8 + index * 20, cpu = data.readUInt32BE(entry)
      const offset = data.readUInt32BE(entry + 8), size = data.readUInt32BE(entry + 12)
      assert(offset + size <= data.length)
      assert.equal(data.readUInt32LE(offset), 0xfeedfacf)
      assert.equal(data.readUInt32LE(offset + 4), cpu)
      architectures.push(cpu)
    }
    assert.deepEqual(architectures.sort(), [0x1000007, 0x100000c])
  }
})

test('macOS selection cannot validate against the Windows manifest or ignore a missing dylib', async t => {
  await mkdir('.build/tests', { recursive: true })
  const root = await mkdtemp(resolve('.build/tests/mac-runtime-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await cp('vendor', root, { recursive: true })
  const url = pathToFileURL(root + '/')
  await rm(join(root, 'adb/macos/lib64/libc++.dylib'))
  await assert.rejects(verifyRuntimeAssets('adbMac', url), error => error.diagnostic.code === 'BUNDLED_RUNTIME_INVALID')
  assert.equal((await verifyRuntimeAssets('adb', url)).version, '37.0.1-15733141')
})

test('missing DLL, corrupt executable, missing manifest entries and corrupt server prevent delivery', async t => {
  await mkdir('.build/tests', { recursive: true })
  const root = await mkdtemp(resolve('.build/tests/runtime-assets-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const url = pathToFileURL(root + '/')
  await cp('vendor', root, { recursive: true })
  const reject = group => assert.rejects(verifyRuntimeAssets(group, url), error => error.diagnostic.code === 'BUNDLED_RUNTIME_INVALID')
  await rm(join(root, 'adb/windows/AdbWinUsbApi.dll'))
  await reject('adb')
  await cp('vendor/adb/windows/AdbWinUsbApi.dll', join(root, 'adb/windows/AdbWinUsbApi.dll'))
  await writeFile(join(root, 'adb/windows/adb.exe'), 'damaged')
  await reject('adb')
  await cp('vendor/adb/windows/adb.exe', join(root, 'adb/windows/adb.exe'))
  const manifest = JSON.parse(await readFile(join(root, 'runtime-manifest.json'), 'utf8'))
  delete manifest.adb.files['adb/windows/AdbWinApi.dll']
  await writeFile(join(root, 'runtime-manifest.json'), JSON.stringify(manifest))
  await reject('adb')
  await writeFile(join(root, 'scrcpy-server-v5.0.1'), 'damaged')
  await reject('scrcpy')
})
