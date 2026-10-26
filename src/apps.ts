export interface AndroidApp { name: string; package_name: string; system: boolean }
export const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/
export const normalizeName = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US')

/** Parse scrcpy 5.0.1's fixed 30-character name column and wrapped long labels. */
export function parseApps(output: string): AndroidApp[] {
  if (output.length > 2 * 1024 * 1024 || !output.includes('List of apps:')) throw new Error('手机未返回有效的启动器应用列表')
  const apps = new Map<string, AndroidApp>()
  let pending: { name: string; system: boolean } | undefined
  const add = (name: string, packageName: string, system: boolean) => {
    name = name.replace(/\s+/g, ' ').trim()
    if (name && PACKAGE_NAME.test(packageName)) apps.set(packageName, { name: name.slice(0, 256), package_name: packageName, system })
  }
  for (const line of output.replaceAll('\r', '').split('\n')) {
    const head = line.match(/^ ([*-]) (.*)$/)
    if (head) {
      const system = head[1] === '*', text = head[2]!
      const packageName = text.slice(31).trim()
      if (text[30] === ' ' && PACKAGE_NAME.test(packageName)) { add(text.slice(0, 30), packageName, system); pending = undefined }
      else pending = { name: text, system }
    } else if (pending) {
      const continuation = line.match(/^\s{31,}(\S+)\s*$/)
      if (continuation) { add(pending.name, continuation[1]!, pending.system); pending = undefined }
      else if (line.trim()) pending = undefined
    }
  }
  if (apps.size > 2000) throw new Error('应用列表超过处理上限')
  return [...apps.values()].sort((a, b) => a.name.localeCompare(b.name) || a.package_name.localeCompare(b.package_name))
}

export function appMatches(app: AndroidApp, query: string): boolean {
  const value = normalizeName(query)
  return normalizeName(app.name).includes(value) || app.package_name.toLowerCase().includes(value)
}
export function resolveApp(apps: AndroidApp[], name: string) {
  const normalized = normalizeName(name)
  if (!normalized || normalized.length > 256) throw new Error('应用名称长度须在 1–256 之间')
  const exact = apps.filter(app => normalizeName(app.name) === normalized)
  if (exact.length === 1) return { status: 'resolved' as const, app: exact[0]! }
  const candidates = (exact.length ? exact : apps.filter(app => appMatches(app, name))).slice(0, 20)
  return { status: exact.length > 1 ? 'ambiguous' as const : 'not_found' as const, candidates, guidance: '未启动任何应用。请从候选应用确认名称或使用明确的 package_name；不要猜包名或默认选择第一项。' }
}
