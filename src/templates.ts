import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicJson } from './config.js'
export interface TaskTemplate { id: string; title: string; body: string; defaults: Record<string, string>; builtin: boolean }
const builtin: TaskTemplate[] = [
  { id: 'device-info', title: '读取设备信息', body: '使用 Android 原生工具打开设置，查看 Android 版本与安全更新日期，然后返回桌面。每次动作后观察确认；整理后调用 android_save_result 保存设备信息表格及实际 observation_id 截图依据，再结束操作。', defaults: {}, builtin: true },
  { id: 'search', title: '应用内搜索', body: '使用 Android 原生工具打开“{{app}}”，在应用内搜索“{{keyword}}”，核对输入文字，整理实际可见的搜索结果，调用 android_save_result 保存实际结果与 observation_id 截图依据后，最后返回桌面。找不到入口时有限查找并说明原因，不猜测坐标。', defaults: { app: '设置', keyword: '电池' }, builtin: true },
  { id: 'ranking', title: '多屏榜单读取', body: '使用 Android 原生工具打开“{{app}}”，读取“{{list}}”前 {{count}} 条，整理排名、标题和可见热度。先观察标题锚点与可滚动区域，再跨屏读取并去重，保留每屏截图作为依据；同名条目与停止条件要核对。未读到的字段不要编造；不足 {{count}} 条就说明实际数量与缺失原因。调用 android_save_result 保存排名、标题、热度表格及实际 observation_id 截图依据，expected_count 设为 {{count}}，未读到的单元格填 null，未完成时说明原因。不要点赞、关注、发消息或修改设置，最后返回桌面。', defaults: { app: '知乎', list: '热榜', count: '20' }, builtin: true },
  {id:'detail-reading',title:'列表详情阅读',body:'使用 Android 原生工具打开“{{app}}”的“{{list}}”，先保存前 {{count}} 条的原始标题与列表选择条件，再逐条进入详情。重新观察并明确正文与滚动区域后，使用 android_read_page 有限阅读可见正文；若正文未暴露为界面文字，当前模型支持图片时可选择截图模式，亲自阅读截图并核对标题与重叠，截图采集不等于读完全文。核对重叠片段并保留每屏截图。阅读从当前画面开始；截断、连续性无法确认、仅有图片、需要登录或达到上限时，明确说明已读范围，不声称读完全文。可按实际可见的展开入口明确点击一次后重新观察。每读完一条返回列表，重新查找先前保存的标题确认位置，再进入下一条，不复用旧元素 ID 或坐标。只依据实际读到的内容整理标题、摘要、关键观点、已读范围与未完成原因，调用 android_save_result 保存一份带实际 observation_id 截图依据的报告；未读到的字段留空。最后返回桌面。',defaults:{app:'知乎',list:'热榜',count:'3'},builtin:true},
 {id:'compare-history',title:'历史结果对比',body:'先使用 android_results 查询“{{query}}”的历史结果，核对实际报告日期、设备、Agent 整理或设备原始采集来源。明确选择最新两份可比报告，用 android_read_result 读取真实内容和历史依据别名；不足两份时说明原因，不补造另一份。如果存在原始与整理版本，避免把同一轮的两个版本误当作两个时点。按实际标题对应比较新增、退出、排名或热度变化；缺失字段保留为空，不凭空推断。历史截图缺失时说明不能重新视觉核对；历史依据只能用于引用，不能用于点击手机。调用 android_save_result 另存一份对比报告，引用这轮读取返回的历史依据别名，保留原日期及对比范围，原报告不修改。',defaults:{query:'知乎热榜'},builtin:true},
]
function placeholders(body: string): string[] { return [...new Set([...body.matchAll(/\{\{([a-z][a-z0-9_]{0,31})\}\}/g)].map(match => match[1]!))] }
export class TemplateStore {
  warning: string | null = null
  private custom: TaskTemplate[] = []
  private writes = Promise.resolve()
  constructor(readonly directory?: string) {}
  async load() {
    if (!this.directory) return
    try {
      const raw = await readFile(join(this.directory, 'templates.json'), 'utf8')
      if (raw.length > 300_000) throw new Error('模板文件超过大小限制')
      const values: unknown = JSON.parse(raw)
      if (!Array.isArray(values) || values.length > 50) throw new Error('模板列表无效')
      this.custom = values.map(item => this.validate(item))
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.warning = '自定义模板无法读取，内置模板仍可使用；请检查 templates.json' }
  }
  private validate(input: unknown): TaskTemplate {
    if (!input || typeof input !== 'object') throw new Error('模板格式无效')
    const value = input as Record<string, unknown>
    if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 80 || typeof value.body !== 'string' || !value.body.trim() || value.body.length > 5000) throw new Error('模板标题最多 80 字，正文最多 5000 字，均不能为空')
    const variables = placeholders(value.body)
    if (variables.length > 8 || /\{\{|\}\}/.test(value.body.replace(/\{\{[a-z][a-z0-9_]{0,31}\}\}/g, ''))) throw new Error('最多支持 8 个 {{name}} 参数，参数名须由小写字母、数字或下划线组成')
    const id = typeof value.id === 'string' ? value.id : randomUUID()
    if (!/^[a-f0-9-]{36}$/.test(id) || builtin.some(template => template.id === id)) throw new Error('模板标识无效')
    const defaults: Record<string, string> = {}
    if (value.defaults && typeof value.defaults === 'object') for (const key of variables) {
      const entry = (value.defaults as Record<string, unknown>)[key]
      if (typeof entry === 'string' && entry.length <= 256) defaults[key] = entry
    }
    return { id, title: value.title.trim(), body: value.body, defaults, builtin: false }
  }
  list() { return structuredClone([...builtin, ...this.custom].map(template => ({ ...template, parameters: placeholders(template.body) }))) }
  render(id: string, params: Record<string, unknown>) {
    const template = [...builtin, ...this.custom].find(item => item.id === id)
    if (!template) throw new Error('任务模板不存在')
    const values: Record<string, string> = {}
    for (const key of placeholders(template.body)) {
      const value = Object.hasOwn(params, key) ? params[key] : Object.hasOwn(template.defaults, key) ? template.defaults[key] : undefined
      if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim() || String(value).length > 256 || /[\r\n\0]/.test(String(value))) throw new Error(`请填写有效的模板参数：${key}（最多 256 字）`)
      if (key === 'count' && (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 100)) throw new Error('采集数量须为 1–100')
      values[key] = String(value)
    }
    // Replace only placeholders from the authored template, never recursively interpret values.
    return { title: template.title, prompt: template.body.replace(/\{\{([a-z][a-z0-9_]{0,31})\}\}/g, (_all, key: string) => values[key]!) }
  }
  save(input: unknown) {
    const operation = this.writes.then(async () => {
      const template = this.validate(input)
      const index = this.custom.findIndex(item => item.id === template.id)
      if (index < 0 && this.custom.length >= 50) throw new Error('最多保存 50 个自定义模板')
      const next = [...this.custom]; if (index < 0) next.push(template); else next[index] = template
      if (this.directory) await atomicJson(join(this.directory, 'templates.json'), next)
      this.custom = next
      this.warning = null
      return template
    })
    this.writes = operation.then(() => {}, () => {})
    return operation
  }
  async flush() { await this.writes }
}
