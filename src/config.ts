import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { DeviceConfig } from './device.js'
export interface Limits { maxCalls: number; timeoutMs: number }
export interface PluginConfig extends Partial<DeviceConfig> { dataDir?: string; maxCalls?: number; taskTimeoutMs?: number }
export interface Preferences { adbPath: string; maxCalls: number; taskTimeoutMs: number }
export const DEFAULT_LIMITS: Limits = { maxCalls: 100, timeoutMs: 600_000 }
export function dataDirectory(configured?: string): string { return resolve(configured || process.env.DSH_ANDROID_DATA_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'android')) }
export function limits(input: Partial<Limits>): Limits {
  const value = { ...DEFAULT_LIMITS, ...input }
  if (!Number.isInteger(value.maxCalls) || value.maxCalls < 1 || value.maxCalls > 1000 || !Number.isInteger(value.timeoutMs) || value.timeoutMs < 100 || value.timeoutMs > 3_600_000) throw new Error('任务次数须为 1–1000，时限须为 100–3600000 ms')
  return value
}
export async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}
export class PreferenceStore {
  value: Preferences = { adbPath: 'auto', maxCalls: 100, taskTimeoutMs: 600_000 }
  warning: string | null = null
  constructor(readonly directory?: string) {}
  async load(overrides: PluginConfig = {}) {
    if (this.directory) {
      await mkdir(this.directory, { recursive: true })
      try { this.value = this.validate(JSON.parse(await readFile(join(this.directory, 'settings.json'), 'utf8'))) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.warning = 'Android 设置文件无法读取，已使用默认值；原文件保留在 settings.json' }
    }
    this.value = this.validate({ ...this.value, ...(overrides.adbPath !== undefined ? { adbPath: overrides.adbPath } : {}), ...(overrides.maxCalls !== undefined ? { maxCalls: overrides.maxCalls } : {}), ...(overrides.taskTimeoutMs !== undefined ? { taskTimeoutMs: overrides.taskTimeoutMs } : {}) })
  }
  validate(input: unknown): Preferences {
    if (!input || typeof input !== 'object') throw new Error('设置格式无效')
    const item = input as Preferences
    const checked = limits({ maxCalls: item.maxCalls, timeoutMs: item.taskTimeoutMs })
    if (typeof item.adbPath !== 'string' || !item.adbPath.trim() || item.adbPath.length > 4096 || /[\r\n\0]/.test(item.adbPath)) throw new Error('ADB 路径无效')
    return { adbPath: item.adbPath.trim(), maxCalls: checked.maxCalls, taskTimeoutMs: checked.timeoutMs }
  }
  async save(input: unknown) { const value = this.validate(input); if (this.directory) await atomicJson(join(this.directory, 'settings.json'), value); this.value = value; this.warning = null; return value }
}
