import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { AdbServerNodeJsClient } from '@yume-chan/adb-server-node-tcp'
import { AdbScrcpyClient, AdbScrcpyOptions5_0_1,type AdbScrcpyAudioStreamMetadata } from '@yume-chan/adb-scrcpy'
import type { Adb } from '@yume-chan/adb'
import { ScrcpyControlMessageType,type ScrcpyVideoStreamPacket,type ScrcpyAudioStreamPacket } from '@yume-chan/scrcpy'
import { ReadableStream, type ReadableStreamDefaultReader } from '@yume-chan/stream-extra'
import { InputController } from './input.js'
import { parseApps, PACKAGE_NAME, type AndroidApp } from './apps.js'
import { discoverAdb, type AdbInstallation } from './adb.js'
import { verifyRuntimeAssets } from './runtime-assets.js'
import { ensureAdbServer } from './adb-server.js'
import { diagnoseError } from './diagnostics.js'
import {parseDeviceState,parseAppInfo,parseActivityStart,packageName as checkedPackage,viewUri} from './device-state.js'
import {quoteAndroidArg} from './android-shell.js'
import {readNotifications,type NotificationQuery} from './notifications.js'
import {readForeground} from './event-waits.js'

const run = promisify(execFile)
export const SERVER_VERSION = '5.0.1'
export const SERVER_SHA256 = '764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536'
export interface DeviceConfig { adbPath: string; adbPort: number; maxSize: number; maxFps: number; videoBitRate: number; connectTimeoutMs: number;audio:boolean;audioSource:'output'|'playback' }
export const DEFAULT_CONFIG: DeviceConfig = { adbPath: 'auto', adbPort: 5037, maxSize: 1280, maxFps: 30, videoBitRate: 4_000_000, connectTimeoutMs: 15_000,audio:false,audioSource:'output' }
export interface DeviceInfo { serial: string; state: string; model: string }
export interface VideoSession {
  codec: number
  deviceName: string
  input: InputController
  resetVideo(): Promise<void>
  read(): Promise<ReadableStreamReadResult<ScrcpyVideoStreamPacket>>
  close(): Promise<void>
  getClipboard?():Promise<string>
  audio?:{status:'disabled'|'errored'|'success';error?:string;read?:()=>Promise<ReadableStreamReadResult<ScrcpyAudioStreamPacket>>}
}

