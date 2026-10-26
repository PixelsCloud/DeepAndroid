import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { atomicJson, limits, type Limits } from './config.js'
import { AndroidProblem, diagnoseError, type Diagnostic } from './diagnostics.js'
import type { ResultSource } from './result-format.js'
import type { ListItem } from './navigation.js'

export interface OperationRecord {
  id: string; callId: string; tool: string; input: Record<string, unknown>; startedAt: string; endedAt?: string;
  durationMs?: number; status: 'running' | 'ok' | 'error'; attempts: number; outcome?: string; serial?: string;
  diagnostic?: Diagnostic; screenshot?: ImageAttachmentRef
  beforeObservation?: string; afterObservation?: string
  pages?: { page: number; screenshot: ImageAttachmentRef }[]
  summary?: { verification?: unknown; scrolls?: number; pageCount?: number; itemCount?: number; items?: unknown[]; requestedCount?:number;saveError?:string;readKind?:'page';characters?:number;readingMode?:'screenshots' }
  sources?: ResultSource[]
}
export interface TaskRecord {
  version: 1; id: string; sessionId: string; processId: number; startedAt: string; endedAt?: string;
  status: 'running' | 'completed' | 'cancelled' | 'interrupted' | 'limited' | 'unknown'; calls: number;
  limits: Limits; reason?: string; model?: { provider: string | null; model: string | null; image_input: boolean }; operations: OperationRecord[]
}
interface ActiveTask { record: TaskRecord; abort: AbortController; timer: ReturnType<typeof setTimeout>; stopAgent?: (reason: string) => void }
export class TaskActionError extends Error {constructor(message:string,readonly status:number){super(message)}}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const changesPhone = new Set(['android_pick_file','android_open_file','android_share_file','android_open_uri','android_stop_app','android_gesture','android_tap', 'android_swipe', 'android_input_text', 'android_key', 'android_open_app', 'android_tap_target', 'android_scroll_find', 'android_read_list','android_read_page'])
export class TaskLedger {
  private records: TaskRecord[] = []
  private active = new Map<string, ActiveTask>()
  private writes = Promise.resolve()
  private closed = false
  limits: Limits
  storageError: string | null = null
  onLimit?: (session: string, reason: string) => void
  onCancel?: (session:string)=>void
  constructor(readonly directory?: string, configured: Partial<Limits> = {}) { this.limits = limits(configured) }
  async load() {
    if (!this.directory) return
    await mkdir(join(this.directory, 'tasks'), { recursive: true })
    const names = (await readdir(join(this.directory, 'tasks'))).filter(name => uuid.test(name.replace(/\.json$/, '')) && name.endsWith('.json'))
    for (const name of names) {
      try {
        const raw = await readFile(join(this.directory, 'tasks', name), 'utf8')
        if (raw.length > 3_000_000) continue
        const task = JSON.parse(raw) as TaskRecord
        if (task.version !== 1 || !uuid.test(task.id) || `${task.id}.json` !== name || !Array.isArray(task.operations) || task.operations.length > 1100) continue
        if (task.status === 'running') { task.status = 'unknown'; task.reason = '此记录由先前或其他进程创建，当前进程无法确认执行结果' }
        this.records.push(task)
      } catch { this.storageError = '部分任务记录无法读取；其他记录仍可查看' }
    }
    this.records.sort((a, b) => b.startedAt.localeCompare(a.startedAt)); this.records = this.records.slice(0, 100)
  }
  private persist(record: TaskRecord) {
    if (!this.directory) return
    const snapshot = structuredClone(record)
    this.writes = this.writes.then(() => atomicJson(join(this.directory!, 'tasks', `${record.id}.json`), snapshot)).catch(() => { this.storageError = '任务记录写入失败，请检查插件数据目录空间和权限' })
  }
  private newTask(sessionId: string): ActiveTask {
    const record: TaskRecord = { version: 1, id: randomUUID(), sessionId, processId: process.pid, startedAt: new Date().toISOString(), status: 'running', calls: 0, limits: { ...this.limits }, operations: [] }
    const active: ActiveTask = { record, abort: new AbortController(), timer: setTimeout(() => this.stop(sessionId, `任务已超过 ${record.limits.timeoutMs / 1000} 秒时限`), record.limits.timeoutMs) }
    active.timer.unref(); this.active.set(sessionId, active); this.records.unshift(record)
    this.records = this.records.slice(0, 100)
    return active
  }
  private stop(sessionId: string, reason: string) {
    const active = this.active.get(sessionId)
    if (!active || active.record.status !== 'running') return
    active.record.status = 'limited'; active.record.reason = reason; active.record.endedAt = new Date().toISOString()
    clearTimeout(active.timer)
    const error = new AndroidProblem({ code: 'TASK_LIMIT', message: reason, recovery: '已停止本轮手机操作，请查看已完成记录，再决定是否发起新任务' })
    active.abort.abort(error); this.persist(active.record)
    try { this.onLimit?.(sessionId, reason) } catch { /* Stop notifications must not crash a deadline timer. */ }
    try { active.stopAgent?.(reason) } catch { /* A disposed Agent is already stopped. */ }
  }
  begin(sessionId: string, callId: string, tool: string, args: unknown, stopAgent?: (reason: string) => void): { signal: AbortSignal; taskId: string } {
    if (this.closed) throw new Error('任务记录服务已关闭')
    const active = this.active.get(sessionId) ?? this.newTask(sessionId)
    if (stopAgent) active.stopAgent = stopAgent
    if (active.record.status !== 'running' && tool !== 'android_release') throw active.abort.signal.reason ?? new Error('[TASK_LIMIT] 任务已经停止')
    if (tool !== 'android_release' && active.record.calls >= active.record.limits.maxCalls) {
      this.stop(sessionId, `任务已达到 ${active.record.limits.maxCalls} 次调用上限`)
      throw active.abort.signal.reason
    }
    if (tool !== 'android_release') active.record.calls++
    const input: Record<string, unknown> = {}
    if (args && typeof args === 'object' && !Array.isArray(args)) for (const [key, value] of Object.entries(args)) {
      if(['android_notifications','android_wait_notification'].includes(tool)&&['text_contains','notification_key'].includes(key)){input[key+'_length']=typeof value==='string'?value.length:0;continue}
      if(tool==='android_open_uri'&&key==='uri'){input.uri_length=typeof value==='string'?value.length:0;continue}
      if (['android_input_text','android_clipboard'].includes(tool) && key === 'text') { input.text_length = typeof value === 'string' ? value.length : 0; continue }
      if (typeof value === 'string') input[key] = value.slice(0, 256)
      else if (typeof value === 'boolean' || typeof value === 'number' || value === null) input[key] = value
    }
    const existing = active.record.operations.find(operation => operation.callId === callId)
    if (existing) existing.attempts++
    else if (active.record.operations.length < 1100) active.record.operations.push({ id: randomUUID(), callId, tool, input, startedAt: new Date().toISOString(), status: 'running', attempts: 1, ...(changesPhone.has(tool) ? { beforeObservation: [...active.record.operations].reverse().find(item => item.screenshot)?.id } : {}) })
    this.persist(active.record)
    return { signal: tool === 'android_release' ? new AbortController().signal : active.abort.signal, taskId: active.record.id }
  }
  checkpoint(sessionId:string,callId:string,value:{items:ListItem[];scrolls:number;requested_count:number;sources:ResultSource[];kind?:'page';characters?:number;reading_mode?:'screenshots'}) {
    const active=this.active.get(sessionId),operation=active?.record.operations.find(item=>item.callId===callId)
    if(!active||!operation||operation.status!=='running')return
    operation.summary={scrolls:value.scrolls,pageCount:value.sources.length,itemCount:value.items.length,requestedCount:value.requested_count,items:structuredClone(value.items),...(value.kind==='page'?{readKind:'page',characters:value.characters,readingMode:value.reading_mode}:{})}
    operation.sources=structuredClone(value.sources);operation.pages=value.sources.map((source,index)=>({page:index+1,screenshot:structuredClone(source.screenshot)}))
    this.persist(active.record)
  }
  resultSaveFailed(taskId:string,callId:string){const record=[...this.active.values()].find(task=>task.record.id===taskId)?.record??this.records.find(task=>task.id===taskId),operation=record?.operations.find(item=>item.callId===callId);if(record&&operation){operation.summary={...operation.summary,saveError:'已读取内容未能另存为结果；请查看任务记录中的条目与截图，并检查本机空间和权限'};this.persist(record)}}
  requestStop(taskId:string){
    const active=[...this.active.values()].find(item=>item.record.id===taskId)
    if(!active)throw new TaskActionError('任务已结束或属于先前进程，请刷新任务状态',409)
    if(active.record.status==='cancelled')return {id:taskId,status:'stopping'}
    if(active.record.status!=='running')throw new TaskActionError('任务已经停止，请等待本轮结束',409)
    if(!active.stopAgent)throw new TaskActionError('当前任务没有可用的 Harness 停止接口，请使用聊天中的停止按钮',409)
    const reason='用户从手机面板停止了当前任务'
    active.record.status='cancelled';active.record.reason=reason;active.record.endedAt=new Date().toISOString();clearTimeout(active.timer)
    active.abort.abort(new AndroidProblem({code:'CANCELLED',message:reason,recovery:'已读取内容会保留；继续时先重新观察当前画面'}));this.persist(active.record)
    this.onCancel?.(active.record.sessionId)
    active.stopAgent(reason)
    return {id:taskId,status:'stopping'}
  }
  control(taskId:string){const active=[...this.active.values()].find(item=>item.record.id===taskId);return {canStop:!!active&&active.record.status==='running'&&!!active.stopAgent,settling:!!active&&active.record.status!=='running'}}
  recent(limit=20){const active=[...this.active.values()].map(value=>value.record);return structuredClone([...new Map([...active,...this.records].map(record=>[record.id,record])).values()].sort((a,b)=>b.startedAt.localeCompare(a.startedAt)).slice(0,limit))}
  finish(sessionId: string, callId: string, tool: string, result: { isError: boolean; value?: unknown; content?: unknown }, serial?: string) {
    const record=this.records.find(task=>task.sessionId===sessionId&&task.operations.some(operation=>operation.callId===callId))??this.active.get(sessionId)?.record??(this.closed?undefined:this.newTask(sessionId).record)
    if(!record)return
    let operation = record.operations.find(item => item.callId === callId)
    if (!operation) {
      if (record.operations.length >= 1100) return
      operation = { id: randomUUID(), callId, tool, input: {}, startedAt: new Date().toISOString(), attempts: 0, status: 'running' }
      record.operations.push(operation)
    }
    operation.endedAt = new Date().toISOString(); operation.durationMs = Math.max(0, Date.parse(operation.endedAt) - Date.parse(operation.startedAt)); operation.serial = serial
    operation.status = result.isError ? 'error' : 'ok'
    if (result.isError) {
      const error = typeof result.content === 'string' ? result.content : Array.isArray(result.content)?result.content.filter(block=>block&&typeof block==='object'&&block.type==='text'&&typeof block.text==='string').map(block=>block.text).join('\n'):JSON.stringify(result.content ?? '操作失败')
      operation.diagnostic = diagnoseError(new Error(error))
      if (tool === 'android_input_text' && operation.diagnostic.code === 'OPERATION_FAILED') operation.diagnostic.message = '文字输入失败，详细原因见 Harness 对话；本记录省略输入正文'
    } else if (result.value && typeof result.value === 'object') {
      const value = result.value as Record<string, unknown>
      if (typeof value.status === 'string') operation.outcome = value.status
      const validRef = (ref: unknown): ref is ImageAttachmentRef => !!ref && typeof ref === 'object' && typeof (ref as ImageAttachmentRef).attachmentId === 'string' && (ref as ImageAttachmentRef).mediaType === 'image/png' && typeof (ref as ImageAttachmentRef).bytes === 'number' && typeof (ref as ImageAttachmentRef).width === 'number' && typeof (ref as ImageAttachmentRef).height === 'number'
      if (Array.isArray(value.pages)) operation.pages = value.pages.slice(0,8).flatMap((page, index) => page && typeof page === 'object' && validRef(page.screenshot) ? [{page:index+1,screenshot:structuredClone(page.screenshot)}] : [])
      if (['android_tap_target','android_scroll_find','android_read_list','android_read_page','android_wait'].includes(tool)) operation.summary = { verification: value.verification, scrolls: typeof value.scrolls === 'number' ? value.scrolls : undefined, pageCount: Array.isArray(value.pages) ? value.pages.length : undefined, itemCount: Array.isArray(value.items) ? value.items.length : undefined, requestedCount:typeof value.requested_count==='number'?value.requested_count:undefined,items: Array.isArray(value.items) ? structuredClone(value.items.slice(0,100)) : undefined,...(value.kind==='page'?{readKind:'page',characters:typeof value.characters==='number'?value.characters:undefined,readingMode:value.reading_mode==='screenshots'?'screenshots':undefined}:{}),...(typeof value.result_save_error==='string'?{saveError:'原始采集结果未能保存，请查看任务记录并检查本机空间和权限'}:{}) }
      const ref = value.screenshot as ImageAttachmentRef | undefined
      const sources = [...(Array.isArray(value.pages) ? value.pages : []),value]
      operation.sources = [...new Map(sources.flatMap(source=>source && typeof source === 'object' && typeof source.observation_id === 'string' && validRef(source.screenshot) ? [[source.observation_id,{observation_id:source.observation_id,captured_at:typeof source.captured_at==='string'?source.captured_at:operation.startedAt,serial:typeof source.serial==='string'?source.serial:typeof value.serial==='string'?value.serial:serial??'',screenshot:structuredClone(source.screenshot),...(typeof source.origin_result_id==='string'?{origin_result_id:source.origin_result_id,origin_observation_id:source.origin_observation_id}:{})}] as const] : [])).values()]
      if (ref && typeof ref.attachmentId === 'string' && ref.mediaType === 'image/png' && typeof ref.bytes === 'number' && typeof ref.width === 'number' && typeof ref.height === 'number') {
        operation.screenshot = structuredClone(ref)
        const index = record.operations.indexOf(operation)
        for (let i = index - 1; i >= 0; i--) {
          const previous = record.operations[i]!
          if (previous.screenshot) break
          if (changesPhone.has(previous.tool) && !previous.afterObservation) previous.afterObservation = operation.id
        }
      }
      const model = value.model as TaskRecord['model']
      if (model && typeof model.image_input === 'boolean') record.model = structuredClone(model)
    }
    this.persist(record)
  }
  complete(sessionId: string, interrupted = false) {
    const active = this.active.get(sessionId)
    if (!active) return
    clearTimeout(active.timer)
    if (active.record.status === 'running') {
      active.record.status = interrupted ? 'interrupted' : active.record.operations.some(operation => operation.diagnostic?.code === 'CANCELLED') ? 'cancelled' : 'completed'
      active.record.endedAt = new Date().toISOString()
    }
    for (const operation of active.record.operations) if (operation.status === 'running') { operation.status = 'error'; operation.endedAt = active.record.endedAt; operation.diagnostic = { code: 'INTERRUPTED', message: '未取得最终操作结果', recovery: '先检查当前画面再重新观察' } }
    this.persist(active.record); this.active.delete(sessionId)
  }
  noteStop(sessionId: string, status: 'cancelled' | 'interrupted', reason: string) {
    const active = this.active.get(sessionId)
    if (!active || active.record.status !== 'running') return
    active.record.status = status; active.record.reason = reason; active.record.endedAt = new Date().toISOString()
    clearTimeout(active.timer); this.persist(active.record)
  }
  summaries() { return structuredClone(this.records.map(({ operations, ...task }) => ({ ...task, operationCount: operations.length, errors: operations.filter(operation => operation.status === 'error').length, screenshots: operations.filter(operation => operation.screenshot).length }))) }
  get(id: string) { return uuid.test(id) ? structuredClone([...this.active.values()].find(task=>task.record.id===id)?.record??this.records.find(record => record.id === id) ?? null) : null }
  evidence(operationId: string) { const [id, page] = operationId.split('~'); for (const task of this.records) { const operation = task.operations.find(item => item.id === id); const ref = page !== undefined ? operation?.pages?.find(item => String(item.page) === page)?.screenshot : operation?.screenshot; if (ref) return structuredClone(ref) } return null }
  status(sessionId: string) { const active = this.active.get(sessionId); return active ? { id: active.record.id, status: active.record.status, calls: active.record.calls, limits: active.record.limits, startedAt: active.record.startedAt, reason: active.record.reason ?? null } : null }
  source(sessionId: string, observationId: string): ResultSource | null {
    for (const task of this.records) if (task.sessionId === sessionId) for (const operation of task.operations) { const source=operation.sources?.find(source=>source.observation_id===observationId); if (source) return structuredClone(source) }
    return null
  }
  async flush() { await this.writes }
  async close() { if (this.closed) return; this.closed = true; for (const session of [...this.active.keys()]) this.complete(session, true); await this.flush() }
}
