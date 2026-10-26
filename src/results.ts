import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicJson } from './config.js'
import { validateResult, type ResultSource, type SavedResult } from './result-format.js'
export { type ResultSource, type SavedResult } from './result-format.js'
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
export interface ResultFilters { query?: string; from?: string; before?: string; deleted?: boolean; offset?: number; limit?: number }
export class ResultManagementError extends Error { constructor(message:string,readonly status:number){super(message)} }
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export class ResultStore {
  private records: SavedResult[] = []
  private writes = Promise.resolve()
  warning: string | null = null
  constructor(readonly directory?: string) {}
  async load() {
    if (!this.directory) return
    await mkdir(join(this.directory,'results'),{recursive:true})
    for (const name of await readdir(join(this.directory,'results'))) {
      if (!uuid.test(name.replace(/\.json$/,'')) || !name.endsWith('.json')) continue
      try {
        const raw = await readFile(join(this.directory,'results',name),'utf8')
        if (raw.length > 400_000) throw new Error('result too large')
        const value = JSON.parse(raw) as SavedResult
        if (value.version !== 1 || !uuid.test(value.id) || name !== value.id+'.json' || !['agent','device'].includes(value.origin) || typeof value.session_id !== 'string' || typeof value.call_id !== 'string' || typeof value.task_id !== 'string' || !Number.isFinite(Date.parse(value.created_at)) || !Array.isArray(value.sources) || value.sources.length>32) throw new Error('invalid result')
        const checked = validateResult(value)
        if ([value.updated_at,value.deleted_at].some(date=>date!==undefined&&(typeof date!=='string'||!Number.isFinite(Date.parse(date)))) || (value.input_hash!==undefined&&(typeof value.input_hash!=='string'||!/^[a-f0-9]{64}$/.test(value.input_hash)))) throw new Error('invalid result metadata')
        const used = new Set([...checked.observation_ids,...checked.rows.flatMap(row=>row.observation_ids)])
        if (value.sources.some(source=>!used.has(source.observation_id) || typeof source.captured_at !== 'string' || typeof source.serial !== 'string' || !source.screenshot || typeof source.screenshot.attachmentId !== 'string' || source.screenshot.mediaType !== 'image/png') || [...used].some(id=>!value.sources.some(source=>source.observation_id===id))) throw new Error('invalid evidence')
        this.records.push({...value,...checked})
      } catch { this.warning = '部分结果文件无法读取，其他结果仍可查看' }
    }
    this.records.sort((a,b)=>b.created_at.localeCompare(a.created_at)||b.id.localeCompare(a.id))
  }
  async save(session: string, callId: string, taskId: string, input: unknown, resolveSource: (id:string)=>ResultSource|null, signal: AbortSignal, origin: SavedResult['origin'] = 'agent'): Promise<SavedResult> {
    const value = validateResult(input)
    const ids = [...new Set([...value.observation_ids,...value.rows.flatMap(row=>row.observation_ids)])]
    const sources = ids.map(id=>{ const source=resolveSource(id); if (!source) throw new Error(`截图依据不属于当前对话的已保存观察：${id}`); return structuredClone(source) })
    const work = this.writes.then(async()=>{
      signal.throwIfAborted()
      const existing = this.records.find(record=>record.session_id===session && record.call_id===callId)
      if (existing) {
        if ((existing.input_hash??digest(validateResult(existing)))!==digest(value)) throw new Error('同一工具调用不能用不同内容重复保存')
        return structuredClone(existing)
      }
      const record: SavedResult = {...value,version:1,id:randomUUID(),session_id:session,task_id:taskId,call_id:callId,created_at:new Date().toISOString(),origin,sources,input_hash:digest(value)}
      if (this.directory) await atomicJson(join(this.directory,'results',record.id+'.json'),record)
      this.records.unshift(record);this.records.sort((a,b)=>b.created_at.localeCompare(a.created_at)||b.id.localeCompare(a.id))
      return structuredClone(record)
    })
    this.writes = work.then(()=>{},()=>{})
    return work
  }
  query(filters: ResultFilters = {}) {
    const query=filters.query??'',offset=filters.offset??0,limit=filters.limit??20
    if(typeof query!=='string'||query.length>256||!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw new ResultManagementError('搜索最多 256 字，每页 1–100 条，偏移量须为非负整数',400)
    const time=(value:string|undefined)=>{if(value===undefined)return undefined;const timestamp=Date.parse(value);if(!Number.isFinite(timestamp)||new Date(timestamp).toISOString()!==value)throw new ResultManagementError('日期边界须为有效 UTC ISO 时间',400);return timestamp}
    const from=time(filters.from),before=time(filters.before)
    if(from!==undefined&&before!==undefined&&from>=before)throw new ResultManagementError('开始日期不能晚于结束日期',400)
    const normalize=(value:string)=>value.normalize('NFKC').toLocaleLowerCase(),needle=normalize(query.trim())
    const matched=this.records.filter(record=>!!record.deleted_at===!!filters.deleted && (from===undefined||Date.parse(record.created_at)>=from) && (before===undefined||Date.parse(record.created_at)<before) && (!needle||normalize([record.title,record.summary,record.reason,...record.columns,...record.rows.flatMap(row=>[...row.cells.filter((cell):cell is string=>cell!==null),row.note])].join('\n')).includes(needle)))
    return {results:structuredClone(matched.slice(offset,offset+limit).map(({rows,sources,summary,columns,observation_ids,input_hash,...record})=>({...record,row_count:rows.length,source_count:sources.length}))),total:matched.length,total_all:this.records.filter(record=>!record.deleted_at).length,deleted_count:this.records.filter(record=>record.deleted_at).length,offset,limit,has_more:offset+limit<matched.length}
  }
  summaries() { return this.query({limit:100}).results }
  taskResults(taskId:string){return structuredClone(this.records.filter(record=>record.task_id===taskId&&!record.deleted_at).map(({id,title,status,reason,origin,rows,sources})=>({id,title,status,reason,origin,row_count:rows.length,source_count:sources.length})))}
  byCall(sessionId:string,callId:string){return structuredClone(this.records.find(record=>record.session_id===sessionId&&record.call_id===callId)??null)}
  pageOffset(id:string){const index=this.records.filter(record=>!record.deleted_at).findIndex(record=>record.id===id);return index<0?0:Math.floor(index/20)*20}
  get(id: string, includeDeleted=false) { return uuid.test(id) ? structuredClone(this.records.find(record=>record.id===id&&(includeDeleted||!record.deleted_at)) ?? null) : null }
  private update(id:string,change:(record:SavedResult)=>void) {
    const work=this.writes.then(async()=>{
      const index=uuid.test(id)?this.records.findIndex(record=>record.id===id):-1
      if(index<0)throw new ResultManagementError('结果不存在',404)
      const record=structuredClone(this.records[index]!)
      change(record);try{validateResult(record)}catch(error){throw new ResultManagementError(String((error as Error).message??error),400)}
      if(this.directory)await atomicJson(join(this.directory,'results',id+'.json'),record)
      this.records[index]=record;return structuredClone(record)
    })
    this.writes=work.then(()=>{},()=>{});return work
  }
  rename(id:string,title:unknown) {
    if(typeof title!=='string'||!title.trim()||title.trim().length>100||/[\r\n\0]/.test(title))return Promise.reject(new ResultManagementError('标题须为 1–100 字，不能包含换行',400))
    return this.update(id,record=>{if(record.deleted_at)throw new ResultManagementError('请先恢复已删除结果，再重命名',409);record.input_hash??=digest(validateResult(record));record.title=title.trim();record.updated_at=new Date().toISOString()})
  }
  remove(id:string) {return this.update(id,record=>{record.deleted_at??=new Date().toISOString()})}
  restore(id:string) {return this.update(id,record=>{delete record.deleted_at})}
  async flush() { await this.writes }
}