/** Connect to the existing local ADB server; this service never kills it. */
export class DeviceService {
  readonly client: AdbServerNodeJsClient
  readonly config: DeviceConfig
  private installation?: Promise<AdbInstallation>
  constructor(config: Partial<DeviceConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    for (const key of ['adbPort', 'maxSize', 'maxFps', 'videoBitRate', 'connectTimeoutMs'] as const) {
      if (!Number.isSafeInteger(this.config[key]) || this.config[key] <= 0) throw new Error(`Invalid ${key}`)
    }
    this.client = new AdbServerNodeJsClient({ host: '127.0.0.1', port: this.config.adbPort })
  }
  async adbInfo() {
    if (!this.installation) this.installation = discoverAdb(this.config.adbPath).catch(error => { this.installation = undefined; throw error })
    return this.installation
  }
  setAdbPath(path: string) { this.config.adbPath = path; this.installation = undefined }
  private async adbPath() { return (await this.adbInfo()).path }
  private async shell(serial:string,args:string[],signal:AbortSignal,timeout=10_000){
    signal.throwIfAborted();const path=await this.adbPath();signal.throwIfAborted()
    const result=await run(path,['-P',String(this.config.adbPort),'-s',serial,'shell',args.map(quoteAndroidArg).join(' ')],{windowsHide:true,timeout,maxBuffer:8*1024*1024,signal})
    if(/(?:^|\n)\s*(?:Permission Denial|SecurityException|Error:)/i.test(result.stdout+result.stderr)){
      const message=(result.stdout+result.stderr).slice(0,1000)
      throw Object.assign(new Error(message),{stdout:message})
    }
    return result.stdout
  }
  /** Internal structured argv bridge; no raw shell command tool is registered. */
  runShell(serial:string,args:string[],signal:AbortSignal,timeout=10_000){return this.shell(serial,args,signal,timeout)}
  /** Diagnostic records contain arbitrary app text, including lines that look like errors. Domain parsers validate the protocol. */
  async runDiagnostic(serial:string,args:string[],signal:AbortSignal,timeout=10000){
    signal.throwIfAborted();const path=await this.adbPath();signal.throwIfAborted()
    return(await run(path,['-P',String(this.config.adbPort),'-s',serial,'shell',args.map(quoteAndroidArg).join(' ')],{windowsHide:true,timeout,maxBuffer:8*1024*1024,signal})).stdout
  }
  notifications(serial:string,query:NotificationQuery,signal:AbortSignal){return readNotifications(this,serial,query,signal)}
  foregroundState(serial:string,signal:AbortSignal){return readForeground(this,serial,signal)}
  async presentFile(serial:string,action:'open'|'share',uri:string,mime:string,targetPackage:string|undefined,userId:number,signal:AbortSignal){
    if(!/^content:\/\/media\/external\/file\/\d+$/.test(uri))throw new Error('文件 URI 不是本次准备的媒体提供器 URI')
    if(targetPackage)checkedPackage(targetPackage)
    if(!Number.isSafeInteger(userId)||userId<0||(await this.shell(serial,['am','get-current-user'],signal)).trim()!==String(userId))throw new Error('Android 用户已变化，未打开或共享文件')
    let text:string
    try{text=await this.shell(serial,['am','start','-W','--user',String(userId),'--grant-read-uri-permission','-a',action==='open'?'android.intent.action.VIEW':'android.intent.action.SEND','-d',uri,'-t',mime,...(action==='share'?['--eu','android.intent.extra.STREAM',uri]:[]),...(targetPackage?['-p',targetPackage]:[])],signal,20000)}catch(error){signal.throwIfAborted();const details=error as Error&{stdout?:string;stderr?:string};if(!details.stdout&&!details.stderr)throw error;text=(details.stdout??'')+(details.stderr??'')}
    const launch=parseActivityStart(text)
    return{serial,action,...launch,read_permission_requested:'temporary',write_permission_requested:false,send_action_performed:false,delivery_confirmed:false,verify_with:['android_device_state','android_observe'],guidance:launch.status!=='sent'?'系统未确认打开或分享，请检查错误和实际界面，不要声称已显示或已发送，也不要盲目重试。':action==='share'?'已请求系统分享入口或目标应用。需要观察并选择接收方；此工具不点击发送，不证明接收方已收到文件。':'系统接受请求不证明文件已正确显示，可能出现打开方式选择器、应用授权或错误页面；请重新观察。'}
  }
  async deviceState(serial:string,signal:AbortSignal){
    const start=Date.now(),commands={activity:['dumpsys','activity','activities'],window:['dumpsys','window'],input:['dumpsys','input_method'],power:['dumpsys','power'],display:['dumpsys','display'],battery:['dumpsys','battery'],connectivity:['dumpsys','connectivity']}
    const entries=Object.entries(commands),results=await Promise.allSettled(entries.map(([,args])=>this.shell(serial,args,signal))),parts:Record<string,string>={},unavailable:{source:string;error:string}[]=[]
    signal.throwIfAborted()
    results.forEach((result,index)=>{const source=entries[index]![0];if(result.status==='fulfilled')parts[source]=result.value;else unavailable.push({source,error:String((result.reason as Error)?.message??result.reason).slice(0,200)})})
    return{status:unavailable.length?'partial':'read',serial,captured_at:new Date().toISOString(),sampled_over_ms:Date.now()-start,...parseDeviceState(parts),unavailable}
  }
  async appInfo(serial:string,name:string,signal:AbortSignal){
    checkedPackage(name);const current=(await this.shell(serial,['am','get-current-user'],signal)).trim();if(!/^\d+$/.test(current))throw new Error('无法确定当前 Android 用户，未查询其他用户的应用')
    const text=await this.shell(serial,['dumpsys','package',name],signal)
    return{serial,captured_at:new Date().toISOString(),...parseAppInfo(text,name,Number(current))}
  }
  async openUri(serial:string,value:string,targetPackage:string|undefined,signal:AbortSignal){
    const checked=viewUri(value);if(targetPackage)checkedPackage(targetPackage)
    let text:string
    try{text=await this.shell(serial,['am','start','-W','--user','current','-a',checked.action,'-d',checked.uri,...(targetPackage?['-p',targetPackage]:[])],signal,20_000)}
    catch(error){signal.throwIfAborted();const details=error as Error&{stdout?:string;stderr?:string};if(!details.stdout&&!details.stderr)throw error;text=(details.stdout??'')+(details.stderr??'')||details.message}
    return{serial,...parseActivityStart(text),verify_with:['android_device_state','android_observe']}
  }
  async stopApp(serial:string,name:string,signal:AbortSignal){
    checkedPackage(name);if(['android','com.android.systemui','com.android.shell'].includes(name))throw new Error('不能用停止应用工具停止 Android 系统基础服务')
    const before=await this.appInfo(serial,name,signal)
    if(before.status!=='installed')return{status:before.status,serial,package_name:name,guidance:'目标未安装于当前用户，或系统信息不足；未发送停止指令'}
    if(before.stopped===true)return{status:'stopped',serial,package_name:name,already_stopped:true,data_cleared:false}
    await this.shell(serial,['am','force-stop','--user',String(before.user_id),name],signal)
    const after=await this.appInfo(serial,name,signal)
    return{status:after.user_id===before.user_id&&after.status==='installed'&&after.stopped===true?'stopped':'unconfirmed',serial,package_name:name,user_id:before.user_id,already_stopped:false,data_cleared:false,app:after,verify_with:['android_device_state','android_observe'],guidance:'停止不删除应用数据。后台任务、用户切换或应用主动恢复仍可能改变状态；后续操作前重新观察。'}
  }
  async diagnose() {
    try {
      await verifyRuntimeAssets('scrcpy')
      const adb = await this.adbInfo(), devices = await this.list()
      const authorized = devices.filter(device => device.state === 'device')
      const diagnostic = authorized.length ? { code: 'READY', message: `已发现 ${authorized.length} 台已授权手机`, recovery: '可以连接手机并在 Harness 聊天中发起任务' } : diagnoseError(new Error(devices.some(device => device.state === 'unauthorized' || device.state === 'authorizing') ? 'unauthorized' : devices.some(device => device.state === 'offline') ? 'offline' : '未发现手机'))
      return { ok: authorized.length > 0, adb, devices, diagnostic }
    } catch (error) { return { ok: false, adb: null, devices: [] as DeviceInfo[], diagnostic: diagnoseError(error) } }
  }
  async list(): Promise<DeviceInfo[]> {
    const adb = await this.adbPath()
    await ensureAdbServer(this.config.adbPort,
      async () => this.client.getVersion({ signal: AbortSignal.timeout(1500) }).then(version => version === 41, () => false),
      () => run(adb, ['-P', String(this.config.adbPort), 'start-server'], { windowsHide: true, timeout: 8000 }))
    const devices = await this.client.getDevices(['device', 'unauthorized', 'offline', 'authorizing', 'recovery', 'bootloader'])
    return devices.map(d => ({ serial: d.serial, state: d.state, model: d.model?.replaceAll('_', ' ') ?? d.serial }))
  }
  async screenshot(serial: string, signal: AbortSignal): Promise<Buffer> {
    const result = await run(await this.adbPath(), ['-P', String(this.config.adbPort), '-s', serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', windowsHide: true, timeout: 12_000, maxBuffer: 16 * 1024 * 1024, signal })
    return result.stdout
  }
  async dumpUi(serial: string, signal: AbortSignal): Promise<string> {
    const target = `/data/local/tmp/dsh-android-ui-${randomBytes(8).toString('hex')}.xml`
    const args = ['-P', String(this.config.adbPort), '-s', serial]
    const adb = await this.adbPath()
    try {
      await run(adb, [...args, 'shell', 'uiautomator', 'dump', '--compressed', target], { windowsHide: true, timeout: 15_000, signal })
      return (await run(adb, [...args, 'exec-out', 'cat', target], { windowsHide: true, timeout: 5000, maxBuffer: 2 * 1024 * 1024, signal })).stdout
    } finally {
      await run(adb, [...args, 'shell', 'rm', '-f', target], { windowsHide: true, timeout: 2000 }).catch(() => {}) // Remove only this call's randomly named temporary XML.
    }
  }
  async openApp(serial: string, packageName: string, signal: AbortSignal): Promise<void> {
    if (packageName.length > 255 || !PACKAGE_NAME.test(packageName)) throw new Error('应用包名无效')
    const result = await run(await this.adbPath(), ['-P', String(this.config.adbPort), '-s', serial, 'shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'], { windowsHide: true, timeout: 10_000, signal })
    if (/No activities found|monkey aborted|Error:/i.test(result.stdout + result.stderr)) throw new Error('应用未安装或没有可启动的界面')
  }
  async listApps(serial: string, signal: AbortSignal): Promise<AndroidApp[]> {
    const file = new URL('../vendor/scrcpy-server-v5.0.1', import.meta.url)
    const server = await readFile(file)
    if (createHash('sha256').update(server).digest('hex') !== SERVER_SHA256) throw new Error('scrcpy server 校验失败')
    const target = `/data/local/tmp/dsh-android-apps-${randomBytes(8).toString('hex')}.jar`
    const args = ['-P', String(this.config.adbPort), '-s', serial]
    const adb = await this.adbPath()
    try {
      await run(adb, [...args, 'push', fileURLToPath(file), target], { windowsHide: true, timeout: 8000, signal })
      const result = await run(adb, [...args, 'shell', `CLASSPATH=${target}`, 'app_process', '/', 'com.genymobile.scrcpy.Server', SERVER_VERSION, 'list_apps=true', 'cleanup=false'], { windowsHide: true, timeout: 15_000, maxBuffer: 2 * 1024 * 1024, signal })
      return parseApps(result.stdout)
    } finally {
      await run(adb, [...args, 'shell', 'rm', '-f', target], { windowsHide: true, timeout: 2000 }).catch(() => {})
    }
  }
  /** Abort covers both startup and an established session, including late startup completion. */
  async open(serial: string, signal: AbortSignal, onInputError?: (message: string) => void): Promise<VideoSession> {
    const devices = await this.list()
    if (!devices.some(d => d.serial === serial && d.state === 'device')) throw new Error('手机未连接或尚未授权 USB 调试')
    signal.throwIfAborted()
    const server = await readFile(new URL('../vendor/scrcpy-server-v5.0.1', import.meta.url))
    if (createHash('sha256').update(server).digest('hex') !== SERVER_SHA256) throw new Error('scrcpy server 校验失败')
    let adb: Adb | undefined
    let scrcpy: Awaited<ReturnType<typeof AdbScrcpyClient.start>> | undefined
    let reader: ReadableStreamDefaultReader<ScrcpyVideoStreamPacket> | undefined
    let audioReader:ReadableStreamDefaultReader<ScrcpyAudioStreamPacket>|undefined
    let input: InputController | undefined
    let closing: Promise<void> | undefined
    const close = () => closing ??= (async () => {
      signal.removeEventListener('abort', abort)
      // Close the transport to interrupt startup and pending reads, even if server creation has not finished.
      await input?.close().catch(() => {}) // Disconnection still proceeds if the device is already gone.
      await Promise.allSettled([reader?.cancel(),audioReader?.cancel(), scrcpy?.close(), adb?.close()])
    })()
    const abort = () => { void close() }
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => { void close() }, this.config.connectTimeoutMs)
    try {
      adb = await this.client.createAdb({ serial })
      if (signal.aborted || closing) { await adb.close(); throw new Error('连接已取消或超时') }
      const remotePath = '/data/local/tmp/dsh-android-scrcpy.jar'
      await AdbScrcpyClient.pushServer(adb, new ReadableStream({ start(c) { c.enqueue(server); c.close() } }), remotePath)
      signal.throwIfAborted()
      const options = new AdbScrcpyOptions5_0_1({
        audio:this.config.audio,audioCodec:'raw',audioSource:this.config.audioSource,audioDup:this.config.audioSource==='playback', control: true, tunnelForward: true,
        videoCodec: 'h264', maxSize: this.config.maxSize, maxFps: this.config.maxFps,
        videoBitRate: this.config.videoBitRate, scid: (randomBytes(4).readUInt32BE() & 0x7fffffff).toString(16).padStart(8, '0'),
        clipboardAutosync: true, powerOn: false, cleanup: true,
      })
      // Install the SDK's reply parser, then disable autosync on the server: scrcpy
      // ignores explicit GET_CLIPBOARD when autosync is enabled. No PC clipboard sync.
      ;(options.value as {clipboardAutosync:boolean}).clipboardAutosync=false
      scrcpy = await AdbScrcpyClient.start(adb, remotePath, options)
      if (signal.aborted || closing) { await scrcpy.close(); throw new Error('连接已取消或超时') }
      if (!scrcpy.controller) throw new Error('手机控制通道建立失败')
      input = new InputController(scrcpy.controller)
      // Drain clipboard messages even without a viewer; only explicit reads expose the latest text.
      const clipboardReader=scrcpy.clipboard!.getReader(),waiters=new Set<(text:string)=>void>()
      void(async()=>{for(;;){const item=await clipboardReader.read();if(item.done)break;for(const waiter of [...waiters])waiter(item.value)}})().catch(()=>{})
      // Drain diagnostics: an unread output stream can block the Android process.
      void (async () => { for await (const line of scrcpy.output) {
        console.error('[dsh-android]', line)
        if (/INJECT_EVENTS|Injecting input events requires|Could not inject/i.test(line)) {
          const message = '手机拒绝输入注入，请检查开发者选项中的 USB 调试（安全设置）并重新连接'
          input?.block(message); onInputError?.(message)
        }
      } })().catch(error => {
        if (!closing) console.warn('[dsh-android] server output:', String(error))
      })
      const video = await scrcpy.videoStream
      reader = video.stream.getReader()
      let audio:VideoSession['audio']={status:'disabled'}
      const audioStream=(scrcpy as {readonly audioStream?:Promise<AdbScrcpyAudioStreamMetadata>}).audioStream
      if(audioStream){try{const info=await audioStream;if(info.type==='success'){audioReader=info.stream.getReader();audio={status:'success',read:()=>audioReader!.read()}}else audio={status:info.type,...(info.type==='errored'?{error:'手机音频采集失败；视频仍可使用，请解锁手机并检查音频来源'}:{})}}catch(error){audio={status:'errored',error:String(error)}}}
      clearTimeout(timer)
      const controller = input
      return {
        codec: video.metadata.codec, deviceName: video.metadata.deviceName ?? serial, input: controller,audio,
        resetVideo: () => scrcpy!.controller!.resetVideo(),
        async getClipboard(){
          let timeout:ReturnType<typeof setTimeout>|undefined,receive!:(text:string)=>void
          const result=new Promise<string>((resolve,reject)=>{receive=text=>{if(text.length>65536)reject(new Error('手机剪贴板超过 65536 字'));else resolve(text)};waiters.add(receive);timeout=setTimeout(()=>reject(new Error('读取手机剪贴板超时，请在手机复制文字后重试')),3000)})
          try{await scrcpy!.controller!.write(new Uint8Array([options.controlMessageTypes[ScrcpyControlMessageType.GetClipboard]!,0]));return await result}finally{clearTimeout(timeout);waiters.delete(receive)}
        },
        async read() {
          const result = await reader!.read()
          if (!result.done && result.value.type === 'session') await controller.setGeometry(result.value.width, result.value.height)
          return result
        }, close,
      }
    } catch (error) {
      await close()
      throw error
    } finally { clearTimeout(timer) }
  }
}
