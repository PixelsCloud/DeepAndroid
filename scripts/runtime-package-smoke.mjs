import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { chmod, cp, mkdir, mkdtemp, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const run = promisify(execFile)
const probe = process.argv.indexOf('--probe')
if (probe >= 0) {
  const root = process.argv[probe + 1], mode = process.argv[probe + 2]
  const { discoverAdb } = await import(pathToFileURL(join(root, 'dist/adb.js')))
  if (mode === 'damaged') {
    await assert.rejects(discoverAdb(), error => error.diagnostic.code === 'BUNDLED_RUNTIME_INVALID')
    console.log(JSON.stringify({ damagedBundleRejected: true }))
  } else {
    const adb = await discoverAdb()
    assert.equal(adb.source, 'bundled')
    assert.equal(adb.path, join(root, process.platform === 'darwin' ? 'vendor/adb/macos/adb' : 'vendor/adb/windows/adb.exe'))
    const override = await discoverAdb(adb.path)
    assert.equal(override.path, adb.path)
    const { verifyRuntimeAssets } = await import(pathToFileURL(join(root, 'dist/runtime-assets.js')))
    await verifyRuntimeAssets('scrcpy')
    const result = { adb, platform: process.platform, arch: process.arch, scrcpyVerified: true, noSdkEnvironment: true }
    if (process.platform === 'darwin') {
      assert((await stat(adb.path)).mode & 0o111, 'Executable permission must be repaired automatically')
      result.executablePermissionRepaired = true
    }
    if (mode === 'device') {
      // Use the existing shared server. Never stop/restart it or modify phone UI.
      const { DeviceService } = await import(pathToFileURL(join(root, 'dist/device.js')))
      const device = new DeviceService()
      const health = await device.diagnose()
      assert.equal(health.ok, true, JSON.stringify(health.diagnostic))
      assert.equal(health.adb.path, adb.path)
      const phone = health.devices.find(item => item.state === 'device')
      assert(phone, 'Connect and authorize a USB phone for --device')
      const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 25000)
      let session
      try {
        const apps = await device.listApps(phone.serial, abort.signal)
        assert(apps.length > 0, 'Bundled scrcpy server must run app_process on the phone')
        session = await device.open(phone.serial, abort.signal)
        let frames = 0, configurations = 0, dimensions
        while (frames < 3) {
          const { done, value } = await session.read()
          assert(!done, 'Video ended early')
          if (value.type === 'session') dimensions = [value.width, value.height]
          if (value.type === 'configuration') configurations++
          if (value.type === 'data') frames++
        }
        assert(configurations > 0)
        assert(dimensions?.every(value => value > 0))
        result.device = { model: phone.model, appCount: apps.length, dimensions, frames, configurations }
      } finally { clearTimeout(timer); abort.abort(); await session?.close() }
    }
    console.log(JSON.stringify(result))
  }
} else {
  assert(['win32','darwin'].includes(process.platform), 'This script verifies Windows and macOS bundled runtimes')
  const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version
  const archive = resolve(`.build/dsh-android-${version}.tgz`)
  await mkdir('.build/tests', { recursive: true })
  const directory = await mkdtemp(resolve('.build/tests/安装验证 no-sdk-'))
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot, 'System32/tar.exe') : '/usr/bin/tar'
  await run(tar, ['-xzf', archive, '-C', directory], { windowsHide: true })
  const root = join(directory, 'package'), cwd = join(directory, 'unrelated cwd')
  await mkdir(cwd)
  const manifest = JSON.parse(await readFile(join(root, 'vendor/runtime-manifest.json'), 'utf8'))
  for (const group of ['adb', 'adbMac', 'scrcpy']) {
    for (const name of Object.keys(manifest[group].files)) {
      assert.deepEqual(await readFile(join(root, 'vendor', name)), await readFile(new URL('../vendor/' + name, import.meta.url)))
    }
  }
  // Remove all discovery overrides, SDK roots and developer executable search paths.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|android_home|android_sdk_root|dsh_android_adb_path|java_home|jdk_home|classpath|node_path|node_options)$/i.test(key)))
  env.PATH = process.platform === 'win32' ? join(process.env.SystemRoot, 'System32') : '/usr/bin:/bin:/usr/sbin:/sbin'
  env.LOCALAPPDATA = join(directory, 'empty-localappdata')
  env.ANDROID_HOME = join(directory, 'no-sdk')
  env.ANDROID_SDK_ROOT = join(directory, 'no-sdk')
  if (process.platform === 'darwin') await chmod(join(root, 'vendor/adb/macos/adb'), 0o644)
  const invoke = async mode => {
    const { stdout } = await run(process.execPath, [fileURLToPath(import.meta.url), '--probe', root, mode], { cwd, env, windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 })
    return JSON.parse(stdout.trim())
  }
  const result = await invoke(process.argv.includes('--device') ? 'device' : 'runtime')
  const dll = join(root, process.platform === 'darwin' ? 'vendor/adb/macos/lib64/libc++.dylib' : 'vendor/adb/windows/AdbWinUsbApi.dll')
  await rename(dll, dll + '.test-backup')
  try { result.missingDll = await invoke('damaged') } finally { await rename(dll + '.test-backup', dll) }
  const exe = join(root, process.platform === 'darwin' ? 'vendor/adb/macos/adb' : 'vendor/adb/windows/adb.exe')
  await cp(exe, exe + '.test-backup')
  try {
    await writeFile(exe, 'intentionally damaged test copy')
    result.corruptAdb = await invoke('damaged')
  } finally { await rename(exe + '.test-backup', exe) }
  result.pass = true
  result.package = archive
  result.archiveSha256 = createHash('sha256').update(await readFile(archive)).digest('hex')
  result.checkedAt = new Date().toISOString()
  result.scope = 'Extracted npm tarball; no SDK/PATH discovery; package-relative binaries in Unicode/space path. JavaScript dependencies resolve from the existing test workspace. USB check only when --device is supplied.'
  await mkdir('.build/evidence', { recursive: true })
  await writeFile(`.build/evidence/runtime-package-${version.replaceAll('.','')}-${process.platform}-${process.arch}.json`, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
}
