import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
export interface ResultSource { observation_id: string; captured_at: string; serial: string; screenshot: ImageAttachmentRef;origin_result_id?:string;origin_observation_id?:string }
export interface ResultRow { cells: (string | null)[]; observation_ids: string[]; note: string }
export interface ResultInput { title: string; summary: string; columns: string[]; rows: ResultRow[]; observation_ids: string[]; status: 'complete' | 'partial' | 'failed'; reason: string; expected_count?: number }
export interface SavedResult extends ResultInput { version: 1; id: string; session_id: string; task_id: string; call_id: string; created_at: string; origin: 'agent' | 'device'; sources: ResultSource[]; input_hash?: string; updated_at?: string; deleted_at?: string }
export type ResultView = SavedResult & {task_state?:{status:string;reason:string|null}|null}
export function validateResult(input: unknown): ResultInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('结果格式无效')
  if (new TextEncoder().encode(JSON.stringify(Object.fromEntries(['title','summary','columns','rows','observation_ids','status','reason','expected_count'].map(key=>[key,(input as Record<string,unknown>)[key]])))).length > 262144) throw new Error('结果最多 256 KiB，请缩减单元格内容或分次保存')
  const value = input as Record<string,unknown>
  const string = (value: unknown, label: string, max: number, required = false): string => {
    if (value === undefined && !required) return ''
    if (typeof value !== 'string' || value.length > max || value.includes('\0') || (required && !value.trim())) throw new Error(`${label}须为${required ? '非空' : ''}文字，最多 ${max} 字`)
    return value
  }
  const ids = (input: unknown, max = 8): string[] => {
    if (input === undefined) return []
    if (!Array.isArray(input) || input.length > max || input.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id))) throw new Error('截图依据须为工具返回的 observation_id 列表')
    return [...new Set(input)] as string[]
  }
  const title = string(value.title,'结果标题',100,true), summary = string(value.summary,'摘要',8000)
  if (!['complete','partial','failed'].includes(String(value.status))) throw new Error('请明确结果状态 complete / partial / failed')
  let status = value.status as ResultInput['status'], reason = string(value.reason,'未完成原因',2000)
  const columns = value.columns === undefined ? [] : value.columns
  if (!Array.isArray(columns) || columns.length > 12 || columns.some(column => typeof column !== 'string' || !column.trim() || column.length > 80) || new Set(columns).size !== columns.length) throw new Error('表格最多 12 列，列名须非空且唯一')
  const rawRows = value.rows === undefined ? [] : value.rows
  if (!Array.isArray(rawRows) || rawRows.length > 100 || (rawRows.length && !columns.length)) throw new Error('表格最多 100 行，且需要列名')
  const rows: ResultRow[] = rawRows.map(row => {
    if (!row || typeof row !== 'object' || !Array.isArray(row.cells) || row.cells.length !== columns.length) throw new Error('每行单元格数量必须与列名一致')
    const cells = row.cells.map((cell: unknown) => cell === null || cell === '' ? null : string(cell,'单元格',2000))
    const observation_ids = ids(row.observation_ids)
    if (!observation_ids.length) throw new Error('每行结果都需要至少一个实际截图依据；未读到的数据请留空，不要编造')
    return { cells, observation_ids, note: string(row.note,'行说明',1000) }
  })
  const observation_ids = ids(value.observation_ids,32)
  if (!rows.length && !summary && value.status !== 'failed') throw new Error('请提供表格或摘要')
  if (summary && !rows.length && !observation_ids.length && status !== 'failed') throw new Error('摘要需要实际截图依据')
  const expected = value.expected_count
  if (expected !== undefined && (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 1 || expected > 100)) throw new Error('预期条数须为 1–100')
  const missing = rows.some(row => row.cells.some(cell => cell === null))
  const short = typeof expected === 'number' && rows.length < expected
  if (status === 'complete' && (missing || short)) { status = 'partial'; reason = [reason,missing ? '存在未读到的字段' : '',short ? `实际 ${rows.length} 条，少于预期 ${expected} 条` : ''].filter(Boolean).join('；') }
  if (status !== 'complete' && !reason.trim()) throw new Error('部分完成或失败的结果需要说明原因')
  if (new Set([...observation_ids,...rows.flatMap(row => row.observation_ids)]).size > 32) throw new Error('每份结果最多关联 32 张截图')
  return {title,summary,columns:[...columns],rows,observation_ids,status,reason,...(typeof expected === 'number' ? {expected_count:expected} : {})}
}
const statuses = {complete:'已整理',partial:'部分完成',failed:'未完成'}
const taskStatuses:Record<string,string>={running:'执行中',completed:'已结束',cancelled:'已取消',interrupted:'已中断',limited:'达到限额',unknown:'结果待确认'}
const markdown = (text: string) => text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\\/g,'\\\\').replace(/([`*_\[\]#!])/g,'\\$1').replace(/\|/g,'\\|').replace(/\r?\n/g,'<br>')
export function sourceNumbers(result: SavedResult, ids: string[]) { return ids.map(id => result.sources.findIndex(source => source.observation_id === id)+1).filter(Boolean) }
export function resultMarkdown(result: ResultView): string {
  const lines = [`# ${markdown(result.title)}`,'',`状态：${statuses[result.status]} · ${result.origin === 'agent' ? 'Agent 整理，内容需结合截图核对' : '设备原始采集，尚未由 Agent 整理'}`,`保存时间：${result.created_at}`,'']
  if (result.reason) lines.push(`说明：${markdown(result.reason)}`,'')
  if (result.task_state) lines.push(`关联任务状态：${markdown(taskStatuses[result.task_state.status]??result.task_state.status)}${result.task_state.reason ? ` · ${markdown(result.task_state.reason)}` : ''}`,'')
  if (result.summary) lines.push(markdown(result.summary),'')
  if (result.rows.length) {
    lines.push(`| ${[...result.columns,'依据','说明'].map(markdown).join(' | ')} |`,`| ${Array(result.columns.length+2).fill('---').join(' | ')} |`)
    for (const row of result.rows) lines.push(`| ${[...row.cells.map(cell=>cell ?? '未读到'),sourceNumbers(result,row.observation_ids).map(n=>`截图 ${n}`).join('、'),row.note].map(markdown).join(' | ')} |`)
    lines.push('')
  }
  if (result.sources.length) {
    lines.push('## 截图依据','','配套截图请使用“导出依据包”；单独的 Markdown 文件不包含截图原件。','')
    result.sources.forEach((source,index)=>lines.push(`### 截图 ${index+1}`,'',`观察：${source.observation_id} · ${source.captured_at}`,'',`![截图 ${index+1}](evidence/${index+1}.png)` ,''))
  }
  return lines.join('\n')+'\n'
}
/** Quote every field; neutralize spreadsheet formulas in untrusted app text. */
function csvCell(value: string) { const safe = /^[\s\uFEFF]*[=+\-@]/.test(value) ? "'"+value : value; return '"'+safe.replace(/"/g,'""')+'"' }
export function resultCsv(result: ResultView, delimiter = ','): string {
  const header = result.columns.length ? [...result.columns,'依据','说明','结果状态','未完成原因','关联任务状态','任务说明'] : ['摘要','依据','说明','结果状态','未完成原因','关联任务状态','任务说明']
  const tail=[statuses[result.status],result.reason,result.task_state?(taskStatuses[result.task_state.status]??result.task_state.status):'记录不可用',result.task_state?.reason??'']
  const rows = result.rows.length ? result.rows.map(row=>[...row.cells.map(cell=>cell ?? '未读到'),sourceNumbers(result,row.observation_ids).map(n=>`截图 ${n}`).join('、'),row.note,...tail]) : [[result.summary,sourceNumbers(result,result.observation_ids).map(n=>`截图 ${n}`).join('、'),'',...tail]]
  return [header,...rows].map(row=>row.map(csvCell).join(delimiter)).join('\r\n')+'\r\n'
}
