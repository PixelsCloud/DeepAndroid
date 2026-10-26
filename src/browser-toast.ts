export type ToastKind = 'info' | 'error'
const eventName = 'android-toast'
type Notice = { message: string; kind: ToastKind; key?: string; reset?: boolean }

export function notify(root: HTMLElement, value: unknown, kind: ToastKind = 'info', key?: string) {
  const message = value instanceof Error ? value.message : String(value ?? '')
  if (message.trim()) root.dispatchEvent(new CustomEvent<Notice>(eventName, { bubbles: true, detail: { message, kind, key } }))
}
/** Recovery allows a future error; it never dismisses an existing error toast. */
export function resetNotice(root: HTMLElement, key: string) {
  root.dispatchEvent(new CustomEvent<Notice>(eventName, { bubbles: true, detail: { message: '', kind: 'info', key, reset: true } }))
}

export function mountToasts(root: HTMLElement) {
  const region = document.createElement('div'), style = document.createElement('style')
  region.className = 'android-toasts'
  region.setAttribute('role', 'region')
  region.setAttribute('aria-label', 'Android 消息通知')
  region.setAttribute('popover', 'manual')
  style.textContent = `
    .android-toasts{position:fixed;inset:16px 16px auto auto;margin:0;padding:0;width:min(380px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:10px;border:0;background:transparent;color:#e7edf2;font:13px/1.5 system-ui,sans-serif;pointer-events:none;z-index:2147483647;scrollbar-width:thin}
    .android-toasts:empty{display:none}.android-toasts::backdrop{display:none}.android-toasts *{box-sizing:border-box}
    .android-toast{position:relative;display:grid;grid-template-columns:22px minmax(0,1fr) 28px;gap:10px;align-items:start;flex:none;padding:14px;border:1px solid #45555e;border-radius:12px;background:#1c252d;box-shadow:0 8px 28px #0004;pointer-events:auto;animation:android-toast-in .18s ease-out}
    .android-toast[data-kind=error]{border-color:#834b50;background:#302329}.android-toast-icon{display:grid;place-items:center;width:20px;height:20px;margin-top:1px;border:1px solid currentColor;border-radius:50%;color:#74d5bb;font-weight:700;font-size:12px}.android-toast[data-kind=error] .android-toast-icon{color:#ffadad}
    .android-toast-title{font-size:12px;font-weight:600;color:#a6e4d4}.android-toast[data-kind=error] .android-toast-title{color:#ffc3c3}.android-toast-message{margin:3px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;max-height:min(40vh,300px);overflow:auto;color:#e7edf2}
    .android-toasts .android-toast-close{display:grid;place-items:center;width:28px;height:28px;padding:0;margin:-4px -4px 0 0;border:0;border-radius:6px;background:transparent;color:#c3cbd1;font:22px/1 system-ui;cursor:pointer}.android-toasts .android-toast-close:hover{background:#ffffff15;color:#fff}.android-toasts .android-toast-close:focus-visible{outline:2px solid #74d5bb;outline-offset:2px}
    @keyframes android-toast-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}@media(prefers-reduced-motion:reduce){.android-toast{animation:none}}
  `
  document.head.append(style)
  document.body.append(region)
  let disposed = false
  const seen = new Map<string, string>()
  const entries = new Map<string, { node: HTMLElement; close: () => void }>()
  const syncLayer = () => {
    if (disposed) return
    // A toast outside a modal is inert. Keep it inside the current dialog and
    // above it in the top layer, so its close button always remains operable.
    const dialogs = [...root.querySelectorAll<HTMLDialogElement>('dialog[open]')]
    const parent = dialogs.at(-1) ?? document.body
    if (region.parentElement !== parent) { if (region.matches(':popover-open')) region.hidePopover(); parent.append(region) }
    if (entries.size && !region.matches(':popover-open')) region.showPopover()
    else if (!entries.size && region.matches(':popover-open')) region.hidePopover()
  }
  const observer = new MutationObserver(records => {
    if (records.some(record => record.target instanceof HTMLDialogElement || [...record.addedNodes, ...record.removedNodes].some(node => node instanceof HTMLDialogElement))) syncLayer()
  })
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] })
  const receive = (event: Event) => {
    const detail = (event as CustomEvent<Notice>).detail
    if (disposed || !detail) return
    event.stopPropagation()
    if (detail.reset) { if (detail.key) seen.delete(detail.key); return }
    const { message, kind, key } = detail
    if (key && seen.get(key) === message) return
    if (key) seen.set(key, message)
    const identity = kind + '\0' + message
    if (entries.has(identity)) return
    const node = document.createElement('div'), icon = document.createElement('span'), body = document.createElement('div'), title = document.createElement('div'), text = document.createElement('p'), close = document.createElement('button')
    node.className = 'android-toast'; node.dataset.kind = kind
    body.setAttribute('role', kind === 'error' ? 'alert' : 'status'); body.setAttribute('aria-atomic', 'true')
    icon.className = 'android-toast-icon'; icon.textContent = kind === 'error' ? '!' : 'i'; icon.setAttribute('aria-hidden', 'true')
    title.className = 'android-toast-title'; title.textContent = kind === 'error' ? '操作失败' : '提示'
    text.className = 'android-toast-message'; text.textContent = message
    close.className = 'android-toast-close'; close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', kind === 'error' ? '关闭错误提示' : '关闭提示')
    body.append(title, text); node.append(icon, body, close)
    let timer: ReturnType<typeof setTimeout> | undefined, remaining = 5000, started = 0, hovered = false, focused = false, removed = false
    const remove = () => {
      if (removed) return
      removed = true
      clearTimeout(timer)
      const restoreFocus = node.contains(document.activeElement)
      entries.delete(identity); node.remove(); syncLayer()
      if (restoreFocus && !disposed) {
        const next = region.querySelector<HTMLButtonElement>('button')
        const fallback = root.querySelector<HTMLElement>('dialog[open] button, [data-panel-tab][aria-selected=true]')
        ;(next ?? fallback)?.focus({ preventScroll: true })
      }
    }
    const pause = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; remaining = Math.max(0, remaining - (Date.now() - started)) } }
    const resume = () => { if (!removed && !disposed && kind === 'info' && !hovered && !focused && timer === undefined) { started = Date.now(); timer = setTimeout(remove, remaining) } }
    node.onmouseenter = () => { hovered = true; pause() }
    node.onmouseleave = () => { hovered = false; resume() }
    node.addEventListener('focusin', () => { focused = true; pause() })
    node.addEventListener('focusout', event => { if (!node.contains(event.relatedTarget as Node | null)) { focused = false; resume() } })
    close.onclick = remove
    entries.set(identity, { node, close: remove }); region.append(node); syncLayer(); resume()
  }
  root.addEventListener(eventName, receive)
  return { dispose() { disposed = true; observer.disconnect(); root.removeEventListener(eventName, receive); for (const entry of [...entries.values()]) entry.close(); seen.clear(); region.remove(); style.remove() } }
}
