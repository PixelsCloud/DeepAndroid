import {createDialogs, element as el, bytes} from './browser-file-dialogs.js'
import {MAX_PREVIEW_BYTES} from './image-preview.js'
import type {FileEntry} from './file-manager-model.js'

export async function openImagePreview(dialogs: ReturnType<typeof createDialogs>, serial: string, entry: FileEntry) {
  const abort = new AbortController()
  let objectUrl = '', image: HTMLImageElement | undefined
  const release = () => {
    if (image) image.removeAttribute('src')
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    objectUrl = ''
  }
  try {
    await dialogs.open<void>('图片预览', view => {
      view.dialog.classList.add('fm-image-preview')
      view.dialog.style.width = 'min(1000px, calc(100vw - 32px))'
      const style = el('style')
      style.textContent = `
        .fm-image-preview[open]{display:flex;flex-direction:column;max-height:calc(100dvh - 32px);overflow:hidden}
        .fm-image-preview>div{display:flex;flex-direction:column;min-height:0;flex:1}
        .fm-image-preview>h3,.fm-image-preview>footer{flex:none}
        .fm-image-preview>footer{flex-wrap:wrap}
        .fm-image-preview .preview-name{overflow-wrap:anywhere;margin:0 0 8px;max-height:3em;overflow:auto;flex:none}
        .fm-image-preview .preview-stage{height:min(65vh,720px);min-height:0;flex:1 1 auto;overflow:auto;display:flex;background:#090c10;border:1px solid #8883;border-radius:8px}
        .fm-image-preview img{display:block;object-fit:contain;max-width:100%;max-height:100%;margin:auto}
        .fm-image-preview img[hidden]{display:none}
        .fm-image-preview .preview-stage.actual img{max-width:none;max-height:none;flex:none}
        .fm-image-preview .preview-status{color:#98a1ab;font-size:12px;margin:10px 0;overflow-wrap:anywhere;flex:none}
      `
      const name = el('p', entry.name, 'preview-name'), stage = el('div', undefined, 'preview-stage'), status = el('p', '正在读取图片…', 'preview-status')
      status.setAttribute('role', 'status')
      image = el('img')
      image.alt = entry.name
      image.hidden = true
      stage.append(image)
      view.body.append(style, name, stage, status)
      const zoom = view.button('原始尺寸', () => {
        const actual = stage.classList.toggle('actual')
        zoom.textContent = actual ? '适应窗口' : '原始尺寸'
        zoom.setAttribute('aria-pressed', String(actual))
      })
      zoom.disabled = true
      zoom.setAttribute('aria-pressed', 'false')
      const retry = view.button('重试', () => void load())
      retry.hidden = true
      const close = view.button('关闭', () => view.done(null))
      close.autofocus = true
      view.dialog.addEventListener('close', () => { abort.abort(); release() }, {once: true})
      async function load() {
        retry.hidden = true
        zoom.disabled = true
        image!.hidden = true
        release()
        status.textContent = '正在读取图片…'
        try {
          if (Number(entry.bytes) > MAX_PREVIEW_BYTES) throw new Error('图片超过 20 MiB，请下载后查看')
          const response = await fetch('/x-android/file-manager/preview?' + new URLSearchParams({serial, path: entry.path, version: entry.version}), {
            headers: {'x-android-client': '1'}, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(35000)]),
          })
          if (!response.ok) throw new Error((await response.json()).error ?? '图片读取失败')
          const blob = await response.blob()
          abort.signal.throwIfAborted()
          if (blob.size > MAX_PREVIEW_BYTES || !/^image\/(png|jpeg|gif|webp)$/.test(blob.type)) throw new Error('图片格式或大小不支持预览')
          objectUrl = URL.createObjectURL(blob)
          image!.src = objectUrl
          try { await image!.decode() } catch { throw new Error('图片无法解码，文件可能已损坏，请下载后查看') }
          abort.signal.throwIfAborted()
          image!.hidden = false
          zoom.disabled = false
          status.textContent = `${image!.naturalWidth} × ${image!.naturalHeight} · ${bytes(blob.size)}`
        } catch (error) {
          release()
          if (abort.signal.aborted) return
          status.textContent = '预览失败，可重试或关闭后下载查看。'
          retry.hidden = false
          view.error((error as Error).message)
        }
      }
      void load()
    })
  } finally {
    abort.abort()
    release()
  }
}
