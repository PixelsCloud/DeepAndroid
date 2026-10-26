import type { ScrcpyControlMessageWriter, AndroidKeyCode } from '@yume-chan/scrcpy'

export interface Geometry { width: number; height: number; epoch: number }
export interface Point extends Geometry { x: number; y: number }
export const KEYS = { back: 4, home: 3, recent: 187, enter: 66, backspace: 67, delete: 112, up: 19, down: 20, left: 21, right: 22, tab: 61, wake: 224, selectAll: 29,volumeUp:24,volumeDown:25,mute:164,power:26,sleep:223,copy:278,cut:277,paste:279 } as const
export type DeviceAction='screen_on'|'screen_off'|'rotate'|'notifications'|'quick_settings'|'collapse_panels'
export type PhoneKey = keyof typeof KEYS
export type InputCommand =
  | ({ kind: 'pointer'; phase: 'down' | 'move' | 'up' | 'cancel' } & Point)
  | ({ kind: 'scroll'; scrollX: number; scrollY: number } & Point)
  | { kind: 'key'; key: PhoneKey }
  | { kind: 'text'; text: string; method: 'paste' | 'type' }
  | { kind: 'release' }
export interface InputRequest { type: 'input'; id: number; command: InputCommand }

/** Validate the browser-to-device protocol before queueing any input. */
export function parseInput(value: unknown): InputRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid input request')
  const request = value as Record<string, unknown>
  if (request.type !== 'input' || !Number.isSafeInteger(request.id) || Number(request.id) < 1) throw new Error('Invalid input id')
  if (!request.command || typeof request.command !== 'object') throw new Error('Invalid input command')
  const command = request.command as Record<string, unknown>
  switch (command.kind) {
    case 'pointer': case 'scroll': {
      for (const key of ['x', 'y', 'width', 'height', 'epoch']) if (!Number.isSafeInteger(command[key])) throw new Error(`Invalid ${key}`)
      if (Number(command.width) <= 0 || Number(command.height) <= 0 || Number(command.width) > 65535 || Number(command.height) > 65535 || Number(command.epoch) < 1) throw new Error('Invalid screen geometry')
      if (Number(command.x) < 0 || Number(command.x) >= Number(command.width) || Number(command.y) < 0 || Number(command.y) >= Number(command.height)) throw new Error('Coordinates outside video')
      if (command.kind === 'pointer' && !['down', 'move', 'up', 'cancel'].includes(String(command.phase))) throw new Error('Invalid pointer phase')
      if (command.kind === 'scroll' && (!Number.isFinite(command.scrollX) || !Number.isFinite(command.scrollY) || Math.abs(Number(command.scrollX)) > 1 || Math.abs(Number(command.scrollY)) > 1)) throw new Error('Invalid scroll amount')
      break
    }
    case 'key': if (typeof command.key !== 'string' || !Object.hasOwn(KEYS, command.key)) throw new Error('Unsupported key'); break
    case 'text':
      if (typeof command.text !== 'string' || command.text.length === 0 || command.text.length > 4096 || !['paste', 'type'].includes(String(command.method))) throw new Error('Invalid input text')
      if (command.method === 'type' && !/^[\x20-\x7e]+$/.test(command.text)) throw new Error('Use paste for Unicode text')
      break
    case 'release': break
    default: throw new Error('Unsupported input operation')
  }
  return value as InputRequest
}

/** Map a contain-fitted canvas to video pixels; black bars never start a gesture. */
export function mapPoint(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, geometry: Geometry, clamp = false): Point | undefined {
  if (rect.width <= 0 || rect.height <= 0 || geometry.width <= 0 || geometry.height <= 0) return
  const scale = Math.min(rect.width / geometry.width, rect.height / geometry.height)
  const x = (clientX - rect.left - (rect.width - geometry.width * scale) / 2) / scale
  const y = (clientY - rect.top - (rect.height - geometry.height * scale) / 2) / scale
  if (!clamp && (x < 0 || y < 0 || x >= geometry.width || y >= geometry.height)) return
  return { ...geometry, x: Math.max(0, Math.min(geometry.width - 1, Math.floor(x))), y: Math.max(0, Math.min(geometry.height - 1, Math.floor(y))) }
}

