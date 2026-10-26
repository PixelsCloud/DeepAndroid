import { extraApi } from './browser-file-api.js'
import { notify } from './browser-toast.js'
import {
  childPath,
  parentPath,
  phonePath,
  fileName,
  type DirectoryPage,
} from './file-manager-model.js'
export const element = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
) => {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  if (className) node.className = className
  return node
}
export const bytes = (size: number | string | undefined) => {
  if (size === undefined) return '—'
  const value = Number(size)
  if (value < 1024) return value + ' B'
  if (value < 1024 ** 2) return (value / 1024).toFixed(1) + ' KiB'
  if (value < 1024 ** 3) return (value / 1024 ** 2).toFixed(1) + ' MiB'
  return (value / 1024 ** 3).toFixed(2) + ' GiB'
}
export const dateText = (value: string | null | undefined) =>
  value
    ? new Date(value).toLocaleString([], {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—'
export const leaf = (path: string) => path.split('/').at(-1) || '/'
export function createDialogs(root: HTMLElement) {
  const active = new Set<HTMLDialogElement>()
  function open<T>(
    title: string,
    build: (context: {
      dialog: HTMLDialogElement
      body: HTMLElement
      footer: HTMLElement
      error: (message: string) => void
      done: (value: T | null) => void
      button: (
        text: string,
        action: () => void,
        className?: string,
      ) => HTMLButtonElement
    }) => void,
  ): Promise<T | null> {
    return new Promise((resolve) => {
      const dialog = element('dialog', undefined, 'android-fm-dialog'),
        heading = element('h3', title),
        body = element('div'),
        alert = element('p'),
        footer = element('footer')
      let settled = false
      dialog.setAttribute('aria-label', title)
      alert.setAttribute('role', 'alert')
      alert.hidden = true
      dialog.append(heading, body, alert, footer)
      root.append(dialog)
      active.add(dialog)
      const done = (value: T | null) => {
        if (settled) return
        settled = true
        active.delete(dialog)
        dialog.close()
        dialog.remove()
        resolve(value)
      }
      const button = (text: string, action: () => void, className?: string) => {
        const node = element('button', text, className)
        node.type = 'button'
        node.onclick = action
        footer.append(node)
        return node
      }
      dialog.oncancel = (event) => {
        event.preventDefault()
        done(null)
      }
      dialog.onclose = () => done(null)
      build({
        dialog,
        body,
        footer,
        done,
        button,
        error(message) {
          notify(root, message, 'error')
        },
      })
      dialog.showModal()
      queueMicrotask(() =>
        dialog.querySelector<HTMLInputElement>('input')?.focus(),
      )
    })
  }
  function name(title: string, value = '', description = '') {
    return open<string>(title, (context) => {
      const input = element('input')
      input.type = 'text'
      input.value = value
      input.maxLength = 240
      input.setAttribute('aria-label', '名称')
      if (description) context.body.append(element('p', description, 'muted'))
      context.body.append(input)
      const accept = () => {
        try {
          context.done(fileName(input.value))
        } catch (error) {
          context.error((error as Error).message)
        }
      }
      context.button('取消', () => context.done(null))
      context.button('确定', accept, 'primary')
      input.onkeydown = (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          accept()
        }
      }
      queueMicrotask(() =>
        input.setSelectionRange(
          0,
          value.lastIndexOf('.') > 0 ? value.lastIndexOf('.') : value.length,
        ),
      )
    })
  }
  function confirm(
    title: string,
    message: string,
    label = '确定',
    danger = false,
  ) {
    return open<boolean>(title, (context) => {
      context.body.append(element('p', message))
      context.button('取消', () => context.done(null))
      context.button(
        label,
        () => context.done(true),
        danger ? 'danger' : 'primary',
      )
    })
  }
  function folder(title: string, serial: string, start: string, name?: string) {
    return open<{ directory: string; name?: string }>(title, (context) => {
      const nav = element('div', undefined, 'folder-nav'),
        up = element('button', '上一级'),
        path = element('input'),
        go = element('button', '前往'),
        list = element('div', undefined, 'folder-list'),
        note = element('p', '选择目标目录', 'muted'),
        newName = element('input')
      let current = start,
        loaded = false,
        revision = 0,
        abort: AbortController | undefined
      path.type = 'text'
      path.value = start
      path.setAttribute('aria-label', '目标文件夹')
      nav.append(up, path, go)
      context.body.append(nav, list, note)
      if (name !== undefined) {
        newName.type = 'text'
        newName.value = name
        newName.setAttribute('aria-label', '目标名称')
        context.body.append(element('p', '目标名称', 'muted'), newName)
      }
      const browse = async (value: string, offset = 0) => {
        const own = ++revision
        abort?.abort()
        abort = new AbortController()
        loaded = false
        try {
          const target = phonePath(value)
          context.error('')
          path.value = target
          if (!offset) list.replaceChildren(element('span', '正在读取…'))
          const page = await extraApi<DirectoryPage>(
            '/file-manager/directory?' +
              new URLSearchParams({
                serial,
                path: target,
                limit: '200',
                offset: String(offset),
              }),
            undefined,
            abort.signal,
          )
          if (own !== revision || !context.dialog.open) return
          if (!offset) list.replaceChildren()
          current = page.path
          loaded = true
          for (const entry of page.entries.filter(
            (entry) => entry.type === 'directory',
          )) {
            const button = element('button', '▸ ' + entry.name)
            button.type = 'button'
            button.onclick = () => void browse(entry.path)
            list.append(button)
          }
          if (page.next_offset !== null) {
            const button = element('button', '加载更多目录')
            button.onclick = () => {
              button.remove()
              void browse(current, page.next_offset!)
            }
            list.append(button)
          }
          note.textContent = page.truncated
            ? '目录较大，当前最多读取 10000 项'
            : '目标：' + current
        } catch (error) {
          if (own === revision && context.dialog.open) {
            list.replaceChildren()
            context.error((error as Error).message)
          }
        }
      }
      go.onclick = () => void browse(path.value)
      up.onclick = () => void browse(parentPath(current))
      path.onkeydown = (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          void browse(path.value)
        }
      }
      context.dialog.addEventListener('close', () => abort?.abort(), {
        once: true,
      })
      context.button('取消', () => context.done(null))
      context.button(
        '选择此目录',
        () => {
          try {
            if (!loaded) throw new Error('请先前往一个可读取的目标目录')
            context.done({
              directory: current,
              ...(name !== undefined ? { name: fileName(newName.value) } : {}),
            })
          } catch (error) {
            context.error((error as Error).message)
          }
        },
        'primary',
      )
      void browse(start)
    })
  }
  return {
    open,
    name,
    confirm,
    folder,
    dispose() {
      for (const dialog of active) dialog.close()
      active.clear()
    },
  }
}
