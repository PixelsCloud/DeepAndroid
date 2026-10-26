import type { TaskRecord } from './tasks.js'
import type { TaskTemplate } from './templates.js'
interface Template extends TaskTemplate { parameters: string[] }
const headers = { 'content-type': 'application/json', 'x-android-client': '1' }
/** Diagnostics, local records and task drafts share the existing Harness panel. */
export function mountManagement(root: HTMLElement): () => void {
  root.innerHTML = `<style>
    .android-management{font:12px/1.5 system-ui;color:inherit}.android-management nav{display:flex;gap:6px;flex-wrap:wrap}.android-management button,.android-management input,.android-management textarea,.android-management select{font:inherit;border:1px solid #8885;border-radius:6px;padding:6px 8px;background:transparent;color:inherit}.android-management button{cursor:pointer}.android-management button:disabled{opacity:.5;cursor:default}.android-management [data-view]{padding:10px 0}.android-management label{display:flex;flex-direction:column;gap:4px;margin:7px 0}.android-management textarea{width:100%;resize:vertical;min-height:90px}.android-management .note{color:#929b9a;white-space:pre-wrap;overflow-wrap:anywhere}.android-management .problem{color:#e68f8f;white-space:pre-wrap}.android-management .record-list{max-height:170px;overflow:auto;display:flex;flex-direction:column;gap:5px}.android-management .record-detail{max-height:340px;overflow:auto}.android-management .record-step{border-top:1px solid #8883;padding:7px 0;overflow-wrap:anywhere}.android-management img{max-width:100%;max-height:380px;display:block;margin:8px auto}.android-management pre{white-space:pre-wrap;font:11px/1.5 ui-monospace,monospace}.android-management [aria-pressed=true]{border-color:#168468}
  </style><div class="android-management"><nav><button data-tab="doctor">连接诊断</button><button data-tab="records">任务记录</button><button data-tab="templates">常用任务</button></nav>
  <p class="problem" role="note" data-management-error hidden></p>
  <section data-view="doctor" hidden><button data-action="diagnose">重新诊断</button><div data-doctor-report class="note"></div><details><summary>连接与任务设置</summary><label><span>启动时恢复手机侧栏</span><input data-setting="autoOpen" type="checkbox"></label><label>ADB 路径<input data-setting="adbPath" placeholder="auto：自动查找"></label><label>每项任务最多调用次数<input data-setting="maxCalls" type="number" min="1" max="1000"></label><label>任务时限（秒）<input data-setting="timeout" type="number" min="0.1" max="3600" step="0.1"></label><button data-action="save-settings">保存设置</button><p class="note">限额用于新任务。修改 ADB 路径前请先断开手机。</p></details></section>
  <section data-view="records" hidden><button data-action="refresh-records">刷新记录</button><p class="note">记录保存在本机。本面板的文字输入参数仅记长度；截图复用 Harness 附件。</p><div class="record-list"></div><div class="record-detail"></div></section>
  <section data-view="templates" hidden><label>任务模板<select data-template></select></label><div data-parameters></div><button data-action="render-template">生成任务</button><label>任务草稿<textarea data-prompt rows="5" aria-label="手机任务草稿"></textarea></label><button data-action="copy-prompt">复制到剪贴板</button><p class="note" data-template-note>生成后复制到 Harness 聊天，粘贴并发送即可执行。</p><details><summary>保存自定义模板</summary><label>标题<input data-template-title maxlength="80"></label><label>模板正文<textarea data-template-body maxlength="5000" placeholder="例如：打开 {{app}}，搜索 {{keyword}}"></textarea></label><button data-action="save-template">保存模板</button></details></section></div>`
  function get<T extends Element>(selector: string): T { const value = root.querySelector<T>(selector); if (!value) throw new Error(selector); return value }
  const error = get<HTMLElement>('[data-management-error]'), abort = new AbortController()
  let disposed = false, active = '', templates: Template[] = [], selected = '', detailRevision = ''
  const urls = new Set<string>()
  const report = (value: unknown) => { if (!disposed) { error.hidden = false; error.textContent = value instanceof Error ? value.message : String(value) } }
  async function api<T>(path: string, input?: object): Promise<T> {
    const response = await fetch('/x-android' + path, { method: input ? 'POST' : 'GET', headers, body: input ? JSON.stringify(input) : undefined, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]) })
    const value = await response.json()
    if (!response.ok) throw new Error([value.error, value.recovery].filter(Boolean).join('。') || '请求失败')
    return value as T
  }
  const run = (work: () => Promise<void>) => { error.hidden = true; void work().catch(value => { if (!disposed) report(value) }) }
  function text(parent: Element, value: string, tag = 'p', className = '') { const item = document.createElement(tag); item.textContent = value; item.className = className; parent.appendChild(item); return item }
  async function settings() {
    const panel=await api<{state:{autoOpen:boolean}}>('/panel-state');if(!disposed)get<HTMLInputElement>('[data-setting=autoOpen]').checked=panel.state.autoOpen
    const value = await api<{ adbPath: string; maxCalls: number; taskTimeoutMs: number }>('/settings')
    if (disposed) return
    get<HTMLInputElement>('[data-setting=adbPath]').value = value.adbPath
    get<HTMLInputElement>('[data-setting=maxCalls]').value = String(value.maxCalls)
    get<HTMLInputElement>('[data-setting=timeout]').value = String(value.taskTimeoutMs / 1000)
  }
  async function doctor() {
    const value = await api<{ pluginVersion: string; diagnostic: { code: string; message: string; recovery: string }; adb: { path: string; version: string } | null; runtime: { state: string; mode: string }; storage: { directory: string | null; warning: string | null }; lastObservedModel: { model: string; image_input: boolean } | null }>('/doctor')
    if (disposed) return
    const area = get<HTMLElement>('[data-doctor-report]'); area.replaceChildren()
    text(area, value.diagnostic.message, 'p'); text(area, value.diagnostic.recovery, 'p')
    text(area, `插件 ${value.pluginVersion} · 画面：${value.runtime.state === 'streaming' ? '已连接' : '未连接'} · 可直接操作`)
    if (value.adb) { text(area, value.adb.version); text(area, `ADB：${value.adb.path}`) }
    if (value.lastObservedModel) text(area, `上次任务模型：${value.lastObservedModel.model} · ${value.lastObservedModel.image_input ? '声明支持图片' : '使用界面元素；识图需选择图片模型'}`)
    else text(area, '模型兼容性在对话首次调用手机工具后确认。')
    if (value.storage.directory) text(area, `本机记录目录：${value.storage.directory}`)
    if (value.storage.warning) text(area, value.storage.warning, 'p', 'problem')
  }
  const statuses: Record<string, string> = { running: '执行中', completed: '已结束', cancelled: '已取消', interrupted: '已中断', limited: '达到限额', unknown: '结果待确认' }
  const names: Record<string, string> = { android_tap_target: '定位并点击', android_wait: '等待界面', android_scroll_find: '跨屏查找', android_read_page:'正文阅读',android_read_list: '跨屏读取', android_devices: '查看设备', android_apps: '查看应用', android_open_app: '打开应用', android_observe: '观察画面', android_find: '查找目标', android_tap: '点击', android_swipe: '滑动', android_input_text: '输入文字', android_key: '手机按键', android_bind: '绑定手机', android_release: '释放控制' }
  async function detail(id: string) {
    const task = await api<TaskRecord>('/records/' + encodeURIComponent(id))
    if (disposed || id !== selected) return
    const revision = JSON.stringify([task.status, task.reason, task.operations.map(operation => [operation.id, operation.status, operation.outcome])])
    if (detailRevision === revision) return
    detailRevision = revision
    for (const url of urls) URL.revokeObjectURL(url); urls.clear()
    const area = get<HTMLElement>('.record-detail'); area.replaceChildren()
    text(area, `${statuses[task.status] ?? task.status} · ${task.calls}/${task.limits.maxCalls} 次调用`)
    if (task.reason) text(area, task.reason, 'p', 'problem')
    for (const operation of task.operations.slice(-30)) {
      const row = document.createElement('div'); row.className = 'record-step'; area.appendChild(row)
      text(row, `${names[operation.tool] ?? operation.tool} · ${operation.status === 'running' ? task.status === 'unknown' ? '结果未确认' : '执行中' : operation.status === 'ok' ? '已返回结果' : '失败'}${operation.durationMs !== undefined ? ` · ${operation.durationMs} ms` : ''}${operation.attempts > 1 ? ` · 尝试 ${operation.attempts} 次` : ''}`)
      if (operation.outcome) text(row, `结果：${operation.outcome}`, 'span', 'note')
      if (operation.summary) { const result = document.createElement('details'); row.appendChild(result); text(result, `执行详情${operation.summary.itemCount !== undefined ? ` · ${operation.summary.itemCount} 条` : ''}`, 'summary'); text(result,JSON.stringify(operation.summary,null,2),'pre') }
      if (operation.diagnostic) text(row, `${operation.diagnostic.message}。${operation.diagnostic.recovery}`, 'p', 'problem')
      const info = document.createElement('details'); row.appendChild(info); text(info, '操作参数', 'summary'); text(info, JSON.stringify(operation.input, null, 2), 'pre')
      for (const evidence of [...(operation.screenshot ? [{ id: operation.id, label: '查看截图' }] : []), ...(operation.pages ?? []).map(page => ({id:`${operation.id}~${page.page}`,label:`第 ${page.page} 屏依据`})), ...(operation.beforeObservation ? [{ id: operation.beforeObservation, label: '操作前截图' }] : []), ...(operation.afterObservation ? [{ id: operation.afterObservation, label: '后续观察截图' }] : [])]) {
        const button = document.createElement('button'); button.textContent = evidence.label; row.appendChild(button)
        button.onclick = () => run(async () => {
          button.disabled = true
          try {
            const response = await fetch('/x-android/evidence/' + encodeURIComponent(evidence.id), { headers: { 'x-android-client': '1' }, signal: abort.signal })
            if (!response.ok) throw new Error('截图无法读取，附件可能已被清理；操作记录仍保留')
            const url = URL.createObjectURL(await response.blob()); urls.add(url)
            if (disposed || !row.isConnected) { URL.revokeObjectURL(url); urls.delete(url); return }
            const image = document.createElement('img'); image.alt = '操作对应的手机截图'; image.src = url; row.appendChild(image)
          } finally { button.disabled = false }
        })
      }
    }
  }
  async function records() {
    const value = await api<{ tasks: (Omit<TaskRecord, 'operations'> & { operationCount: number; errors: number })[]; warning: string | null }>('/records')
    if (disposed) return
    const list = get<HTMLElement>('.record-list'); list.replaceChildren()
    if (!value.tasks.length) text(list, '暂无手机任务记录。', 'p', 'note')
    for (const task of value.tasks) {
      const button = document.createElement('button'); button.textContent = `${new Date(task.startedAt).toLocaleString()} · ${statuses[task.status] ?? task.status} · ${task.operationCount} 步${task.errors ? ` · ${task.errors} 次失败` : ''}`
      button.setAttribute('aria-pressed', String(selected === task.id)); button.onclick = () => { selected = task.id; detailRevision = ''; run(() => detail(task.id)) }; list.appendChild(button)
    }
    if (value.warning) report(value.warning)
    if (selected) await detail(selected)
  }
  function parameters() {
    const selectedTemplate = templates.find(template => template.id === get<HTMLSelectElement>('[data-template]').value)
    const area = get<HTMLElement>('[data-parameters]'); area.replaceChildren()
    if (!selectedTemplate) return
    const labels: Record<string, string> = { app: '应用名称', keyword: '搜索关键词', list: '榜单名称', count: '读取数量' }
    for (const key of selectedTemplate.parameters) {
      const label = document.createElement('label'); label.textContent = labels[key] ?? key
      const input = document.createElement('input'); input.dataset.parameter = key; input.maxLength = 256; input.value = selectedTemplate.defaults[key] ?? ''; label.appendChild(input); area.appendChild(label)
    }
    get<HTMLTextAreaElement>('[data-template-body]').value = selectedTemplate.body
    get<HTMLInputElement>('[data-template-title]').value = selectedTemplate.title
  }
  async function loadTemplates(preferred?: string) {
    const value = await api<{ templates: Template[]; warning: string | null }>('/templates')
    if (disposed) return
    templates = value.templates
    const select = get<HTMLSelectElement>('[data-template]'); const previous = preferred ?? select.value
    select.replaceChildren(...templates.map(template => { const option = document.createElement('option'); option.value = template.id; option.textContent = template.title; return option }))
    if (templates.some(template => template.id === previous)) select.value = previous
    parameters(); if (value.warning) report(value.warning)
  }
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-tab]')) button.onclick = () => {
    const view = button.dataset.tab!; active = active === view ? '' : view
    for (const section of root.querySelectorAll<HTMLElement>('[data-view]')) section.hidden = section.dataset.view !== active
    for (const item of root.querySelectorAll<HTMLElement>('[data-tab]')) item.setAttribute('aria-pressed', String(item.dataset.tab === active))
    if (active === 'doctor') run(async () => { await settings(); await doctor() })
    if (active === 'records') run(records)
    if (active === 'templates') run(() => loadTemplates())
  }
  get<HTMLButtonElement>('[data-action=diagnose]').onclick = () => run(doctor)
  get<HTMLButtonElement>('[data-action=refresh-records]').onclick = () => run(records)
  get<HTMLButtonElement>('[data-action=save-settings]').onclick = () => run(async () => {
    await api('/panel-state',{autoOpen:get<HTMLInputElement>('[data-setting=autoOpen]').checked})
    await api('/settings', { adbPath: get<HTMLInputElement>('[data-setting=adbPath]').value, maxCalls: Number(get<HTMLInputElement>('[data-setting=maxCalls]').value), taskTimeoutMs: Number(get<HTMLInputElement>('[data-setting=timeout]').value) * 1000 }); await doctor()
  })
  get<HTMLSelectElement>('[data-template]').onchange = parameters
  get<HTMLButtonElement>('[data-action=render-template]').onclick = () => run(async () => {
    const params = Object.fromEntries([...root.querySelectorAll<HTMLInputElement>('[data-parameter]')].map(input => [input.dataset.parameter!, input.value]))
    const rendered = await api<{ prompt: string }>('/templates/render', { id: get<HTMLSelectElement>('[data-template]').value, params })
    if (!disposed) get<HTMLTextAreaElement>('[data-prompt]').value = rendered.prompt
  })
  get<HTMLButtonElement>('[data-action=copy-prompt]').onclick = () => run(async () => {
    const value = get<HTMLTextAreaElement>('[data-prompt]').value
    if (!value) throw new Error('请先生成任务草稿')
    try { await navigator.clipboard.writeText(value) }
    catch {
      const draft = get<HTMLTextAreaElement>('[data-prompt]'); draft.focus(); draft.select()
      if (!document.execCommand('copy')) throw new Error('无法自动复制，请在任务草稿中全选后复制')
    }
    get<HTMLElement>('[data-template-note]').textContent = '已复制。到 Harness 聊天粘贴并发送即可执行。'
  })
  get<HTMLButtonElement>('[data-action=save-template]').onclick = () => run(async () => {
    const saved = await api<{ template: Template }>('/templates', { title: get<HTMLInputElement>('[data-template-title]').value, body: get<HTMLTextAreaElement>('[data-template-body]').value, defaults: Object.fromEntries([...root.querySelectorAll<HTMLInputElement>('[data-parameter]')].map(input => [input.dataset.parameter!, input.value])) })
    await loadTemplates(saved.template.id)
  })
  const timer = setInterval(() => { if (active === 'records') run(records) }, 3000)
  return () => { disposed = true; abort.abort(); clearInterval(timer); for (const url of urls) URL.revokeObjectURL(url); root.replaceChildren() }
}
