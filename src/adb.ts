import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stat } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { AndroidProblem } from './diagnostics.js'
import { bundledAdbPath, prepareBundledAdb } from './runtime-assets.js'
const run = promisify(execFile)
export interface AdbInstallation { path: string; version: string; source?: 'bundled' | 'external' }
export function adbCandidates(configured = 'auto', env: NodeJS.ProcessEnv = process.env, platform = process.platform, arch = process.arch): string[] {
  if (configured && configured !== 'auto' && configured !== 'adb') return [configured]
  if (env.DSH_ANDROID_ADB_PATH) return [env.DSH_ANDROID_ADB_PATH]
  const executable = platform === 'win32' ? 'adb.exe' : 'adb'
  const standardSdk = platform === 'darwin' && env.HOME ? join(env.HOME, 'Library', 'Android', 'sdk')
    : platform === 'win32' && env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Android', 'Sdk') : undefined
  const roots = [env.ANDROID_SDK_ROOT, env.ANDROID_HOME, standardSdk]
  const bundled = bundledAdbPath(platform, arch)
  return [...new Set([...(bundled ? [bundled] : []), 'adb', ...roots.filter((root): root is string => Boolean(root)).map(root => join(root, 'platform-tools', executable))])]
}
export async function discoverAdb(configured = 'auto', env = process.env): Promise<AdbInstallation> {
  const candidates = adbCandidates(configured, env)
  let executableFound = false
  for (const candidate of candidates) {
    const bundled = candidate === bundledAdbPath()
    if (bundled) await prepareBundledAdb()
    if (isAbsolute(candidate) && !(await stat(candidate).catch(() => undefined))?.isFile()) continue
    try {
      const { stdout } = await run(candidate, ['version'], { windowsHide: true, timeout: 4000, maxBuffer: 65536, env })
      executableFound = true
      if (!/Android Debug Bridge version/i.test(stdout)) throw new Error('ADB 版本输出无效')
      const installed = stdout.match(/^Installed as (.+)$/m)?.[1]?.trim()
      return { path: bundled ? candidate : installed || candidate, version: stdout.split(/\r?\n/).filter(line => /Debug Bridge version|^Version /i.test(line)).join(' · '), source: bundled ? 'bundled' : 'external' }
    } catch (error) {
      if (bundled) throw new AndroidProblem({ code: 'ADB_UNUSABLE', message: '内置 ADB 无法正常运行', recovery: process.platform === 'darwin' ? '请检查 macOS 的系统设置 → 隐私与安全性中的阻止提示，以及系统与 Harness 的兼容性；重新安装完整插件后重试。不会自动移除隔离属性或绕过 Gatekeeper' : '请检查系统是否拦截了插件内的 adb.exe 或 DLL，并重新安装完整插件；高级用户也可在连接设置中指定 ADB 路径' })
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') executableFound = true
    }
  }
  throw new AndroidProblem({ code: executableFound ? 'ADB_UNUSABLE' : 'ADB_MISSING', message: executableFound ? '已找到 ADB，但无法正常运行' : '没有找到 Android ADB', recovery: '自定义 ADB 请核对路径；将连接设置恢复为 auto 可使用 Windows x64/x86 或 macOS Intel/Apple Silicon 包内 ADB。其他平台需安装 Android Platform-Tools 或设置 DSH_ANDROID_ADB_PATH' })
}
