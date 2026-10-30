import { AutoCanvasRenderer, WebCodecsVideoDecoder } from '@yume-chan/scrcpy-decoder-webcodecs'
import type { ScrcpyVideoCodecId } from '@yume-chan/scrcpy'
import { decodePacket } from './wire.js'
import { mountControls } from './browser-input.js'
import { mountManagement } from './browser-management.js'
import { mountResults } from './browser-results.js'
import { mountTasks } from './browser-tasks.js'
import { mountFiles } from './browser-files.js'
import { mountExtra } from './browser-extra.js'
import { PhoneAudio } from './browser-audio.js'
import { mountToasts, notify, resetNotice } from './browser-toast.js'
import { mountDesign } from './browser-design.js'
import { DEFAULT_PANEL_STATE, type PanelState } from './panel-state-format.js'

interface DeviceInfo { serial: string; state: string; model: string }
const headers = { 'content-type': 'application/json', 'x-android-client': '1' }
async function api<T>(path: string, body?: object): Promise<T> {
  const response = await fetch('/x-android' + path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal:AbortSignal.timeout(30_000) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? `请求失败 (${response.status})`)
  return result as T
}

/** Same view is used by the Harness slot and the browser smoke harness. */
export function mountPanel(root: HTMLElement): () => void {
  root.innerHTML = `<style>
    .android-panel{height:100%;min-height:360px;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;padding:16px;color:inherit;font:13px/1.5 system-ui,sans-serif;overflow:auto}
    .android-panel *{box-sizing:border-box}.android-panel [hidden]{display:none!important}
    .android-panel button,.android-panel select{font:inherit;border:1px solid #8885;border-radius:8px;padding:7px 10px;background:transparent;color:inherit}.android-panel button{cursor:pointer}.android-panel button:disabled{opacity:.45;cursor:default}.android-panel button.primary{background:#168468;color:white;border-color:#168468}
    .android-panel-tabs{display:flex;gap:16px;border-bottom:1px solid #8883;flex:none}.android-panel-tabs button{border:0;border-bottom:2px solid transparent;border-radius:0;padding:2px 0 9px;color:#929b9a}.android-panel-tabs button[aria-selected=true]{color:inherit;border-bottom-color:#168468}
    .android-phone-view{display:flex;flex-direction:column;gap:12px;flex:1;min-height:0}.android-controls{display:flex;gap:8px;flex-wrap:wrap}.android-controls select{flex:1;min-width:0}
    .android-status{display:flex;gap:8px;align-items:center;font-size:12px;color:#929b9a}.android-dot{width:7px;height:7px;border-radius:50%;background:#8b9294}
    .android-workspace{display:grid;grid-template-columns:minmax(0,1fr) 78px;grid-template-rows:minmax(0,1fr);gap:12px;flex:1;min-height:240px;min-width:0}
    .android-video{position:relative;min-width:0;min-height:0;display:flex;align-items:flex-start;justify-content:center;border-radius:12px;overflow:hidden;background:#090d11;border:1px solid #8883;touch-action:none;user-select:none;outline-offset:2px}.android-video:focus-visible{outline:2px solid #168468}.android-video canvas{display:block;max-width:100%;max-height:100%;object-fit:contain}
    .android-placeholder{position:absolute;color:#8b949d;text-align:center;padding:16px;pointer-events:none}.android-placeholder span{display:block;font-size:34px;margin-bottom:10px}
    .android-phone-keys{display:flex;flex-direction:column;align-self:start;gap:8px}.android-phone-keys button{width:100%;padding:8px 5px;white-space:nowrap}.android-key-divider{height:1px;background:#8883;margin:2px 0}
    .android-meta{font:11px/1.5 ui-monospace,monospace;color:#929b9a;overflow-wrap:anywhere;margin-bottom:14px}.android-hint{font-size:11px;color:#929b9a;margin:0}
    .android-text-row{display:flex;gap:8px;flex:none}.android-phone-text{flex:1;min-width:0;resize:vertical;max-height:120px;font:inherit;border:1px solid #8885;border-radius:8px;background:transparent;color:inherit;padding:8px}.android-debug-view{min-height:0;overflow:auto}
  </style><section class="android-panel" aria-label="手机面板">
    <nav class="android-panel-tabs" role="tablist" aria-label="面板视图"><button role="tab" data-panel-tab="phone" aria-selected="true">手机</button><button role="tab" data-panel-tab="files" aria-selected="false" tabindex="-1">文件</button><button role="tab" data-panel-tab="tasks" aria-selected="false" tabindex="-1">任务</button><button role="tab" data-panel-tab="results" aria-selected="false" tabindex="-1">结果</button><button role="tab" data-panel-tab="debug" aria-selected="false" tabindex="-1">调试</button></nav>
    <div class="android-phone-view" data-panel="phone" role="tabpanel" aria-label="手机">
      <div class="android-controls"><select aria-label="USB 手机"></select><button data-action="refresh" title="刷新设备">刷新</button></div>
      <div class="android-status"><i class="android-dot"></i><span role="status">正在查找 USB 手机…</span></div>
      <div class="android-workspace">
        <div class="android-video"><div class="android-placeholder"><span>▯</span>选择手机，连接后显示实时画面</div></div>
        <div class="android-phone-keys" aria-label="手机操作">
          <button class="primary" data-action="connect">连接手机</button><button data-action="disconnect" disabled>断开</button><div class="android-key-divider" role="separator"></div>
          <button data-key="back" disabled>返回</button><button data-key="home" disabled>主页</button><button data-key="recent" disabled>最近任务</button><button data-key="wake" disabled>唤醒</button>
          <button data-action="more">更多</button>
        </div>
      </div>
      <div class="android-text-row"><textarea class="android-phone-text" aria-label="输入到手机的文字" placeholder="先点手机输入框，再输入中英文文字" rows="2" maxlength="4096"></textarea><button data-action="send-text" disabled>输入文字</button></div>
      <p class="android-hint android-input-status" role="note">点击画面可控制，按住拖动可滑动；右键返回</p>
    </div>
    <div class="android-debug-view android-task-root" data-panel="tasks" role="tabpanel" aria-label="任务" hidden></div>
    <div class="android-debug-view android-files-root" data-panel="files" role="tabpanel" aria-label="文件" hidden></div>
    <div class="android-debug-view android-results-root" data-panel="results" role="tabpanel" aria-label="结果" hidden></div>
    <div class="android-debug-view" data-panel="debug" role="tabpanel" aria-label="调试" hidden>
      <div class="android-meta">H.264 · scrcpy 5.0.1 · WebCodecs</div>
      <div class="android-management-root"></div>
    </div>
  </section>`
  function get<T extends Element>(selector: string): T { const el = root.querySelector<T>(selector); if (!el) throw new Error(selector); return el }
  const select = get<HTMLSelectElement>('select[aria-label="USB 手机"]')
  const connect = get<HTMLButtonElement>('[data-action=connect]')
  const disconnect = get<HTMLButtonElement>('[data-action=disconnect]')
  const refreshButton = get<HTMLButtonElement>('[data-action=refresh]')
  const status = get<HTMLElement>('[data-panel=phone] [role=status]')
  const dot = get<HTMLElement>('.android-dot')
  const toasts = mountToasts(root)
  const video = get<HTMLElement>('.android-video')
  const placeholder = get<HTMLElement>('.android-placeholder')
  const meta = get<HTMLElement>('.android-meta')
  let socket: WebSocket | undefined
  let decoder: WebCodecsVideoDecoder | undefined
  let writer: ReturnType<WebCodecsVideoDecoder['writable']['getWriter']> | undefined
  let generation = 0
  let disposed = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  let frames = 0
  let received = 0
  let queued = 0
  let serial = ''
  let connectingAt = 0
  let firstRefresh = true, desiredConnection = false, retryCount = 0, interacted = false
  let uiState:PanelState={...DEFAULT_PANEL_STATE},pendingState:Partial<PanelState>={}
  let stateReady:Promise<void>,stateWrites=Promise.resolve()
  let retryTimer:ReturnType<typeof setTimeout>|undefined,stableTimer:ReturnType<typeof setTimeout>|undefined
  let authorized=new Set<string>()
  connect.disabled=true
  function persist(patch:Partial<PanelState>){pendingState={...pendingState,...patch};uiState={...uiState,...patch};stateWrites=stateWrites.then(()=>stateReady).then(async()=>{await api('/panel-state',patch);resetNotice(root,'panel-state')}).catch(error=>{if(!disposed)notify(root,'面板状态保存失败，当前操作仍可继续：'+String(error.message??error),'error','panel-state')});return stateWrites}
  function scheduleRetry(message:string){
    if(disposed||!desiredConnection)return
    if(retryCount>=3){setStatus('重连已停止，请连接或刷新设备','#dc7777');return}
    const delay=[1000,2000,4000][retryCount]!
    retryCount++;root.dataset.reconnectAttempts=String(retryCount)
    setStatus(`${message} · ${delay/1000} 秒后重试（${retryCount}/3）`,'#d5af60')
    clearTimeout(retryTimer);retryTimer=setTimeout(()=>{if(!disposed&&desiredConnection)void refresh(true)},delay)
  }
  const controls = mountControls(root, { socket: () => socket, dimensions: () => decoder })
  const audio=new PhoneAudio()
  const fileView=mountFiles(get<HTMLElement>('.android-files-root'),()=>select.value)
  const extra=mountExtra(get<HTMLElement>('.android-panel'),()=>select.value,audio)
  get<HTMLButtonElement>('[data-action=more]').onclick=()=>{controls.release()}
  const disposeManagement = mountManagement(get<HTMLElement>('.android-management-root'))
  const resultView = mountResults(get<HTMLElement>('.android-results-root'))
  const disposeTasks=mountTasks(get<HTMLElement>('.android-task-root'),async id=>{if(!disposed){showPanel('results');await resultView.open(id)}})
  let debugOpened = false
  const panelTabs = [...root.querySelectorAll<HTMLButtonElement>('[data-panel-tab]')]
  function showPanel(name: string,save=true) {
    extra.close()
    if(save){interacted=true;void persist({panel:name as PanelState['panel']})}
    controls.release(); resultView.show(name==='results');fileView.show(name==='files')
    for (const panel of root.querySelectorAll<HTMLElement>('[data-panel]')) panel.hidden = panel.dataset.panel !== name
    for (const tab of panelTabs) { const selected = tab.dataset.panelTab === name; tab.setAttribute('aria-selected',String(selected)); tab.tabIndex = selected ? 0 : -1 }
    if (name === 'debug' && !debugOpened) { debugOpened = true; get<HTMLButtonElement>('[data-tab=doctor]').click() }
  }
  for (const [index,tab] of panelTabs.entries()) {
    tab.onclick = () => showPanel(tab.dataset.panelTab!)
    tab.onkeydown = event => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return
      event.preventDefault()
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? panelTabs.length-1 : (index+(event.key === 'ArrowRight' ? 1 : -1)+panelTabs.length)%panelTabs.length
      showPanel(panelTabs[target]!.dataset.panelTab!); panelTabs[target]!.focus()
    }
  }
  const setStatus = (text: string, color = '#8b9294') => { status.textContent = text; dot.style.background = color }
  function clearVideo() {
    clearTimeout(timeout);clearTimeout(stableTimer)
    root.dataset.framesRendered='0'
    controls.reset()
    audio.reset()
    socket?.close(); socket = undefined
    void writer?.abort().catch(() => {}) // The decoder is disposed immediately below.
    writer = undefined; decoder?.dispose(); decoder = undefined
    video.querySelectorAll('canvas').forEach(el => el.remove())
    placeholder.hidden = false
  }
  function fail(error: unknown) {
    if (disposed) return
    generation++; clearVideo()
    notify(root, error, 'error', 'connection')
    setStatus('连接异常，可重新连接', '#dc7777'); connect.disabled = !authorized.has(select.value); disconnect.disabled = false; select.disabled = false
    scheduleRetry('连接中断')
  }
  async function refresh(reconnect=false) {
    refreshButton.disabled = true
    try {
      const { devices } = await api<{ devices: DeviceInfo[] }>('/devices')
      if (disposed) return
      authorized=new Set(devices.filter(device=>device.state==='device').map(device=>device.serial))
      const old = select.value || uiState.serial || ''
      select.replaceChildren(...devices.map(device => {
        const option = document.createElement('option'); option.value = device.serial
        option.textContent = `${device.model} · ${device.serial}${device.state === 'device' ? '' : ' · ' + device.state}`
        option.disabled = device.state !== 'device'; return option
      }))
      if(old&&!devices.some(device=>device.serial===old)){const missing=document.createElement('option');missing.value=old;missing.textContent=old+' · 未连接';missing.disabled=true;select.prepend(missing)}
      if(old)select.value=old
      else select.selectedIndex=devices.findIndex(device=>device.state==='device')
      connect.disabled=!authorized.has(select.value)||Boolean(socket)
      if (!socket) setStatus(devices.length ? '手机已识别，等待连接' : '未发现手机，请检查 USB 连接')
      if (firstRefresh) {
        firstRefresh = false
        desiredConnection=uiState.connection!=='disconnected'&&(uiState.serial!==null||authorized.size===1)
        if(desiredConnection&&authorized.has(select.value))void start(true)
        else if(desiredConnection&&uiState.connection==='connected')scheduleRetry('原设备未连接或尚未授权')
        else if(uiState.connection==='disconnected')setStatus('已断开，可随时连接')
      }else if(reconnect&&desiredConnection){if(authorized.has(select.value))void start(true);else scheduleRetry('原设备未连接或尚未授权')}
    } catch (error) { fail(error) } finally { refreshButton.disabled = false }
  }
  async function start(automatic=false) {
    if(!authorized.has(select.value)){setStatus('请选择已授权手机');return}
    desiredConnection=true;clearTimeout(retryTimer)
    if(!automatic){retryCount=0;root.dataset.reconnectAttempts='0';resetNotice(root,'connection')}
    void persist({serial:select.value,connection:'connected'})
    if (!WebCodecsVideoDecoder.isSupported) { fail(new Error('当前环境无法使用 WebCodecs，请使用受支持的 Harness 桌面版或 Chromium 浏览器')); return }
    const own = ++generation
    clearVideo()
    root.dataset.framesRendered = '0'; delete root.dataset.firstFrameMs
    connect.disabled = true; disconnect.disabled = false; select.disabled = true
    frames = 0; received = 0; queued = 0; serial = select.value; connectingAt = performance.now()
    setStatus('正在连接手机…', '#d5af60')
    try {
      const ticket = await api<{ url: string }>('/ticket', { serial })
      if (disposed || own !== generation) return
      const ws = new WebSocket(ticket.url); socket = ws; ws.binaryType = 'arraybuffer'
      let queue = Promise.resolve()
      timeout = setTimeout(() => { if (own === generation) fail(new Error('等待手机首帧超时，请断开后重试')) }, 20_000)
      ws.onmessage = event => {
        if (own !== generation) return
        if (typeof event.data === 'string') {
          try {
            const message = JSON.parse(event.data)
            if (message.type === 'automation-state') {
              if (message.state === 'error') throw new Error(message.error ?? '手机连接异常')
              return
            }
            if (message.type === 'error') throw new Error(message.error)
            if (message.type === 'input-result' || message.type === 'input-error') { controls.receive(message); return }
            if(message.type==='audio-state'){root.dataset.audioStatus=message.status;return}
            if (message.type === 'session') { controls.geometry({ width: message.width, height: message.height, epoch: message.epoch }); return }
            if (message.type === 'hello') {
              decoder = new WebCodecsVideoDecoder({
                codec: message.codec as ScrcpyVideoCodecId,
                renderer: new AutoCanvasRenderer({ createCanvas() {
                  const canvas = document.createElement('canvas'); canvas.setAttribute('aria-label', 'Android 实时画面')
                  video.querySelectorAll('canvas').forEach(el => el.remove()); video.appendChild(canvas); return canvas
                } }),
                optimizeForLatency: true,
              })
              writer = decoder.writable.getWriter()
              void writer.closed.catch(error => { if (own === generation) fail(error) })
            }
          } catch (error) { fail(error) }
          return
        }
        const data = event.data as ArrayBuffer
        if(new Uint8Array(data)[0]===2){try{audio.push(data);root.dataset.audioPackets=String(audio.packets)}catch(error){console.warn('[dsh-android] audio:',String(error))}return}
        received += data.byteLength; queued += data.byteLength
        if (queued > 4 * 1024 * 1024) { fail(new Error('视频解码积压，请重新连接')); return }
        queue = queue.then(async () => {
          if (own !== generation) return
          if (!writer) throw new Error('Video arrived before decoder setup')
          await writer.write(decodePacket(data)); queued -= data.byteLength
        }).catch(error => { if (own === generation) fail(error) })
      }
      ws.onerror = () => { if (own === generation) fail(new Error('视频通道连接失败，请断开后重试')) }
      ws.onclose = () => {
        if(own===generation&&!disposed){if(desiredConnection)fail(new Error('视频连接已结束'));else{clearVideo();setStatus('连接已结束');connect.disabled=!authorized.has(select.value);disconnect.disabled=true;select.disabled=false}}
      }
    } catch (error) { if (own === generation) fail(error) }
  }
  async function stop() {
    desiredConnection=false;retryCount=0;clearTimeout(retryTimer);void persist({serial:select.value||uiState.serial,connection:'disconnected'})
    generation++; clearVideo(); connect.disabled = true; disconnect.disabled = true; setStatus('正在断开…')
    try {
      await api('/disconnect', {})
      if (disposed) return
      resetNotice(root,'connection'); setStatus('已断开'); select.disabled = false; connect.disabled = !authorized.has(select.value)
      meta.textContent = 'H.264 · scrcpy 5.0.1 · WebCodecs'
    } catch (error) { fail(error) }
  }
  connect.onclick = () => { void start() }
  disconnect.onclick = () => { void stop() }
  refreshButton.onclick=()=>{retryCount=0;clearTimeout(retryTimer);resetNotice(root,'connection');void refresh(desiredConnection)}
  select.onchange=()=>{desiredConnection=false;clearTimeout(retryTimer);void persist({serial:select.value||null,connection:'disconnected'});connect.disabled=!authorized.has(select.value)||Boolean(socket)}
  const interval = setInterval(() => {
    if (!decoder) return
    if (decoder.framesRendered > 0) {
      clearTimeout(timeout); placeholder.hidden = true
      setStatus('实时画面已连接', '#51b88f')
      if(frames===0){resetNotice(root,'connection');root.dataset.firstFrameMs=String(Math.round(performance.now()-connectingAt));stableTimer=setTimeout(()=>{retryCount=0;root.dataset.reconnectAttempts='0'},10000)}
    }
    frames = decoder.framesRendered
    root.dataset.framesRendered = String(frames)
    meta.textContent = `${decoder.width} × ${decoder.height} · 已显示 ${frames} 帧 · ${(received / 1024).toFixed(0)} KB · ${decoder.type === 'hardware' ? '硬件解码' : '软件解码'}`
  }, 500)
  stateReady=api<{state:PanelState}>('/panel-state').then(value=>{if(disposed)return;uiState={...DEFAULT_PANEL_STATE,...value.state,...pendingState};if(!interacted)showPanel(uiState.panel,false)}).catch(error=>console.warn('[dsh-android] panel restoration:',String(error)))
  const disposeDesign=mountDesign(root)
  void stateReady.then(()=>{if(!disposed)void refresh()})
  return () => { disposed = true;disposeDesign();toasts.dispose();desiredConnection=false;clearTimeout(retryTimer);clearTimeout(stableTimer); generation++; clearInterval(interval); clearVideo(); controls.dispose(); disposeManagement(); resultView.dispose();disposeTasks();fileView.dispose();extra.dispose();audio.dispose(); root.replaceChildren() }
}

