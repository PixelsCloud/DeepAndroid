import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { ScrcpyVideoStreamPacket } from '@yume-chan/scrcpy'
import { DeviceService, type VideoSession, type DeviceInfo } from './device.js'
import { type InputCommand, type PhoneKey,type DeviceAction } from './input.js'
import { parseHierarchy, pngSize, type Observation } from './observation.js'
import { appMatches, resolveApp, normalizeName, PACKAGE_NAME, type AndroidApp } from './apps.js'
import { matchTargets, validateTarget, type TargetQuery } from './targets.js'
import { TaskLedger } from './tasks.js'
import { tapTarget, waitForUi, scrollPages, type NavigationDriver, type ScrollOptions } from './navigation.js'
import { ResultStore } from './results.js'
import { readPage,type PageReadOptions } from './page-reading.js'
import type { FileService } from './files.js'
import type { MediaStore,MediaSettings } from './media-settings.js'
import type { RecordingService } from './recording.js'
import {packageName,viewUri} from './device-state.js'
import {planGesture,type GestureOptions} from './gestures.js'
import {queryMedia,validateMediaQuery,type MediaQuery} from './media-library.js'
import {pickFile,validatePickFile,type PickFileOptions} from './file-picker.js'
import {validateNotificationQuery,type NotificationQuery} from './notifications.js'
import {waitApp,waitNotification,validateWaitApp,validateWaitNotification,type WaitAppOptions,type WaitNotificationOptions} from './event-waits.js'
import { validateObserve, validateAfterAction, validateImageWait, validateRegion, transformScreen, decodeScreen, imageDifference, type ObserveOptions, type AfterActionOptions, type ImageWaitOptions } from './screen-image.js'

export interface AndroidBackend {
  notifications?(serial:string,query:NotificationQuery,signal:AbortSignal):ReturnType<DeviceService['notifications']>
  foregroundState?(serial:string,signal:AbortSignal):ReturnType<DeviceService['foregroundState']>
  deviceState?(serial:string,signal:AbortSignal):ReturnType<DeviceService['deviceState']>
  appInfo?(serial:string,name:string,signal:AbortSignal):ReturnType<DeviceService['appInfo']>
  openUri?(serial:string,value:string,targetPackage:string|undefined,signal:AbortSignal):ReturnType<DeviceService['openUri']>
  stopApp?(serial:string,name:string,signal:AbortSignal):ReturnType<DeviceService['stopApp']>
  presentFile?(serial:string,action:'open'|'share',uri:string,mime:string,targetPackage:string|undefined,userId:number,signal:AbortSignal):ReturnType<DeviceService['presentFile']>
  list(): Promise<DeviceInfo[]>
  open(serial: string, signal: AbortSignal, onError?: (error: string) => void): Promise<VideoSession>
  screenshot(serial: string, signal: AbortSignal): Promise<Buffer>
  dumpUi(serial: string, signal: AbortSignal): Promise<string>
  openApp(serial: string, packageName: string, signal: AbortSignal): Promise<void>
  listApps(serial: string, signal: AbortSignal): Promise<AndroidApp[]>
}
export interface RuntimeState { state: 'idle' | 'connecting' | 'streaming' | 'error'; serial: string | null; error: string | null; packets: number; bytes: number; width: number; height: number; connectedAt: number | null; mode: 'idle' | 'agent'; owner: string | null; lastAction: string; revision: number }
export type RuntimeEvent = { type: 'hello'; codec: number; deviceName: string } | { type: 'packet'; packet: ScrcpyVideoStreamPacket; epoch: number } | { type: 'state'; state: RuntimeState } | { type: 'input-error'; error: string }|{type:'audio-state';status:'disabled'|'errored'|'success';error?:string}|{type:'audio-packet';pts:bigint;data:Uint8Array}
interface Connection { serial: string; abort: AbortController; video?: VideoSession; ready: Promise<VideoSession>; done?: Promise<void>;audioDone?:Promise<void> }
interface SavedObservation { observation: Observation; session: string; used: boolean }

