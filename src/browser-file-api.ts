const headers = { 'content-type': 'application/json', 'x-android-client': '1' }
export async function extraApi<T>(
  path: string,
  value?: object,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch('/x-android' + path, {
    method: value ? 'POST' : 'GET',
    headers,
    body: value ? JSON.stringify(value) : undefined,
    signal: signal ?? AbortSignal.timeout(145000),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error ?? '操作失败')
  return data as T
}
export async function downloadFile(id: string) {
  const value = await extraApi<{ url: string }>('/download-ticket', { id }),
    link = document.createElement('a')
  link.href = value.url
  link.download = ''
  document.body.append(link)
  link.click()
  link.remove()
}
export function uploadFile(
  file: File,
  signal: AbortSignal,
  progress: (loaded: number, total: number) => void,
): Promise<{ id: string; name: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const xhr = new XMLHttpRequest(),
      abort = () => xhr.abort()
    signal.addEventListener('abort', abort, { once: true })
    xhr.open(
      'POST',
      '/x-android/file-upload?name=' + encodeURIComponent(file.name),
    )
    xhr.setRequestHeader('x-android-client', '1')
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    xhr.timeout = 300000
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) progress(event.loaded, event.total)
    }
    xhr.onload = () => {
      try {
        const result = JSON.parse(xhr.responseText)
        if (xhr.status < 200 || xhr.status >= 300)
          throw new Error(result.error ?? '上传暂存失败')
        resolve(result)
      } catch (error) {
        reject(error)
      }
    }
    xhr.onerror = () => reject(new Error('电脑文件上传连接中断'))
    xhr.ontimeout = () => reject(new Error('电脑文件上传超时'))
    xhr.onabort = () => reject(signal.reason ?? new Error('上传已取消'))
    xhr.onloadend = () => signal.removeEventListener('abort', abort)
    xhr.send(file)
  })
}
