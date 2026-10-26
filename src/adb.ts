import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stat } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { AndroidProblem } from './diagnostics.js'
const run = promisify(execFile)
export interface AdbInstallation { path: string; version: string }
export function adbCandidates(configured = 'auto', env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  if (configured && configured !== 'auto' && configured !== 'adb') return [configured]
  if (env.DSH_ANDROID_ADB_PATH) return [env.DSH_ANDROID_ADB_PATH]
  const executable = platform === 'win32' ? 'adb.exe' : 'adb'
  const roots = [env.ANDROID_SDK_ROOT, env.ANDROID_HOME, env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Android', 'Sdk') : undefined]
  return [...new Set(['adb', ...roots.filter((root): root is string => Boolean(root)).map(root => join(root, 'platform-tools', executable))])]
}
export async function discoverAdb(configured = 'auto', env = process.env): Promise<AdbInstallation> {
  const candidates = adbCandidates(configured, env)
  let executableFound = false
  for (const candidate of candidates) {
    if (isAbsolute(candidate) && !(await stat(candidate).catch(() => undefined))?.isFile()) continue
    try {
      const { stdout } = await run(candidate, ['version'], { windowsHide: true, timeout: 4000, maxBuffer: 65536 })
      executableFound = true
      if (!/Android Debug Bridge version/i.test(stdout)) continue
      const installed = stdout.match(/^Installed as (.+)$/m)?.[1]?.trim()
      return { path: installed || candidate, version: stdout.split(/\r?\n/).filter(line => /Debug Bridge version|^Version /i.test(line)).join(' · ') }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') executableFound = true }
  }
  throw new AndroidProblem({ code: executableFound ? 'ADB_UNUSABLE' : 'ADB_MISSING', message: executableFound ? '已找到 ADB，但无法正常运行' : '没有找到 Android ADB', recovery: '安装 Android Platform-Tools，或在连接诊断中设置 adb 可执行文件的完整路径；也支持 ANDROID_HOME、ANDROID_SDK_ROOT 和 DSH_ANDROID_ADB_PATH' })
}
