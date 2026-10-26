import { readFile, stat, chmod, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { AndroidProblem } from './diagnostics.js'

const vendor = new URL('../vendor/', import.meta.url)
const required = {
  adb: ['adb/windows/adb.exe', 'adb/windows/AdbWinApi.dll', 'adb/windows/AdbWinUsbApi.dll', 'adb/windows/libwinpthread-1.dll', 'adb/windows/NOTICE.txt', 'adb/windows/source.properties'],
  adbMac: ['adb/macos/adb', 'adb/macos/lib64/libc++.dylib', 'adb/macos/NOTICE.txt', 'adb/macos/source.properties'],
  scrcpy: ['scrcpy-server-v5.0.1', 'SCRCPY-LICENSE'],
} as const
export function bundledAdbPath(platform = process.platform, arch = process.arch): string | undefined {
  const group = bundledAdbGroup(platform, arch)
  return group ? fileURLToPath(new URL(group === 'adb' ? 'adb/windows/adb.exe' : 'adb/macos/adb', vendor)) : undefined
}

export function bundledAdbGroup(platform = process.platform, arch = process.arch): 'adb' | 'adbMac' | undefined {
  if (platform === 'win32' && (arch === 'x64' || arch === 'ia32')) return 'adb'
  if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) return 'adbMac'
  return undefined
}

/** Windows-built npm archives may lose POSIX executable mode. Repair only verified assets. */
export async function prepareBundledAdb() {
  const group = bundledAdbGroup(), path = bundledAdbPath()
  if (!group || !path) throw new Error('当前平台没有内置 ADB')
  await verifyRuntimeAssets(group)
  if (process.platform === 'darwin') {
    try {
      const info = await stat(path)
      if (!(info.mode & 0o111)) await chmod(path, (info.mode & 0o777) | 0o111)
      await access(path, constants.X_OK)
    } catch {
      throw new AndroidProblem({ code: 'ADB_NOT_EXECUTABLE', message: '内置 ADB 缺少可执行权限', recovery: '请将完整插件安装到当前用户可写的 Harness 插件目录后重试；不会使用 sudo 或修改系统安全策略' })
    }
  }
  return path
}

/** Package-relative paths work in an installed plugin, independent of cwd or SDK/PATH. */
export async function verifyRuntimeAssets(group: keyof typeof required, root = vendor) {
  try {
    const manifest = JSON.parse(await readFile(new URL('runtime-manifest.json', root), 'utf8'))
    if (manifest.schema !== 1) throw new Error('运行文件清单格式无效')
    const entry = manifest[group]
    for (const name of required[group]) {
      const expected = entry?.files?.[name]
      if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) throw new Error(`缺少校验信息：${name}`)
      const data = await readFile(new URL(name, root))
      if (createHash('sha256').update(data).digest('hex') !== expected) throw new Error(`文件校验失败：${name}`)
    }
    return { version: String(entry.version), files: [...required[group]] }
  } catch (error) {
    throw new AndroidProblem({ code: 'BUNDLED_RUNTIME_INVALID', message: `内置 ${group === 'scrcpy' ? 'scrcpy' : 'ADB'} 运行文件缺失或损坏`, recovery: `请重新安装完整的 Android 插件包；${String((error as Error).message).slice(0, 300)}` })
  }
}