/** The service owns startup; cancelling a caller only stops waiting for it. */
function waitFor<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** Owns the device independently of any viewer and serializes all Agent operations. */
export class AndroidRuntime {
  extensions?:{files:FileService;media:MediaStore;recordings:RecordingService;reconnect:(serial:string,signal:AbortSignal)=>Promise<void>}
  activeMedia?:MediaSettings
  audioStatus:'disabled'|'errored'|'success'='disabled'
  readonly state: RuntimeState = { state: 'idle', serial: null, error: null, packets: 0, bytes: 0, width: 0, height: 0, connectedAt: null, mode: 'idle', owner: null, lastAction: '', revision: 0 }
  private connection?: Connection
  private listeners = new Set<(event: RuntimeEvent) => void>()
  private bindings = new Map<string, string>()
  private observations = new Map<string, SavedObservation>()
  private tail = Promise.resolve()
  private running?: { session: string; abort: AbortController; done: Promise<void> }
  private manualPointer?: string
  private config?: ScrcpyVideoStreamPacket
  private gop: ScrcpyVideoStreamPacket[] = []
  private gopBytes = 0
  private closed = false
  private disconnecting = false
  private controlRevision = 0
  private sessionRevisions = new Map<string, number>()
  private eventReads = new Map<string,Set<AbortController>>()
  private manualPending = 0
  private manualWaiters = new Set<() => void>()
  constructor(readonly backend: AndroidBackend = new DeviceService(), readonly tasks: TaskLedger = new TaskLedger(), readonly results: ResultStore = new ResultStore()) {}
  private emit(event: RuntimeEvent) { for (const listener of this.listeners) { try { listener(event) } catch { /* One closed viewer must not stop capture or Agent work. */ } } }
  private changed() { this.emit({ type: 'state', state: { ...this.state } }) }
  private invalidate() { this.state.revision++; this.observations.clear() }
  private failed(error: unknown) {
    this.controlRevision++; this.invalidate()
    this.manualPointer = undefined; this.notifyManual()
    Object.assign(this.state, { state: 'error', error: String((error as Error)?.message ?? error), mode: 'idle', owner: null, lastAction: '连接中断，请重新连接' })
    this.running?.abort.abort(error); this.config = undefined; this.gop = []; this.gopBytes = 0
    this.changed()
  }
  async ensure(serial: string): Promise<VideoSession> {
    if (this.closed || this.disconnecting) throw new Error('Android 插件已停用或正在断开')
    if (this.connection) {
      if (this.connection.serial !== serial) throw new Error('另一台手机已连接，请先断开并明确重新绑定')
      return this.connection.ready
    }
    const connection = { serial, abort: new AbortController() } as Connection
    if(this.backend instanceof DeviceService&&this.extensions){this.activeMedia={...this.extensions.media.value};Object.assign(this.backend.config,this.activeMedia)}
    this.connection = connection
    this.config = undefined; this.gop = []; this.gopBytes = 0; this.invalidate()
    Object.assign(this.state, { state: 'connecting', serial, error: null, packets: 0, bytes: 0, width: 0, height: 0, connectedAt: null })
    this.changed()
    connection.ready = this.backend.open(serial, connection.abort.signal, error => this.emit({ type: 'input-error', error })).then(video => {
      connection.video = video
      connection.abort.signal.throwIfAborted()
      Object.assign(this.state, { state: 'streaming', connectedAt: Date.now() })
      this.emit({ type: 'hello', codec: video.codec, deviceName: video.deviceName }); this.changed()
      connection.done = this.pump(connection, video)
      connection.audioDone=this.pumpAudio(connection,video)
      return video
    }).catch(async error => {
      await connection.video?.close()
      if (this.connection === connection) { this.connection = undefined; if (!this.closed && !this.disconnecting) this.failed(error) }
      throw error
    })
    return connection.ready
  }
  private async pumpAudio(connection:Connection,video:VideoSession){
    const audio=video.audio
    this.audioStatus=audio?.status??'disabled';this.emit({type:'audio-state',status:this.audioStatus,...(audio?.error?{error:audio.error}:{})})
    if(!audio?.read)return
    try{while(!connection.abort.signal.aborted){const result=await audio.read();if(result.done){if(!connection.abort.signal.aborted&&this.connection===connection)throw new Error('手机音频流已结束，视频仍可使用');break}if(result.value.type==='data')this.emit({type:'audio-packet',pts:result.value.pts??0n,data:result.value.data})}}
    catch(error){if(!connection.abort.signal.aborted&&this.connection===connection){this.audioStatus='errored';this.emit({type:'audio-state',status:'errored',error:String(error)})}}
  }
  private async pump(connection: Connection, video: VideoSession) {
    try {
      while (!connection.abort.signal.aborted) {
        const { done, value: packet } = await video.read()
        if (done) { if (!connection.abort.signal.aborted) throw new Error('手机视频连接已结束'); break }
        if (packet.type === 'session') {
          this.state.width = packet.width; this.state.height = packet.height
          this.config = undefined; this.gop = []; this.gopBytes = 0; this.invalidate(); this.changed()
        } else {
          this.state.packets++; this.state.bytes += packet.data.byteLength
          if (packet.type === 'configuration') this.config = packet
          if (packet.type === 'data') {
            if (packet.keyframe) { this.gop = []; this.gopBytes = 0 }
            if (packet.keyframe || this.gop.length) { this.gop.push(packet); this.gopBytes += packet.data.byteLength }
            if (this.gopBytes > 4 * 1024 * 1024 || this.gop.length > 600) { this.gop = []; this.gopBytes = 0 }
          }
        }
        this.emit({ type: 'packet', packet, epoch: video.input.geometry.epoch })
      }
    } catch (error) {
      if (!connection.abort.signal.aborted && this.connection === connection) this.failed(error)
    } finally {
      await video.close()
      if (this.connection === connection) { this.connection = undefined; if (this.state.state !== 'error') this.state.state = 'idle'; this.changed() }
    }
  }
  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    const video = this.connection?.video
    if (video) {
      listener({ type: 'hello', codec: video.codec, deviceName: video.deviceName })
      if (video.input.geometry.epoch) listener({ type: 'packet', packet: { type: 'session', isClientResize: false, width: video.input.geometry.width, height: video.input.geometry.height }, epoch: video.input.geometry.epoch })
      if (this.config && this.gop.length) {
        listener({ type: 'packet', packet: this.config, epoch: video.input.geometry.epoch })
        for (const packet of this.gop) listener({ type: 'packet', packet, epoch: video.input.geometry.epoch })
      } else void video.resetVideo().catch(error => this.emit({ type: 'input-error', error: String(error) }))
    }
    this.listeners.add(listener); listener({ type: 'state', state: { ...this.state } })
    listener({type:'audio-state',status:this.audioStatus})
    return () => { this.listeners.delete(listener) }
  }
  async list(session?: string) { return { devices: await this.backend.list(), binding: session ? this.bindings.get(session) ?? null : null, runtime: { ...this.state } } }
  async resetVideo(){await this.connection?.video?.resetVideo()}
  async bind(session: string, serial?: string): Promise<string> {
    const existing = this.bindings.get(session)
    if (existing && (!serial || serial === existing)) return existing
    const devices = (await this.backend.list()).filter(device => device.state === 'device')
    if (!serial) { if (devices.length !== 1) throw new Error('请先调用 android_devices，并用 android_bind 明确选择设备'); serial = devices[0].serial }
    if (!devices.some(device => device.serial === serial)) throw new Error('指定手机未连接或未授权')
    if (existing && existing !== serial) this.invalidate()
    this.bindings.set(session, serial); return serial
  }
  async deviceControl(session:string,action:DeviceAction,signal:AbortSignal){return this.exclusive(session,signal,'设备控制：'+action,async video=>{this.invalidate();await video.input.control(action);return{status:'sent',action,verify_with:'android_observe'}})}
  private async readDevice<T>(session:string,signal:AbortSignal,work:(serial:string)=>Promise<T>){
    signal.throwIfAborted();const revision=this.sessionRevisions.get(session)??0
    if(this.closed||this.disconnecting)throw new Error('手机服务已关闭或正在断开')
    const result=await work(await this.bind(session));signal.throwIfAborted()
    if(this.closed||revision!==(this.sessionRevisions.get(session)??0))throw new Error('手机任务已结束，请重新发起查询')
    return result
  }
  async deviceState(session:string,signal:AbortSignal){if(!this.backend.deviceState)throw new Error('当前后端不支持设备状态查询');return this.readDevice(session,signal,serial=>this.backend.deviceState!(serial,signal))}
  private async readEvent<T>(session:string,signal:AbortSignal,work:(serial:string,signal:AbortSignal)=>Promise<T>){
    const abort=new AbortController(),set=this.eventReads.get(session)??new Set<AbortController>();set.add(abort);this.eventReads.set(session,set)
    const combined=AbortSignal.any([signal,abort.signal])
    try{return await this.readDevice(session,combined,serial=>work(serial,combined))}finally{set.delete(abort);if(!set.size&&this.eventReads.get(session)===set)this.eventReads.delete(session)}
  }
  async notifications(session:string,query:NotificationQuery,signal:AbortSignal){validateNotificationQuery(query);if(!this.backend.notifications)throw new Error('当前后端不支持通知读取');return this.readEvent(session,signal,(serial,operationSignal)=>this.backend.notifications!(serial,query,operationSignal))}
  async waitNotification(session:string,options:WaitNotificationOptions,signal:AbortSignal){validateWaitNotification(options);if(!this.backend.notifications)throw new Error('当前后端不支持通知读取');return this.readEvent(session,signal,(serial,operationSignal)=>waitNotification((query,readSignal)=>this.backend.notifications!(serial,query,readSignal),options,operationSignal))}
  async waitApp(session:string,options:WaitAppOptions,signal:AbortSignal){validateWaitApp(options);if(!this.backend.foregroundState)throw new Error('当前后端不支持前台查询');return this.readEvent(session,signal,(serial,operationSignal)=>waitApp(readSignal=>this.backend.foregroundState!(serial,readSignal),options,operationSignal))}
  async appInfo(session:string,name:string,signal:AbortSignal){packageName(name);if(!this.backend.appInfo)throw new Error('当前后端不支持应用信息查询');return this.readDevice(session,signal,serial=>this.backend.appInfo!(serial,name,signal))}
  async mediaQuery(session:string,options:MediaQuery,signal:AbortSignal){validateMediaQuery(options);if(!this.extensions)throw new Error('媒体查询服务尚未就绪');return this.readDevice(session,signal,serial=>queryMedia(this.extensions!.files.device,serial,options,signal))}
  async pickFile(session:string,options:PickFileOptions,signal:AbortSignal){
    validatePickFile(options);if(options.expected_caller_package)packageName(options.expected_caller_package)
    return this.exclusive(session,signal,'操作系统文件选择器',async(video,serial,operationSignal)=>{
      if(!this.backend.deviceState)throw new Error('当前后端无法核对选择器前台状态')
      return pickFile({signal:operationSignal,state:()=>this.backend.deviceState!(serial,operationSignal),capture:async()=>{const value=await this.capture(session,video,serial,operationSignal,true);return{...value,xml:value.xml!}},press:async(capture,target)=>{
        const observation=this.observed(session,capture.observation.observation_id,video),point=this.location(observation,video,(target.bounds[0]+target.bounds[2])/2,(target.bounds[1]+target.bounds[3])/2)
        this.invalidate();operationSignal.throwIfAborted();await video.input.send({kind:'pointer',phase:'down',...point});await delay(60,undefined,{signal:operationSignal});operationSignal.throwIfAborted();await video.input.send({kind:'pointer',phase:'up',...point})
      },type:async(capture,text)=>{
        const observation=this.observed(session,capture.observation.observation_id,video)
        if(!observation.elements.some(element=>element.editable&&element.focused&&/\bid\/search_src_text$/.test(element.resource_id)))throw new Error('没有已聚焦的选择器搜索输入框，未输入')
        this.invalidate();operationSignal.throwIfAborted();await video.input.send({kind:'key',key:'selectAll'});operationSignal.throwIfAborted();await video.input.send({kind:'text',text,method:'paste'});operationSignal.throwIfAborted();await video.input.send({kind:'key',key:'enter'})
      }},options)
    })
  }
  async openUri(session:string,value:string,targetPackage:string|undefined,signal:AbortSignal){viewUri(value);if(targetPackage)packageName(targetPackage);return this.exclusive(session,signal,'打开手机链接',async(_video,serial,operationSignal)=>{if(!this.backend.openUri)throw new Error('当前后端不支持链接直达');this.invalidate();return this.backend.openUri(serial,value,targetPackage,operationSignal)})}
  async stopApp(session:string,name:string,signal:AbortSignal){packageName(name);return this.exclusive(session,signal,'停止应用：'+name,async(_video,serial,operationSignal)=>{if(!this.backend.stopApp)throw new Error('当前后端不支持停止应用');this.invalidate();return this.backend.stopApp(serial,name,operationSignal)})}
  async presentFile(session:string,action:'open'|'share',path:string,mime:string|undefined,targetPackage:string|undefined,signal:AbortSignal){
    if(targetPackage)packageName(targetPackage)
    return this.exclusive(session,signal,action==='open'?'打开手机文件':'分享手机文件',async(_video,serial,operationSignal)=>{
      if(!this.extensions||!this.backend.presentFile)throw new Error('当前后端不支持文件打开或分享')
      const file=await this.extensions.files.remote.prepareFile(serial,path,mime,operationSignal);operationSignal.throwIfAborted();this.invalidate()
      return{...file,...await this.backend.presentFile(serial,action,file.content_uri,file.mime_type,targetPackage,file.user_id,operationSignal)}
    })
  }
  async gesture(session:string,id:string,options:GestureOptions,signal:AbortSignal,after:AfterActionOptions={}){validateAfterAction(after);return this.exclusive(session,signal,'手机手势：'+options.kind,async(video,serial,operationSignal)=>{
    const observation=this.observed(session,id,video),frames=planGesture(options,observation.width,observation.height).map(frame=>({...frame,points:frame.points.map(p=>this.location(observation,video,p.x,p.y))}))
    this.invalidate();const start=Date.now()
    try{for(const frame of frames){operationSignal.throwIfAborted();const wait=frame.at_ms-(Date.now()-start);if(wait>0)await delay(wait,undefined,{signal:operationSignal});operationSignal.throwIfAborted();await video.input.gestureFrame(frame.points)}}
    finally{await video.input.send({kind:'release'}).catch(()=>{})}
    operationSignal.throwIfAborted();return this.afterAction(session,video,serial,operationSignal,{status:'sent',serial,kind:options.kind,contacts:options.kind==='double_tap'?1:2,duration_ms:frames.at(-1)!.at_ms,verify_with:'android_observe',guidance:'手势只发送一次；应用可能不支持该手势。请用新的观察验证实际效果，不要直接重复。'},after)
  })}
  async clipboard(session:string,action:'get'|'set',text:string|undefined,signal:AbortSignal){return this.exclusive(session,signal,action==='get'?'读取手机剪贴板':'写入手机剪贴板',async video=>{
    if(action==='get'){if(!video.getClipboard)throw new Error('当前后端不支持剪贴板读取');return{status:'read',text:await video.getClipboard()}}
    if(action!=='set'||text===undefined)throw new Error('写入剪贴板需要 text');this.invalidate();await video.input.setClipboard(text);return{status:'written',characters:text.length,pasted:false}
  })}
  private async waitForManual(signal: AbortSignal, check: () => void) {
    while (this.manualPending || this.manualPointer) {
      check()
      let wake!: () => void
      const changed = new Promise<void>(resolve => { wake = resolve; this.manualWaiters.add(wake) })
      try { await waitFor(changed,signal) } finally { this.manualWaiters.delete(wake) }
    }
    signal.throwIfAborted()
  }
  private notifyManual() { for (const wake of this.manualWaiters) wake(); this.manualWaiters.clear() }
  private async interrupt(reason: string) {
    const running = this.running
    running?.abort.abort(new Error(reason))
    await running?.done
  }
  /** Serialize operations, without reserving the phone between tool calls. */
  private async exclusive<T>(session: string, signal: AbortSignal, label: string, operation: (video: VideoSession, serial: string, signal: AbortSignal) => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    const controlRevision = this.controlRevision, sessionRevision = this.sessionRevisions.get(session) ?? 0
    const check = () => {
      signal.throwIfAborted()
      if (this.closed || this.disconnecting || controlRevision !== this.controlRevision) throw new Error('连接状态已变化，请重新观察后操作')
      if (sessionRevision !== (this.sessionRevisions.get(session) ?? 0)) throw new Error('手机任务已结束，请重新发起操作')
    }
    const result = this.tail.then(async () => {
      check(); await this.waitForManual(signal,check); check()
      const serial = await this.bind(session)
      const video = await waitFor(this.ensure(serial),signal)
      const end = Date.now() + 5000
      while (!video.input.geometry.epoch) { check(); if (Date.now() > end) throw new Error('等待手机画面尺寸超时'); await delay(20,undefined,{signal}) }
      await this.waitForManual(signal,check); check()
      this.state.owner = session; this.state.mode = 'agent'; this.state.lastAction = label; this.changed()
      const abort = new AbortController(), combined = AbortSignal.any([signal,abort.signal])
      let complete!: () => void
      const done = new Promise<void>(resolve => { complete = resolve })
      this.running = {session,abort,done}
      try { return await operation(video,serial,combined) }
      catch (error) { if (combined.aborted) throw combined.reason; throw error }
      finally {
        try { await video.input.send({kind:'release'}).catch(() => {}) }
        finally {
          if (this.running?.abort === abort) this.running = undefined
          this.state.owner = null; this.state.mode = 'idle'
          if (combined.aborted) this.invalidate()
          complete(); this.changed()
        }
      }
    })
    this.tail = result.then(() => {},() => {})
    return result
  }
  async observe(session: string, signal: AbortSignal, options: ObserveOptions = {}): Promise<{ observation: Observation; png: Buffer }> {
    validateObserve(options)
    return this.exclusive(session, signal, '观察手机', (video, serial, operationSignal) => this.capture(session, video, serial, operationSignal, false, options))
  }
  private async capture(session: string, video: VideoSession, serial: string, operationSignal: AbortSignal,raw=false,options: ObserveOptions = {}): Promise<{ observation: Observation; png: Buffer;xml?:string }> {
      const revision = this.state.revision, epoch = video.input.geometry.epoch
      let xml = '', treeError: string | null = null
      try { if (options.mode !== 'screenshot') xml = await this.backend.dumpUi(serial, operationSignal) }
      catch (error) { operationSignal.throwIfAborted(); treeError = String((error as Error).message ?? error).slice(0, 400) }
      const png = await this.backend.screenshot(serial, operationSignal)
      const size = pngSize(png)
      let tree = { elements: [] as Observation['elements'], truncated: false, rotation: 0 }
      if (xml) { try { tree = parseHierarchy(xml, size.width, size.height) } catch (error) { treeError = String((error as Error).message ?? error) } }
      operationSignal.throwIfAborted()
      if (revision !== this.state.revision || epoch !== video.input.geometry.epoch) throw new Error('观察期间画面发生旋转或人工操作，请重新观察')
      const transformed = options.region || options.scale !== undefined ? transformScreen(png, options) : undefined
      const observation: Observation = { observation_id: randomBytes(16).toString('hex'), serial, captured_at: new Date().toISOString(), width: size.width, height: size.height, rotation: options.mode === 'screenshot' ? null : tree.rotation, elements: tree.elements, tree_truncated: tree.truncated, tree_error: treeError, revision, video_epoch: epoch, capture_mode: options.mode ?? 'ui', ...(transformed ? { image_transform: transformed.image_transform } : {}) }
      this.observations.set(session, { observation, session, used: false })
      return { observation, png: transformed?.png ?? png,...(raw?{xml}:{}) }
  }
  async waitImage(session: string, options: ImageWaitOptions, signal: AbortSignal) {
    validateImageWait(options)
    return this.exclusive(session, signal, '等待画面变化', async (video, serial, operationSignal) => {
      const started = Date.now(), timeout = options.timeout_ms ?? 10000, interval = options.interval_ms ?? Math.min(500, timeout)
      const ratio = options.change_ratio ?? 0.01, threshold = options.pixel_threshold ?? 16
      // Keep the timeout controller alive through its timer. A temporary AbortSignal.timeout
      // inside AbortSignal.any can be garbage-collected on supported Node versions during PNG allocation.
      const timeoutController = new AbortController()
      const timer = setTimeout(() => timeoutController.abort(new Error('图像等待超时')), timeout)
      const deadline = AbortSignal.any([operationSignal, timeoutController.signal])
      let current: { observation: Observation; png: Buffer } | undefined
      let attempts = 0, difference: number | null = null, stableSince = 0, stableFor = 0, region = options.region
      const result = (status: 'met' | 'timed_out' | 'geometry_changed') => ({ ...current!, status, condition: options.condition, attempts, elapsed_ms: Date.now() - started, changed_ratio: difference, stable_for_ms: stableFor, comparison_region: region!, change_ratio: ratio, pixel_threshold: threshold, comparison: options.condition === 'image_changed' ? 'first_frame' : 'stability_anchor', measurement_note: 'Only pixel differences are measured. Stable/changed does not mean loading, battle or task completion. Inspect the screenshot. The returned capture may predate the timeout.' })
      try {
        current = await this.capture(session, video, serial, deadline, false, { mode: 'screenshot' }); attempts++
        region ??= { x: 0, y: 0, width: current.observation.width, height: current.observation.height }
        validateRegion(region, current.observation)
        let anchor = decodeScreen(current.png)
        const epoch = current.observation.video_epoch
        stableSince = Date.now()
        while (true) {
          await delay(interval, undefined, { signal: deadline })
          current = await this.capture(session, video, serial, deadline, false, { mode: 'screenshot' }); attempts++
          if (current.observation.video_epoch !== epoch || current.observation.width !== anchor.width || current.observation.height !== anchor.height) { difference = null; stableFor = 0; return result('geometry_changed') }
          const next = decodeScreen(current.png)
          difference = imageDifference(anchor, next, region, threshold)
          deadline.throwIfAborted()
          if (Date.now() - started >= timeout) return result('timed_out')
          if (options.condition === 'image_changed') { if (difference > ratio) return result('met') }
          else {
            if (difference > ratio) { anchor = next; stableSince = Date.now() }
            stableFor = Date.now() - stableSince
            if (stableFor >= (options.stable_ms ?? Math.min(1000, timeout))) return result('met')
          }
        }
      } catch (error) {
        operationSignal.throwIfAborted()
        if (deadline.aborted && current) return result('timed_out')
        throw error
      } finally { clearTimeout(timer) }
    })
  }
  private async afterAction<T extends object>(session: string, video: VideoSession, serial: string, signal: AbortSignal, result: T, options: AfterActionOptions): Promise<T & { observation?: Observation; png?: Buffer; screenshot_error?: string }> {
    if (!options.return_screenshot) return result
    // Stay inside the same exclusive operation: manual input cancels the delay/capture, never the next unrelated action.
    try {
      const epoch = video.input.geometry.epoch
      await delay(options.screenshot_delay_ms ?? 300, undefined, { signal })
      if (video.input.geometry.epoch !== epoch) throw new Error('操作后画面发生旋转，请重新观察')
      return { ...result, ...await this.capture(session, video, serial, signal, false, { mode: 'screenshot' }) }
    } catch (error) {
      signal.throwIfAborted()
      return { ...result, screenshot_error: String((error as Error).message ?? error).slice(0, 400) }
    }
  }
  async find(session: string, query: TargetQuery, maxAttempts: number, intervalMs: number, signal: AbortSignal) {
    validateTarget(query)
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3 || !Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 1000) throw new Error('查找次数须为 1–3 次，间隔须为 100–1000 ms')
    return this.exclusive(session, signal, '查找手机界面目标', async (video, serial, operationSignal) => {
      const deadline = AbortSignal.any([operationSignal, AbortSignal.timeout(45_000)])
      for (let attempts = 1; ; attempts++) {
        this.state.lastAction = `查找手机目标（${attempts}/${maxAttempts}）`; this.changed()
        const result = await this.capture(session, video, serial, deadline)
        const matches = matchTargets(result.observation.elements, query)
        if (matches.length || attempts === maxAttempts) return { ...result, matches, attempts, status: matches.length ? 'found' as const : result.observation.tree_error ? 'tree_unavailable' as const : 'not_found' as const }
        await delay(intervalMs, undefined, { signal: deadline })
      }
    })
  }
  async apps(session: string, query: string, limit: number, signal: AbortSignal, offset = 0) {
    if (query.length > 256 || !Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 2000) throw new Error('应用查询最多 256 字，返回数量须为 1–100，offset 须为 0–2000')
    return this.exclusive(session, signal, '读取手机应用列表', async (_video, serial, operationSignal) => {
      const all = await this.backend.listApps(serial, operationSignal)
      operationSignal.throwIfAborted()
      const matched = all.filter(app => appMatches(app, query))
      const next = offset + limit < matched.length ? offset + limit : null
      return { serial, apps: matched.slice(offset, offset + limit), matched_count: matched.length, total_count: all.length, offset, next_offset: next, truncated: next !== null }
    })
  }
  private navigate<T>(session: string, signal: AbortSignal, label: string, work: (driver: NavigationDriver) => Promise<T>) {
    const operationDeadline = AbortSignal.any([signal, AbortSignal.timeout(120_000)])
    return this.exclusive(session, operationDeadline, label, async (video, serial, operationSignal) => {
      const deadline = operationSignal
      const driver: NavigationDriver = {
        signal: deadline,
        capture: () => this.capture(session,video,serial,deadline),
        press: async (capture, element, duration) => {
          const observation = this.observed(session,capture.observation.observation_id,video)
          const point = this.location(observation,video,(element.bounds[0]+element.bounds[2])/2,(element.bounds[1]+element.bounds[3])/2)
          this.invalidate(); deadline.throwIfAborted()
          await video.input.send({kind:'pointer',phase:'down',...point})
          await delay(duration,undefined,{signal:deadline})
          deadline.throwIfAborted(); await video.input.send({kind:'pointer',phase:'up',...point})
        },
        scroll: async (capture, container, direction) => {
          const observation = this.observed(session,capture.observation.observation_id,video)
          const [left,top,right,bottom] = container.bounds
          if (bottom-top < 80 || right-left < 30) throw new Error('可滚动区域过小，请改用观察后的明确坐标')
          const x = (left+right)/2, high = top+(bottom-top)*0.30, low = top+(bottom-top)*0.70
          const start = this.location(observation,video,x,direction === 'down' ? low : high), end = this.location(observation,video,x,direction === 'down' ? high : low)
          this.invalidate(); deadline.throwIfAborted()
          await video.input.send({kind:'pointer',phase:'down',...start})
          for (let i=1;i<=24;i++) { await delay(30,undefined,{signal:deadline}); deadline.throwIfAborted(); await video.input.send({kind:'pointer',phase:'move',...start,x:Math.round(start.x+(end.x-start.x)*i/24),y:Math.round(start.y+(end.y-start.y)*i/24)}) }
          // Finish with a stationary sample after a hold to suppress Android fling velocity.
          await delay(220,undefined,{signal:deadline}); deadline.throwIfAborted()
          await video.input.send({kind:'pointer',phase:'move',...end})
          await video.input.send({kind:'pointer',phase:'up',...end}); deadline.throwIfAborted()
        },
      }
      return work(driver)
    })
  }
  async tapTarget(session: string, query: TargetQuery, options: Parameters<typeof tapTarget>[2], signal: AbortSignal) { return this.navigate(session,signal,'定位并点击手机目标',driver => tapTarget(driver,query,options)) }
  async waitUi(session: string, query: TargetQuery, options: Parameters<typeof waitForUi>[2], signal: AbortSignal) { return this.navigate(session,signal,'等待手机界面条件',driver => waitForUi(driver,query,options)) }
  async scrollFind(session: string, query: TargetQuery, options: ScrollOptions, signal: AbortSignal) { return this.navigate(session,signal,'跨屏查找手机目标',driver => scrollPages(driver,query,{...options,mode:'find'})) }
  async readList(session: string, query: TargetQuery, options: ScrollOptions & { max_items?: number }, signal: AbortSignal, checkpoint?:Parameters<typeof scrollPages>[3]) { return this.navigate(session,signal,'跨屏读取手机列表',driver => scrollPages(driver,query,{...options,mode:'read'},checkpoint)) }
  async readPage(session:string,query:TargetQuery,options:PageReadOptions,signal:AbortSignal,checkpoint?:Parameters<typeof readPage>[3]){return this.navigate(session,signal,'跨屏阅读手机正文',driver=>readPage(driver,query,options,checkpoint))}
  async openAppByName(session: string, name: string, signal: AbortSignal) {
    if (!normalizeName(name) || name.length > 256) throw new Error('应用名称长度须在 1–256 之间')
    return this.exclusive(session, signal, `启动应用：${name}`, async (_video, serial, operationSignal) => {
      const resolution = resolveApp(await this.backend.listApps(serial, operationSignal), name)
      operationSignal.throwIfAborted()
      if (resolution.status !== 'resolved') return { serial, ...resolution }
      this.invalidate(); await this.backend.openApp(serial, resolution.app.package_name, operationSignal)
      operationSignal.throwIfAborted()
      return { status: 'sent' as const, serial, app: resolution.app, action: 'open_app', verify_with: 'android_observe' }
    })
  }
  private observed(session: string, id: string, video: VideoSession): Observation {
    const saved = this.observations.get(session)
    if (!saved || saved.used || saved.observation.observation_id !== id || saved.observation.revision !== this.state.revision || saved.observation.video_epoch !== video.input.geometry.epoch) throw new Error('观察已失效，请调用 android_observe 后再操作')
    if (Date.now() - Date.parse(saved.observation.captured_at) > 60_000) throw new Error('观察超过 60 秒，请重新观察')
    saved.used = true; return saved.observation
  }
  private location(observation: Observation, video: VideoSession, x: number, y: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x >= observation.width || y < 0 || y >= observation.height) throw new Error('坐标超出截图范围')
    const geometry = video.input.geometry
    return { ...geometry, x: Math.min(geometry.width - 1, Math.floor(x / observation.width * geometry.width)), y: Math.min(geometry.height - 1, Math.floor(y / observation.height * geometry.height)) }
  }
  async tap(session: string, id: string, target: { elementId?: string; x?: number; y?: number; durationMs?: number }, signal: AbortSignal, after: AfterActionOptions = {}) {
    validateAfterAction(after)
    return this.exclusive(session, signal, '点击手机', async (video, _serial, operationSignal) => {
      const observation = this.observed(session, id, video)
      let x = target.x, y = target.y
      if (target.elementId) { const element = observation.elements.find(element => element.element_id === target.elementId); if (!element) throw new Error('元素不属于本次观察'); x = (element.bounds[0] + element.bounds[2]) / 2; y = (element.bounds[1] + element.bounds[3]) / 2 }
      if (x === undefined || y === undefined) throw new Error('提供 element_id 或截图中的 x、y 坐标')
      const duration = target.durationMs ?? 60
      if (!Number.isInteger(duration) || duration < 40 || duration > 3000) throw new Error('按压时长须在 40–3000 ms 之间')
      const point = this.location(observation, video, x, y)
      this.invalidate(); operationSignal.throwIfAborted()
      await video.input.send({ kind: 'pointer', phase: 'down', ...point })
      await delay(duration, undefined, { signal: operationSignal })
      await video.input.send({ kind: 'pointer', phase: 'up', ...point })
      operationSignal.throwIfAborted()
      return this.afterAction(session, video, observation.serial, operationSignal, { status: 'sent', serial: observation.serial, action: 'tap', verify_with: 'android_observe' }, after)
    })
  }
  async swipe(session: string, id: string, points: { x1: number; y1: number; x2: number; y2: number; durationMs: number }, signal: AbortSignal, after: AfterActionOptions = {}) {
    validateAfterAction(after)
    return this.exclusive(session, signal, '滑动手机', async (video, _serial, operationSignal) => {
      const observation = this.observed(session, id, video)
      const start = this.location(observation, video, points.x1, points.y1), end = this.location(observation, video, points.x2, points.y2)
      if (!Number.isInteger(points.durationMs) || points.durationMs < 100 || points.durationMs > 3000) throw new Error('滑动时长须在 100–3000 ms 之间')
      this.invalidate(); operationSignal.throwIfAborted()
      await video.input.send({ kind: 'pointer', phase: 'down', ...start })
      const steps = Math.ceil(points.durationMs / 30)
      for (let i = 1; i <= steps; i++) { await delay(points.durationMs / steps, undefined, { signal: operationSignal }); await video.input.send({ kind: 'pointer', phase: 'move', ...start, x: Math.round(start.x + (end.x - start.x) * i / steps), y: Math.round(start.y + (end.y - start.y) * i / steps) }) }
      await video.input.send({ kind: 'pointer', phase: 'up', ...end }); operationSignal.throwIfAborted()
      return this.afterAction(session, video, observation.serial, operationSignal, { status: 'sent', serial: observation.serial, action: 'swipe', verify_with: 'android_observe' }, after)
    })
  }
  async key(session: string, key: PhoneKey, signal: AbortSignal, after: AfterActionOptions = {}) {
    validateAfterAction(after)
    return this.exclusive(session, signal, `手机按键：${key}`, async (video, serial, operationSignal) => { this.invalidate(); operationSignal.throwIfAborted(); await video.input.send({ kind: 'key', key }); operationSignal.throwIfAborted(); return this.afterAction(session, video, serial, operationSignal, { status: 'sent', serial, action: key, verify_with: 'android_observe' }, after) })
  }
  async inputText(session: string, id: string, text: string, signal: AbortSignal, replace = false, after: AfterActionOptions = {}) {
    validateAfterAction(after)
    if (!text.length || text.length > 4096) throw new Error('文字长度须在 1–4096 之间')
    return this.exclusive(session, signal, '输入手机文字', async (video, serial, operationSignal) => {
      const observation = this.observed(session, id, video)
      if (!observation.elements.some(element => element.editable && element.focused)) throw new Error('当前观察中没有已聚焦的输入框，请先点击输入框，再重新观察；不会盲目粘贴')
      this.invalidate(); operationSignal.throwIfAborted()
      if (replace) { await video.input.send({ kind: 'key', key: 'selectAll' }); operationSignal.throwIfAborted() }
      await video.input.send({ kind: 'text', text, method: 'paste' }); operationSignal.throwIfAborted()
      return this.afterAction(session, video, serial, operationSignal, { status: 'sent', serial, action: 'input_text', replace, verify_with: 'android_observe' }, after)
    })
  }
  async openApp(session: string, packageName: string, signal: AbortSignal) {
    if (packageName.length > 255 || !PACKAGE_NAME.test(packageName)) throw new Error('应用包名无效')
    return this.exclusive(session, signal, `启动应用：${packageName}`, async (_video, serial, operationSignal) => { this.invalidate(); await this.backend.openApp(serial, packageName, operationSignal); operationSignal.throwIfAborted(); return { status: 'sent', serial, action: 'open_app', verify_with: 'android_observe' } })
  }
  async release(session: string) { await this.endSession(session); return {released:true} }
  async endSession(session: string, forgetBinding = false) {
    for(const abort of this.eventReads.get(session)??[])abort.abort(new Error('手机任务已结束'))
    this.observations.delete(session)
    this.sessionRevisions.set(session,(this.sessionRevisions.get(session) ?? 0)+1)
    this.notifyManual()
    if (forgetBinding) this.bindings.delete(session)
    const running = this.running
    if (running?.session === session) {
      running.abort.abort(new Error('手机任务已结束'))
      await running.done
    }
  }
  private manualTail = Promise.resolve()
  manual(viewer: string, command: InputCommand) {
    this.manualPending++
    const result = this.manualTail.then(async () => {
      if (command.kind !== 'release' || this.manualPointer === viewer) await this.interrupt('屏幕收到新的输入，当前操作已中断，请重新观察')
      return this.executeManual(viewer,command)
    }).finally(() => { this.manualPending--; this.notifyManual() })
    this.manualTail = result.catch(() => {})
    return result
  }
  private async executeManual(viewer: string, command: InputCommand) {
    if (this.disconnecting && command.kind !== 'release') throw new Error('手机正在断开')
    if (command.kind === 'release') { if (this.manualPointer !== viewer) return; this.manualPointer = undefined; await this.connection?.video?.input.send(command); return }
    if (command.kind === 'pointer' && command.phase !== 'down' && this.manualPointer !== viewer) throw new Error('触点已释放，请重新按下')
    this.invalidate()
    const video = this.connection?.video
    if (!video || this.state.state !== 'streaming') throw new Error('手机尚未连接')
    if (this.manualPointer && (command.kind !== 'pointer' || command.phase === 'down')) { await video.input.send({kind:'release'}); this.manualPointer = undefined }
    if (command.kind === 'pointer' && command.phase === 'down') this.manualPointer = viewer
    try { await video.input.send(command) } catch (error) { this.manualPointer = undefined; await video.input.send({kind:'release'}).catch(() => {}); throw error }
    if (command.kind === 'pointer' && ['up','cancel'].includes(command.phase)) this.manualPointer = undefined
  }
  async viewerClosed(viewer: string) { await this.manual(viewer, { kind: 'release' }).catch(() => {}) }
  async disconnect() {
    this.disconnecting = true
    for(const controllers of this.eventReads.values())for(const abort of controllers)abort.abort(new Error('手机连接正在断开'))
    try {
    this.controlRevision++; this.invalidate(); this.notifyManual()
    await this.interrupt('手机连接正在断开')
    await this.manualTail
    const connection = this.connection
    if (connection) { connection.abort.abort(); await connection.ready.catch(() => {}); await connection.video?.close(); await connection.done; if (this.connection === connection) this.connection = undefined }
    this.config = undefined; this.gop = []; this.manualPointer = undefined;this.audioStatus='disabled';this.emit({type:'audio-state',status:'disabled'})
    Object.assign(this.state, { state: 'idle', serial: null, owner: null, mode: 'idle', error: null, connectedAt: null, lastAction: '手机已断开' }); this.invalidate(); this.notifyManual(); this.changed()
    } finally { this.disconnecting = false }
  }
  async close() { this.closed = true; await this.disconnect(); this.listeners.clear(); await this.tasks.close(); await this.results.flush() }
}