interface ReactLike {
  createElement(type: string, props: object): unknown
  useRef<T>(initial: T): { current: T }
  useEffect(effect: () => void | (() => void), deps: unknown[]): void
  useSyncExternalStore<T>(subscribe:(listener:()=>void)=>()=>void,getSnapshot:()=>T,getServerSnapshot?:()=>T):T
}
interface ClientContext {
  slots: { inject(name: string, callback: () => () => void): () => void; register(spec: object, component: () => unknown): () => void }
  sidebarRightTabs: { register(spec: object): () => void }
  sidebarRight: { openTab(kind: string): void; mounted:{subscribe(listener:()=>void):()=>void;getSnapshot():string|undefined};isExpanded():boolean;active():{kind:string}|undefined }
}
export function mount(ctx: ClientContext, React: ReactLike): () => void {
  const tab = 'android-usb'
  let restoreDone=false,unloaded=false
  function OpenPhoneAction(){
    const session=React.useSyncExternalStore(listener=>ctx.sidebarRight.mounted.subscribe(listener),()=>ctx.sidebarRight.mounted.getSnapshot(),()=>undefined)
    React.useEffect(()=>{
      let cancelled=false
      if(!session||restoreDone)return
      void api<{state:PanelState}>('/panel-state').then(({state})=>{
        if(cancelled||unloaded||restoreDone||ctx.sidebarRight.mounted.getSnapshot()!==session)return
        if(!state.autoOpen||(ctx.sidebarRight.isExpanded()&&ctx.sidebarRight.active()?.kind!==tab)){restoreDone=true;return}
        ctx.sidebarRight.openTab(tab);restoreDone=true
      }).catch(error=>console.warn('[dsh-android] sidebar restoration:',String(error)))
      return()=>{cancelled=true}
    },[session])
    return React.createElement('button',{onClick:()=>ctx.sidebarRight.openTab(tab),title:'连接 USB Android 手机',style:{cursor:'pointer',padding:'4px 10px',border:'1px solid #8885',borderRadius:7,color:'inherit',background:'transparent'},children:'Android'})
  }
  function PhonePanel() {
    const ref = React.useRef<HTMLElement | null>(null)
    React.useEffect(() => ref.current ? mountPanel(ref.current) : undefined, [])
    return React.createElement('div', { ref, style: { height: '100%', overflow: 'hidden' } })
  }
  const disposers = [
    ctx.sidebarRightTabs.register({ id: tab, kind: tab, title: () => 'Android' }),
    ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: tab }, PhonePanel)),
    ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register(
      { name: 'conversation.session.header.actions', id: 'android-open', order: 91 },
      OpenPhoneAction,
    )),
  ]
  return () => { unloaded=true;for (const dispose of disposers.reverse()) dispose() }
}