type Writer = Pick<ScrcpyControlMessageWriter, 'injectTouch' | 'injectScroll' | 'injectKeyCode' | 'setClipboard' | 'injectText'> & Partial<Pick<ScrcpyControlMessageWriter,'setDisplayPower'|'rotateDevice'|'expandNotificationPanel'|'expandSettingPanel'|'collapseNotificationPanel'>>
/** One ordered input stream per device. Transport acknowledgement does not imply application success. */
export class InputController {
  geometry: Geometry = { width: 0, height: 0, epoch: 0 }
  private tail = Promise.resolve()
  private queued = 0
  private active?: Point
  private gestureTouches=new Map<number,Point>()
  private closed = false
  private blocked?: string
  private watchdog?: ReturnType<typeof setTimeout>
  constructor(private readonly writer: Writer) {}
  block(reason: string) { this.blocked = reason }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.queued++
    const result = this.tail.then(operation).finally(() => { this.queued-- })
    this.tail = result.then(()=>{},()=>{}) // A rejected command must not strand a later release.
    return result
  }
  async setGeometry(width: number, height: number) {
    if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>65535||height>65535)throw new Error('手机画面尺寸无效')
    return this.enqueue(async () => {
      const geometry={width,height,epoch:this.geometry.epoch+1}
      const remap=(point:Point):Point=>({...geometry,x:Math.min(width-1,Math.floor(point.x/point.width*width)),y:Math.min(height-1,Math.floor(point.y/point.height*height))})
      // The server already uses the new video size. An UP with the old dimensions
      // would be dropped before scrcpy clears its pointer state.
      if(this.active)this.active=remap(this.active)
      for(const[index,point]of this.gestureTouches)this.gestureTouches.set(index,remap(point))
      this.geometry=geometry
      await this.release()
    })
  }
  send(command: InputCommand): Promise<void> {
    if (this.closed) return Promise.reject(new Error('手机控制连接已关闭'))
    if (this.queued >= 128 && command.kind !== 'release' && !(command.kind === 'pointer' && ['up', 'cancel'].includes(command.phase))) return Promise.reject(new Error('控制队列繁忙，请重试'))
    return this.enqueue(async () => {
      if (this.closed) throw new Error('手机控制连接已关闭')
      if (this.blocked && command.kind !== 'release') throw new Error(this.blocked)
      if (command.kind === 'release') { await this.release(); return }
      if (command.kind === 'pointer' || command.kind === 'scroll') {
        if (command.epoch !== this.geometry.epoch || command.width !== this.geometry.width || command.height !== this.geometry.height) {
          await this.release(); throw new Error('画面已旋转或重新连接，请基于新画面重试')
        }
      }
      switch (command.kind) {
        case 'pointer': {
          if (command.phase === 'down') {
            await this.release(); this.active = command
          } else if (!this.active) { throw new Error('触点已释放，请重新按下') }
          this.active = command
          try {
            await this.touch(command, ({ down: 0, move: 2, up: 1, cancel: 3 } as const)[command.phase])
          } catch (error) { await this.release().catch(() => {}); throw error }
          if (command.phase === 'up' || command.phase === 'cancel') { this.active = undefined; clearTimeout(this.watchdog) }
          else {
            clearTimeout(this.watchdog)
            this.watchdog = setTimeout(() => { void this.send({ kind: 'release' }).catch(() => {}) }, 10_000)
          }
          return
        }
        case 'scroll':
          await this.writer.injectScroll({ pointerX: command.x, pointerY: command.y, videoWidth: command.width, videoHeight: command.height, scrollX: command.scrollX, scrollY: command.scrollY, buttons: 0 }); return
        case 'key':
          await this.release()
          try { await this.writer.injectKeyCode({ action: 0, keyCode: KEYS[command.key] as AndroidKeyCode, repeat: 0, metaState: command.key === 'selectAll' ? 4096 : 0 }) }
          finally { await this.writer.injectKeyCode({ action: 1, keyCode: KEYS[command.key] as AndroidKeyCode, repeat: 0, metaState: command.key === 'selectAll' ? 4096 : 0 }) }
          return
        case 'text':
          await this.release()
          if (command.method === 'paste') await this.writer.setClipboard({ sequence: 0n, paste: true, content: command.text })
          else await this.writer.injectText(command.text)
          return
      }
    })
  }
  control(action:DeviceAction){return this.enqueue(async()=>{
    if(this.closed)throw new Error('手机控制连接已关闭');if(this.blocked)throw new Error(this.blocked);await this.release()
    switch(action){
      case 'screen_on':case 'screen_off':if(!this.writer.setDisplayPower)throw new Error('当前后端不支持屏幕电源');await this.writer.setDisplayPower(action==='screen_on');return
      case 'rotate':if(!this.writer.rotateDevice)throw new Error('当前后端不支持旋转');await this.writer.rotateDevice();return
      case 'notifications':if(!this.writer.expandNotificationPanel)throw new Error('当前后端不支持通知面板');await this.writer.expandNotificationPanel();return
      case 'quick_settings':if(!this.writer.expandSettingPanel)throw new Error('当前后端不支持快捷设置');await this.writer.expandSettingPanel();return
      case 'collapse_panels':if(!this.writer.collapseNotificationPanel)throw new Error('当前后端不支持收起面板');await this.writer.collapseNotificationPanel();return
      default:throw new Error('设备操作无效')
    }
  })}
  /** One frame of a bounded native gesture. Geometry and manual input may run between frames. */
  gestureFrame(points:Point[]){return this.enqueue(async()=>{
    if(this.closed)throw new Error('手机控制连接已关闭')
    if(!points.length){await this.release();return}
    if(this.blocked)throw new Error(this.blocked)
    if(points.length>2||points.some(point=>!Number.isInteger(point.x)||!Number.isInteger(point.y)||point.x<0||point.y<0||point.x>=point.width||point.y>=point.height||point.width!==this.geometry.width||point.height!==this.geometry.height||point.epoch!==this.geometry.epoch)){
      await this.release();throw new Error('手势画面已旋转、观察已失效或坐标无效，请重新观察')
    }
    if(this.active){await this.release()}
    try{
      for(const [index,point]of [...this.gestureTouches].reverse())if(index>=points.length){await this.gestureTouch(index,point,1);this.gestureTouches.delete(index)}
      for(const [index,point]of points.entries()){const down=!this.gestureTouches.has(index);this.gestureTouches.set(index,point);await this.gestureTouch(index,point,down?0:2)}
      clearTimeout(this.watchdog);this.watchdog=setTimeout(()=>{void this.send({kind:'release'}).catch(()=>{})},10_000)
    }catch(error){await this.release().catch(()=>{});throw error}
  })}
  setClipboard(text:string){if(typeof text!=='string'||text.length>65536||text.includes('\0'))return Promise.reject(new Error('剪贴板最多 65536 字'));return this.enqueue(async()=>{if(this.closed)throw new Error('手机控制连接已关闭');if(this.blocked)throw new Error(this.blocked);await this.release();await this.writer.setClipboard({sequence:0n,paste:false,content:text})})}
  private touch(point: Point, action: 0 | 1 | 2 | 3) {
    return this.writer.injectTouch({ action, pointerId: -2n, pointerX: point.x, pointerY: point.y, videoWidth: point.width, videoHeight: point.height, pressure: action === 1 || action === 3 ? 0 : 1, actionButton: 0, buttons: 0 })
  }
  private gestureTouch(index:number,point:Point,action:0|1|2){return this.writer.injectTouch({action,pointerId:BigInt(index+1),pointerX:point.x,pointerY:point.y,videoWidth:point.width,videoHeight:point.height,pressure:action===1?0:1,actionButton:0,buttons:0})}
  private async release() {
    clearTimeout(this.watchdog)
    const point = this.active; this.active = undefined
    const contacts=[...this.gestureTouches].reverse();this.gestureTouches.clear();let error:unknown
    for(const[index,contact]of contacts)try{await this.gestureTouch(index,contact,1)}catch(reason){error??=reason}
    if(point)try{await this.touch(point,1)}catch(reason){error??=reason}
    if(error)throw error
  }
  async close() {
    if (this.closed) return
    this.closed = true; clearTimeout(this.watchdog)
    await this.enqueue(() => this.release())
  }
}
