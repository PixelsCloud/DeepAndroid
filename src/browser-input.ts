import { mapPoint, type Geometry, type InputCommand, type PhoneKey, type Point } from './input.js'

interface Options { socket(): WebSocket | undefined; dimensions(): { width: number; height: number } | undefined }
/** Bind only the video surface and explicit phone controls, leaving Harness shortcuts alone. */
export function mountControls(root: HTMLElement, options: Options) {
  const video = root.querySelector<HTMLElement>('.android-video')!
  const toolbar = root.querySelector<HTMLElement>('.android-phone-keys')!
  const text = root.querySelector<HTMLTextAreaElement>('.android-phone-text')!
  const sendButton = root.querySelector<HTMLButtonElement>('[data-action=send-text]')!
  const hint = root.querySelector<HTMLElement>('.android-input-status')!
  let geometry: Geometry = { width: 0, height: 0, epoch: 0 }
  let active: number | undefined
  let latestMove: Point | undefined
  let animation: number | undefined
  let sequence = 0
  let blocked = false
  let disposed = false
  const pending = new Map<number, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  const ready = () => {
    const size = options.dimensions()
    return !blocked && geometry.epoch > 0 && options.socket()?.readyState === WebSocket.OPEN && size?.width === geometry.width && size?.height === geometry.height
  }
  function report(error: unknown) {
    if (disposed) return
    hint.textContent = error instanceof Error ? error.message : String(error); hint.style.color = '#e68f8f'
  }
  function send(command: InputCommand): Promise<void> {
    const socket = options.socket()
    if (!socket || socket.readyState !== WebSocket.OPEN || (command.kind !== 'release' && !ready())) return Promise.reject(new Error('请等待手机画面连接完成'))
    if (pending.size >= 128 && command.kind !== 'release') return Promise.reject(new Error('控制通道繁忙，请稍后重试'))
    const id = ++sequence
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('操作结果未确认，请查看手机画面后再试')) }, 5000)
      pending.set(id, { resolve, reject, timer })
      try { socket.send(JSON.stringify({ type: 'input', id, command })) }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error) }
    })
  }
  const fire = (command: InputCommand) => { void send(command).catch(report) }
  function point(event: { clientX: number; clientY: number }, clamp = false) {
    const canvas = video.querySelector('canvas')
    return canvas && ready() ? mapPoint(event.clientX, event.clientY, canvas.getBoundingClientRect(), geometry, clamp) : undefined
  }
  function flushMove() {
    if (animation !== undefined) cancelAnimationFrame(animation)
    animation = undefined
    if (latestMove) { fire({ kind: 'pointer', phase: 'move', ...latestMove }); latestMove = undefined }
  }
  function release() {
    latestMove = undefined
    if (animation !== undefined) cancelAnimationFrame(animation)
    animation = undefined
    const pointer = active; active = undefined
    if (pointer !== undefined) {
      if (video.hasPointerCapture(pointer)) video.releasePointerCapture(pointer)
      fire({ kind: 'release' })
    }
  }
  const down = (event: PointerEvent) => {
    if (event.button !== 0 || active !== undefined || !event.isPrimary) return
    const location = point(event)
    if (!location) return
    event.preventDefault(); active = event.pointerId
    video.focus({ preventScroll: true }); video.setPointerCapture(event.pointerId)
    fire({ kind: 'pointer', phase: 'down', ...location })
  }
  const move = (event: PointerEvent) => {
    if (active !== event.pointerId) return
    event.preventDefault()
    latestMove = point(event, true)
    if (animation === undefined) animation = requestAnimationFrame(flushMove)
  }
  const up = (event: PointerEvent) => {
    if (active !== event.pointerId) return
    event.preventDefault(); flushMove()
    const location = point(event, true)
    active = undefined
    if (video.hasPointerCapture(event.pointerId)) video.releasePointerCapture(event.pointerId)
    if (location) fire({ kind: 'pointer', phase: event.type === 'pointercancel' ? 'cancel' : 'up', ...location })
    else fire({ kind: 'release' })
  }
  const wheel = (event: WheelEvent) => {
    const location = point(event)
    if (!location) return
    event.preventDefault()
    fire({ kind: 'scroll', ...location, scrollX: Math.max(-1, Math.min(1, -event.deltaX / 120)), scrollY: Math.max(-1, Math.min(1, -event.deltaY / 120)) })
  }
  const context = (event: MouseEvent) => { if (point(event)) { event.preventDefault(); fire({ kind: 'key', key: 'back' }) } }
  const keyboard = (event: KeyboardEvent) => {
    if (!ready() || event.isComposing) return
    const keys: Record<string, PhoneKey> = { Escape: 'back', Backspace: 'backspace', Delete: 'delete', Enter: 'enter', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Tab: 'tab' }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); fire({ kind: 'key', key: 'selectAll' }); return }
    if (event.ctrlKey || event.metaKey || event.altKey) return
    if (keys[event.key]) { event.preventDefault(); fire({ kind: 'key', key: keys[event.key]! }); return }
    if (event.key.length === 1 && /^[\x20-\x7e]$/.test(event.key)) { event.preventDefault(); fire({ kind: 'text', text: event.key, method: 'type' }) }
  }
  const visibility = () => { if (document.hidden) release() }
  video.tabIndex = 0
  video.setAttribute('aria-label', '手机控制区域')
  video.addEventListener('pointerdown', down); video.addEventListener('pointermove', move)
  video.addEventListener('pointerup', up); video.addEventListener('pointercancel', up)
  video.addEventListener('lostpointercapture', release); video.addEventListener('keydown', keyboard)
  video.addEventListener('wheel', wheel, { passive: false }); video.addEventListener('contextmenu', context)
  window.addEventListener('blur', release); document.addEventListener('visibilitychange', visibility)
  toolbar.querySelectorAll<HTMLButtonElement>('[data-key]').forEach(button => { button.onclick = () => fire({ kind: 'key', key: button.dataset.key as PhoneKey }) })
  sendButton.onclick = async () => {
    if (!text.value) return
    sendButton.disabled = true
    try {
      await send({ kind: 'text', text: text.value, method: 'paste' })
      hint.style.color = '#929b9a'; hint.textContent = '文字已发送，请查看手机输入框'
    } catch (error) { report(error) } finally { sendButton.disabled = !ready() }
  }
  const interval = setInterval(() => {
    const enabled = ready()
    toolbar.querySelectorAll<HTMLButtonElement>('[data-key]').forEach(button => { button.disabled = !enabled })
    sendButton.disabled = !enabled; video.style.cursor = enabled ? 'crosshair' : 'default'
  }, 250)
  return {
    release,
    geometry(value: Geometry) { release(); geometry = value },
    receive(value: Record<string, unknown>) {
      if (value.type === 'input-error') { blocked = true; release(); report(value.error); return }
      if (value.type !== 'input-result' || typeof value.id !== 'number') return
      const request = pending.get(value.id)
      if (!request) return
      clearTimeout(request.timer); pending.delete(value.id)
      if (value.ok === true) request.resolve()
      else request.reject(new Error(String(value.error ?? '手机操作失败')))
    },
    reset() {
      release(); geometry = { width: 0, height: 0, epoch: 0 }; blocked = false
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('控制连接已结束')) }
      pending.clear(); hint.textContent = '点击画面可控制，按住拖动可滑动；右键返回'; hint.style.color = '#929b9a'
    },
    dispose() {
      disposed = true; this.reset(); clearInterval(interval)
      video.removeEventListener('pointerdown', down); video.removeEventListener('pointermove', move)
      video.removeEventListener('pointerup', up); video.removeEventListener('pointercancel', up)
      video.removeEventListener('lostpointercapture', release); video.removeEventListener('keydown', keyboard)
      video.removeEventListener('wheel', wheel); video.removeEventListener('contextmenu', context)
      window.removeEventListener('blur', release); document.removeEventListener('visibilitychange', visibility)
    },
  }
}
