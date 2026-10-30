import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile,stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { basename,posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { WebSocketServer, WebSocket } from 'ws'
import { DeviceService, SERVER_VERSION } from './device.js'
import { AndroidRuntime, type RuntimeEvent } from './runtime.js'
import { registerAndroidTools } from './tools.js'
import { encodePacket,encodeAudio } from './wire.js'
import { parseInput } from './input.js'
import { PreferenceStore, dataDirectory, type PluginConfig } from './config.js'
import { TaskLedger } from './tasks.js'
import { TemplateStore } from './templates.js'
import { diagnoseError } from './diagnostics.js'
import { ResultStore, ResultManagementError } from './results.js'
import { resultMarkdown, resultCsv, evidenceExtension } from './result-format.js'
import { zipFiles } from './result-archive.js'
import { PanelStateStore } from './panel-state.js'
import { TaskActionError } from './tasks.js'
import { taskView,continuationDraft } from './task-feed.js'
import { FileService } from './files.js'
import { MediaStore,mediaPatch } from './media-settings.js'
import { RecordingService } from './recording.js'
import {FileManagerService} from './file-manager.js'
import {deviceSerial,type DirectoryOptions} from './file-manager-model.js'

export const name = 'dsh-android'
export const inject = ['webServer', 'tools', 'attachments', 'llm']
type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
type HostContext = Pick<Context, 'tools' | 'attachments' | 'llm' | 'effect' | 'on'> & { webServer: { register(route: { kind: 'prefix'; path: string; handler: Handler }): () => void } }
function json(res: ServerResponse, code: number, value: object) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value))
}
export function authorized(req: Pick<IncomingMessage, 'headers'>): boolean {
  if (req.headers['x-android-client'] !== '1') return false
  if (!req.headers.origin || req.headers.origin === 'null') return true
  try { return new URL(req.headers.origin).host === req.headers.host } catch { return false }
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = ''
  for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 32768) throw new Error('Request too large') }
  const value: unknown = JSON.parse(text || '{}')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request')
  return value as Record<string, unknown>
}
async function managerRead<T>(req:IncomingMessage,res:ServerResponse,timeout:number,work:(signal:AbortSignal)=>Promise<T>){const abort=new AbortController(),timer=setTimeout(()=>abort.abort(new Error('文件查询超时')),timeout),closed=()=>{if(!res.writableFinished)abort.abort(new Error('文件查询已取消'))};req.once('aborted',closed);res.once('close',closed);try{return await work(abort.signal)}finally{clearTimeout(timer);req.off('aborted',closed);res.off('close',closed)}}
interface PanelServices { readImage?(ref: ImageAttachmentRef): Promise<{ data: Uint8Array }> }
export async function createPanel(config: PluginConfig = {}, nativeTools: () => string[] = () => [], services: PanelServices = {}) {
  const { version: pluginVersion } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  const preferences = new PreferenceStore(config.dataDir)
  await preferences.load(config)
  const tasks = new TaskLedger(config.dataDir, { maxCalls: preferences.value.maxCalls, timeoutMs: preferences.value.taskTimeoutMs })
  await tasks.load()
  const templates = new TemplateStore(config.dataDir); await templates.load()
  const results = new ResultStore(config.dataDir); await results.load()
  const panelState = new PanelStateStore(config.dataDir);await panelState.load()
  const service = new DeviceService({ ...config, adbPath: preferences.value.adbPath })
  const runtime = new AndroidRuntime(service, tasks, results)
  const media=new MediaStore(config.dataDir);await media.load(Object.fromEntries(['maxSize','maxFps','videoBitRate','audio','audioSource'].filter(key=>config[key as keyof PluginConfig]!==undefined).map(key=>[key,config[key as keyof PluginConfig]])))
  const files=new FileService(service,config.dataDir);await files.load()
  const fileManager=new FileManagerService(files);await fileManager.load()
  const recordings=new RecordingService(runtime,config.dataDir);await recordings.load()
  const tickets = new Map<string, { serial: string; expires: number }>()
  const downloadTickets=new Map<string,{id:string;expires:number}>()
  const server = createServer((_req, res) => { res.writeHead(404); res.end() })
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32768, perMessageDeflate: false })
  let disposed = false
  let stopping = false
  runtime.extensions={files,media,recordings,async reconnect(serial,signal){if(stopping)throw new Error('正在重新连接，请稍候');stopping=true;try{await recordings.stop('应用画面参数，已结束当前片段');tickets.clear();for(const ws of wss.clients)ws.close(1012,'Capture settings changed');await runtime.disconnect();signal.throwIfAborted();await runtime.ensure(serial)}finally{stopping=false}}}
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const key = url.searchParams.get('ticket') ?? ''
    const ticket = tickets.get(key); tickets.delete(key)
    if (disposed || stopping || url.pathname !== '/stream' || !ticket || ticket.expires < Date.now()) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return
    }
    wss.handleUpgrade(req, socket, head, ws => {
      const viewer = randomBytes(12).toString('hex')
      let unsubscribe: (() => void) | undefined
      const send = (value: object) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)) }
      const render = (event: RuntimeEvent) => {
        if (ws.readyState !== WebSocket.OPEN) return
        if (ws.bufferedAmount > 4 * 1024 * 1024) { ws.close(1013, 'Viewer too slow'); return }
        if (event.type === 'state') { send({ type: 'automation-state', ...event.state }); return }
        if(event.type==='audio-packet'){ws.send(encodeAudio(event.pts,event.data));return}
        if (event.type !== 'packet') { send(event); return }
        if (event.packet.type === 'session') send({ ...event.packet, epoch: event.epoch })
        else ws.send(encodePacket(event.packet))
      }
      const close = () => { unsubscribe?.(); void runtime.viewerClosed(viewer) }
      ws.on('close', close); ws.on('error', close)
      ws.on('message', (data, binary) => {
        let id: number | null = null
        try {
          if (binary) throw new Error('Control messages must be JSON')
          const request = parseInput(JSON.parse(data.toString())); id = request.id
          void runtime.manual(viewer, request.command).then(
            () => send({ type: 'input-result', id, ok: true }),
            error => send({ type: 'input-result', id, ok: false, error: String(error.message ?? error) }),
          )
        } catch (error) { send({ type: 'input-result', id, ok: false, error: String((error as Error).message ?? error) }) }
      })
      void runtime.ensure(ticket.serial).then(() => {
        if (ws.readyState === WebSocket.OPEN) unsubscribe = runtime.subscribe(render)
      }).catch(error => { send({ type: 'error', error: String(error.message ?? error) }); ws.close() })
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Video transport failed to bind')
  const handler: Handler = async (req, res) => {
    try {
      if (disposed) { json(res, 503, { error: 'Android 插件正在关闭' }); return }
      const route = new URL(req.url ?? '/', 'http://localhost').pathname.slice('/x-android'.length)
      if (route === '/ui.js' && req.method === 'GET') {
        const asset = await readFile(new URL('./ui.js', import.meta.url))
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }); res.end(asset); return
      }
      let downloadAuthorized=false
      if(route.startsWith('/download/')&&req.method==='GET'){
        const key=new URL(req.url??'/','http://localhost').searchParams.get('ticket')??'',ticket=downloadTickets.get(key);downloadTickets.delete(key)
        downloadAuthorized=!!ticket&&ticket.id===route.slice('/download/'.length)&&ticket.expires>Date.now()
      }
      if (!authorized(req)&&!downloadAuthorized) { json(res, 403, { error: 'Invalid client request' }); return }
      if(route==='/file-manager/preview'&&req.method==='GET'){
        const q=new URL(req.url??'/','http://localhost').searchParams
        const preview=await managerRead(req,res,30000,signal=>files.remote.preview(deviceSerial(q.get('serial')),q.get('path')??'',q.get('version')??'',signal))
        res.writeHead(200,{'content-type':preview.mime,'content-length':preview.data.length,'cache-control':'no-store','x-content-type-options':'nosniff'})
        res.end(preview.data);return
      }
      if(route==='/file-manager/directory'&&req.method==='GET'){const q=new URL(req.url??'/','http://localhost').searchParams,options:DirectoryOptions={offset:Number(q.get('offset')??0),limit:Number(q.get('limit')??200),sort:(q.get('sort')??'name')as DirectoryOptions['sort'],descending:q.get('descending')==='1',hidden:q.get('hidden')==='1',filter:q.get('filter')??''};json(res,200,await managerRead(req,res,30000,signal=>fileManager.listDirectory(deviceSerial(q.get('serial')),q.get('path')??'/sdcard/Download',options,signal)));return}
      if(route==='/file-manager/stat'&&req.method==='GET'){const q=new URL(req.url??'/','http://localhost').searchParams;json(res,200,await managerRead(req,res,140000,signal=>files.remote.stat(deviceSerial(q.get('serial')),q.get('path')??'',q.get('hash')==='1',signal)));return}
      if(route==='/file-manager/places'&&req.method==='GET'){json(res,200,{places:fileManager.places,lastSerial:fileManager.lastSerial});return}
      if(route==='/file-manager/places'&&req.method==='POST'){json(res,200,await fileManager.savePlace(await body(req)));return}
      if(route==='/file-manager/jobs'&&req.method==='GET'){json(res,200,{jobs:fileManager.list(),transfers:files.list(),recordings:recordings.list()});return}
      if(route==='/file-manager/jobs'&&req.method==='POST'){json(res,202,await fileManager.enqueue(await body(req)));return}
      if(route.startsWith('/file-manager/jobs/')){const[id,action]=route.slice('/file-manager/jobs/'.length).split('/');if(req.method==='GET'&&!action){const job=fileManager.get(id!);if(!job){json(res,404,{error:'文件作业不存在'});return}json(res,200,job);return}if(req.method==='POST'){const input=await body(req);if(action==='cancel'){json(res,200,await fileManager.cancel(id!));return}if(action==='resolve'){json(res,200,await fileManager.resolve(id!,input));return}if(action==='retry'){json(res,202,await fileManager.retry(id!,input.confirm_uncertain===true));return}}}
      if(route.startsWith('/file-manager/discard-upload/')&&req.method==='POST'){const id=route.slice('/file-manager/discard-upload/'.length);json(res,200,await fileManager.discardUpload(id));return}
      if(route==='/download-ticket'&&req.method==='POST'){const input=await body(req);if(typeof input.id!=='string')throw new Error('文件标识无效');const job=files.get(input.id),record=recordings.get(input.id);if(!(job?.kind==='pull'&&job.status==='completed')&&record?.status!=='saved')throw new Error('文件不存在或尚未保存');for(const[k,v]of downloadTickets)if(v.expires<Date.now())downloadTickets.delete(k);if(downloadTickets.size>=16)throw new Error('下载请求过多，请稍候');const key=randomBytes(24).toString('hex');downloadTickets.set(key,{id:input.id,expires:Date.now()+15000});json(res,200,{url:`/x-android/download/${input.id}?ticket=${key}`});return}
      if(route==='/media-settings'&&req.method==='GET'){json(res,200,{saved:media.value,active:runtime.state.state==='streaming'?runtime.activeMedia??null:null,audio_status:runtime.audioStatus,recording:recordings.current(),warning:media.warning});return}
      if(route==='/media-settings'&&req.method==='POST'){const input=await body(req),{apply,serial,...settings}=input;await media.save(mediaPatch(settings));if(apply===true){if(typeof serial!=='string')throw new Error('请选择手机');await runtime.extensions!.reconnect(serial,AbortSignal.timeout(45000))}json(res,200,{ok:true,saved:media.value,active:runtime.activeMedia??null});return}
      if(route==='/device-control'&&req.method==='POST'){const input=await body(req);if(!['screen_on','screen_off','rotate','notifications','quick_settings','collapse_panels'].includes(String(input.action)))throw new Error('未知设备控制');if(!runtime.state.serial||runtime.state.state!=='streaming')throw new Error('请先连接手机');await runtime.bind('panel-controls',runtime.state.serial);json(res,200,await runtime.deviceControl('panel-controls',input.action as Parameters<AndroidRuntime['deviceControl']>[1],AbortSignal.timeout(20000)));return}
      if(route==='/clipboard'&&req.method==='POST'){const input=await body(req);if(!['get','set'].includes(String(input.action))||(input.text!==undefined&&typeof input.text!=='string'))throw new Error('剪贴板参数无效');if(!runtime.state.serial||runtime.state.state!=='streaming')throw new Error('请先连接手机');await runtime.bind('panel-controls',runtime.state.serial);json(res,200,await runtime.clipboard('panel-controls',input.action as 'get'|'set',input.text as string|undefined,AbortSignal.timeout(10000)));return}
      if(route==='/system-key'&&req.method==='POST'){const input=await body(req);const request=parseInput({type:'input',id:1,command:{kind:'key',key:input.key}});await runtime.manual('panel-controls',request.command);json(res,200,{ok:true});return}
      if(route==='/files'&&req.method==='GET'){const query=new URL(req.url??'/','http://localhost').searchParams,serial=query.get('serial')??runtime.state.serial;if(!serial)throw new Error('请选择手机');json(res,200,await files.listRemote(serial,query.get('path')??'/sdcard/Download',AbortSignal.timeout(20000)));return}
      if(route==='/file-upload'&&req.method==='POST'){const name=new URL(req.url??'/','http://localhost').searchParams.get('name')??'file';json(res,200,await files.stage(req,name,AbortSignal.timeout(300000)));return}
      if(route==='/file-jobs'&&req.method==='GET'){json(res,200,{jobs:files.list(),recordings:recordings.list(),recording:recordings.current()});return}
      if(route==='/file-jobs'&&req.method==='POST'){const input=await body(req);if(!['push','pull','install'].includes(String(input.kind))||typeof input.serial!=='string'||(input.kind!=='pull'&&typeof input.upload_id!=='string')||input.local_path!==undefined)throw new Error('文件参数无效，请先选择本机文件');const task=await files.start(input.kind as 'push'|'pull'|'install',input.serial,{upload_id:typeof input.upload_id==='string'?input.upload_id:undefined,remote_path:typeof input.remote_path==='string'?input.remote_path:undefined,overwrite:input.overwrite===true},AbortSignal.timeout(300000));void task.promise.catch(error=>console.error('[dsh-android] file operation:',String(error)));json(res,202,{id:task.id});return}
      if(route.startsWith('/file-jobs/')&&req.method==='POST'){json(res,200,files.cancel(route.slice('/file-jobs/'.length)));return}
      if(route==='/recordings'&&req.method==='POST'){const input=await body(req);if(input.action==='start'){const serial=typeof input.serial==='string'?input.serial:runtime.state.serial;if(!serial)throw new Error('请选择手机');json(res,200,await recordings.start(serial,AbortSignal.timeout(30000),typeof input.max_seconds==='number'?input.max_seconds:undefined));return}if(input.action!=='stop'||!recordings.current()||input.id!==recordings.current()!.id)throw new Error('录制已变化，请刷新后再停止');json(res,200,(await recordings.stop())!);return}
      if(route.startsWith('/download/')&&req.method==='GET'){
        const id=route.slice('/download/'.length),job=files.get(id),record=recordings.get(id),path=job?.kind==='pull'&&job.status==='completed'?job.local_path:record?.status==='saved'?record.local_path:undefined
        if(!path){json(res,404,{error:'文件不存在或尚未成功保存'});return}let info;try{info=await stat(path)}catch{json(res,410,{error:'本机文件已被移动或清理'});return}
        const name=record?'android-recording-'+id+'.mkv':(job!.remote_path?posix.basename(job!.remote_path):basename(job!.local_path)),encoded=encodeURIComponent(name).replaceAll("'",'%27');res.writeHead(200,{'content-type':record?'video/x-matroska':'application/octet-stream','content-length':info.size,'content-disposition':`attachment; filename="android-download${record?'.mkv':''}"; filename*=UTF-8''${encoded}`,'cache-control':'private, no-store'});const stream=createReadStream(path);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);return
      }
      if(route==='/task-feed'&&req.method==='GET'){json(res,200,{tasks:tasks.recent().map(task=>taskView(task,tasks,results)),warning:tasks.storageError});return}
      if(route.startsWith('/task-feed/')&&req.method==='POST'){
        const [id,action,...extra]=route.slice('/task-feed/'.length).split('/');await body(req)
        if(!id||extra.length||!['stop','draft'].includes(action??'')){json(res,404,{error:'任务操作不存在'});return}
        const task=tasks.get(id);if(!task){json(res,404,{error:'任务不存在'});return}
        if(action==='stop'){json(res,200,tasks.requestStop(id));return}
        if(task.status==='running'||tasks.control(id).settling){json(res,409,{error:'请先停止当前任务并等待结束，再生成继续草稿'});return}
        json(res,200,continuationDraft(task,tasks,results));return
      }
      if(route==='/panel-state'&&req.method==='GET'){json(res,200,{state:panelState.value,warning:panelState.warning});return}
      if(route==='/panel-state'&&req.method==='POST'){try{json(res,200,{state:await panelState.update(await body(req)),warning:panelState.warning})}catch(error){json(res,400,{error:String((error as Error).message??error)})}return}
      if (route === '/results' && req.method === 'GET') {
        const params=new URL(req.url??'/','http://localhost').searchParams
        json(res,200,{...results.query({query:params.get('query')??'',from:params.get('from')??undefined,before:params.get('before')??undefined,deleted:params.get('deleted')==='1',offset:Number(params.get('offset')??0),limit:Number(params.get('limit')??20)}),warning:results.warning});return
      }
      if (route.startsWith('/results/') && req.method === 'POST') {
        const [id,action,...extra]=route.slice('/results/'.length).split('/')
        if(!id||extra.length||!['rename','delete','restore'].includes(action??'')){json(res,404,{error:'结果操作不存在'});return}
        const input=await body(req)
        const result=action==='rename'?await results.rename(id,input.title):action==='delete'?await results.remove(id):await results.restore(id)
        json(res,200,{id:result.id,title:result.title,deleted_at:result.deleted_at??null});return
      }
      if (route.startsWith('/results/') && req.method === 'GET') {
        const [id,action,indexText] = route.slice('/results/'.length).split('/')
        const includeDeleted=!action&&new URL(req.url??'/','http://localhost').searchParams.get('deleted')==='1'
        const result=results.get(id??'',includeDeleted)
        if (!result) { json(res,404,{error:'结果不存在'}); return }
        const {input_hash,...publicResult}=result
        const task=tasks.get(result.task_id),view={...publicResult,page_offset:results.pageOffset(result.id),task_state:task?{status:task.status,reason:task.reason??null}:null}
        if (!action) { json(res,200,view); return }
        if (action==='source') {
          const index=Number(indexText),source=Number.isInteger(index)&&index>=1?result.sources[index-1]:undefined
          if (!source || !services.readImage) { json(res,404,{error:'截图依据不可用'}); return }
          try { const image=await services.readImage(source.screenshot); res.writeHead(200,{'content-type':source.screenshot.mediaType,'cache-control':'private, no-store'}); res.end(image.data) }
          catch { json(res,410,{error:'截图原件可能已被 Harness 清理，结果文字仍保留'}) }
          return
        }
        if (action==='export') {
          const format=new URL(req.url??'/','http://localhost').searchParams.get('format')
          let content: Uint8Array, media: string, extension: string
          if (format==='markdown') {content=Buffer.from(resultMarkdown(view));media='text/markdown; charset=utf-8';extension='md'}
          else if (format==='csv') {content=Buffer.from('\uFEFF'+resultCsv(view));media='text/csv; charset=utf-8';extension='csv'}
          else if (format==='bundle') {
            const files=[{name:'report.md',data:Buffer.from(resultMarkdown(view))},{name:'report.csv',data:Buffer.from('\uFEFF'+resultCsv(view))},{name:'evidence.json',data:Buffer.from(JSON.stringify(view,null,2))}]
            let size=files.reduce((sum,file)=>sum+file.data.length,0)
            try {
              for (const [index,source] of result.sources.entries()) {
                if (!services.readImage) throw new Error('附件服务不可用')
                const image=await services.readImage(source.screenshot);size+=image.data.length
                if (size>48*1024*1024) throw new Error('依据包超过 48 MiB，请分批保存结果')
                files.push({name:`evidence/${index+1}.${evidenceExtension(source.screenshot.mediaType)}`,data:Buffer.from(image.data)})
              }
            } catch (error) { json(res,409,{error:`无法导出完整依据包：${String((error as Error).message??error)}`,recovery:'可继续导出 Markdown / CSV；截图可能已被 Harness 清理'}); return }
            content=zipFiles(files);media='application/zip';extension='zip'
          } else {json(res,400,{error:'不支持的导出格式'});return}
          res.writeHead(200,{'content-type':media,'content-disposition':`attachment; filename="android-result-${result.id}.${extension}"`,'cache-control':'private, no-store'});res.end(content);return
        }
        json(res,404,{error:'结果操作不存在'});return
      }
      if (route === '/doctor' && req.method === 'GET') {
        const latest = tasks.summaries().find(task => task.model)
        json(res, 200, { ...await service.diagnose(), pluginVersion, nativeTools: nativeTools(), runtime: runtime.state, lastObservedModel: latest?.model ?? null, storage: { directory: config.dataDir ?? null, warning: tasks.storageError ?? preferences.warning ?? templates.warning ?? panelState.warning }, limits: tasks.limits }); return
      }
      if (route === '/settings' && req.method === 'GET') { json(res, 200, preferences.value); return }
      if (route === '/settings' && req.method === 'POST') {
        const value = preferences.validate(await body(req))
        if (value.adbPath !== preferences.value.adbPath && (runtime.state.state === 'streaming' || runtime.state.state === 'connecting')) { json(res, 409, { error: '请先断开手机，再修改 ADB 路径' }); return }
        await preferences.save(value); if (value.adbPath !== service.config.adbPath) service.setAdbPath(value.adbPath); tasks.limits = { maxCalls: value.maxCalls, timeoutMs: value.taskTimeoutMs }
        json(res, 200, { ok: true, ...value }); return
      }
      if (route === '/templates' && req.method === 'GET') { json(res, 200, { templates: templates.list(), warning: templates.warning }); return }
      if (route === '/templates' && req.method === 'POST') { const template = await templates.save(await body(req)); json(res, 200, { template }); return }
      if (route === '/templates/render' && req.method === 'POST') {
        const input = await body(req)
        if (typeof input.id !== 'string' || !input.params || typeof input.params !== 'object' || Array.isArray(input.params)) { json(res, 400, { error: '模板参数格式无效' }); return }
        json(res, 200, templates.render(input.id, input.params as Record<string, unknown>)); return
      }
      if (route === '/records' && req.method === 'GET') { json(res, 200, { tasks: tasks.summaries(), warning: tasks.storageError }); return }
      if (route.startsWith('/records/') && req.method === 'GET') { const task = tasks.get(route.slice('/records/'.length)); json(res, task ? 200 : 404, task ?? { error: '任务记录不存在' }); return }
      if (route.startsWith('/evidence/') && req.method === 'GET') {
        const ref = tasks.evidence(route.slice('/evidence/'.length))
        if (!ref || !services.readImage) { json(res, 404, { error: '截图依据不存在或当前附件服务不可用' }); return }
        const stored = await services.readImage(ref)
        res.writeHead(200, { 'content-type': ref.mediaType, 'cache-control': 'private, no-store' }); res.end(stored.data); return
      }
      if (route === '/health' && req.method === 'GET') { json(res, 200, { ok: true, phase: 'native-agent', pluginVersion, serverVersion: SERVER_VERSION, nativeTools: nativeTools(), viewers: wss.clients.size, ...runtime.state }); return }
      if (route === '/devices' && req.method === 'GET') { json(res, 200, { devices: await runtime.backend.list() }); return }
      if (route === '/disconnect' && req.method === 'POST') {
        stopping = true
        try { tickets.clear(); for (const ws of wss.clients) ws.close(1000, 'Disconnected');await recordings.stop('手机已断开'); await runtime.disconnect() }
        finally { stopping = false }
        json(res, 200, { ok: true }); return
      }
      if (route === '/ticket' && req.method === 'POST') {
        const { serial } = await body(req)
        if (typeof serial !== 'string' || !serial.length || serial.length > 128) { json(res, 400, { error: '请选择手机' }); return }
        if (stopping || (runtime.state.serial && runtime.state.serial !== serial)) { json(res, 409, { error: '请先断开当前手机' }); return }
        for (const [key, ticket] of tickets) if (ticket.expires < Date.now()) tickets.delete(key)
        if (tickets.size >= 8) { json(res, 429, { error: '连接请求过多，请稍后重试' }); return }
        const ticket = randomBytes(24).toString('hex')
        tickets.set(ticket, { serial, expires: Date.now() + 15_000 })
        json(res, 200, { url: `ws://127.0.0.1:${address.port}/stream?ticket=${ticket}` }); return
      }
      json(res, 404, { error: 'Unknown Android route' })
    } catch (error) { if(res.destroyed||res.writableEnded)return;if(error instanceof ResultManagementError||error instanceof TaskActionError){json(res,error.status,{error:error.message});return} const diagnostic = diagnoseError(error); json(res, 500, { error: diagnostic.message, recovery: diagnostic.recovery, code: diagnostic.code }) }
  }
  return { handler, state: runtime.state, service, runtime, tasks, preferences, templates, results, panelState,files,fileManager,media,recordings,
    async close() {
      disposed = true; tickets.clear(); for (const ws of wss.clients) ws.terminate()
      await recordings.stop('插件关闭');await fileManager.close();await files.close()
      await runtime.close()
      await templates.flush()
      await panelState.flush()
      await new Promise<void>(resolve => wss.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
export async function apply(ctx: HostContext, config: PluginConfig = {}) {
  const panel = await createPanel({ ...config, dataDir: dataDirectory(config.dataDir) }, () => ctx.tools.schemas().filter(tool => tool.name.startsWith('android_')).map(tool => tool.name), { readImage: ref => ctx.attachments.readImage(ref) })
  ctx.effect(() => () => panel.close())
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/x-android', handler: panel.handler }))
  registerAndroidTools(ctx, panel.runtime)
}
