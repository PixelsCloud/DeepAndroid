import { extraApi, uploadFile, downloadFile } from './browser-file-api.js'
import { notify, resetNotice } from './browser-toast.js'
import { fileLayout, fileIcon } from './browser-file-layout.js'
import {previewableImage} from './image-preview.js'
import {openImagePreview} from './browser-image-preview.js'
import {
  createDialogs,
  element as el,
  bytes,
  dateText,
  leaf,
} from './browser-file-dialogs.js'
import {
  phonePath,
  childPath,
  parentPath,
  type FileEntry,
  type DirectoryPage,
  type ManagerJob,
  type ManagerRequest,
} from './file-manager-model.js'
import type { RemoteStat } from './remote-files.js'
import type { FileJob } from './files.js'

const quick: [string, string][] = [
  ['内部存储', '/sdcard'],
  ['下载', '/sdcard/Download'],
  ['相机', '/sdcard/DCIM'],
  ['图片', '/sdcard/Pictures'],
  ['视频', '/sdcard/Movies'],
  ['音乐', '/sdcard/Music'],
  ['文档', '/sdcard/Documents'],
]
const names: Record<string, string> = {
  push: '上传',
  pull: '下载',
  install: '安装 APK',
  mkdir: '新建文件夹',
  copy: '复制',
  move: '移动',
  rename: '重命名',
  delete: '删除',
  queued: '等待执行',
  running: '进行中',
  conflict: '同名待处理',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
  skipped: '已跳过',
  preparing: '准备中',
  transferring: '传输中',
  committing: '提交文件',
  executing: '正在执行',
  verifying: '核对哈希',
  installing: '等待系统安装',
  cancelling: '请求取消中',
  interrupted: '已中断',
  finished: '完成',
}
type Upload = {
  id: string
  file: File
  serial: string
  path: string
  status: 'queued' | 'uploading' | 'accepted' | 'failed' | 'cancelled'
  percent?: number
  job_id?: string
  error?: string
  abort: AbortController
}
type History = { paths: string[]; index: number }
export function mountFileManager(
  root: HTMLElement,
  preferredSerial: () => string,
) {
  root.innerHTML = fileLayout
  const get = <T extends HTMLElement>(selector: string) =>
      root.querySelector<T>(selector)!,
    button = (name: string) =>
      get<HTMLButtonElement>('[data-fm="' + name + '"]'),
    device = get<HTMLSelectElement>('.fm-device'),
    pathInput = get<HTMLInputElement>('.fm-path'),
    filter = get<HTMLInputElement>('[type=search]'),
    sort = get<HTMLSelectElement>('[aria-label="文件排序"]'),
    hidden = get<HTMLInputElement>('[data-fm=hidden]'),
    pick = get<HTMLInputElement>('[data-file-pick]'),
    tbody = get<HTMLTableSectionElement>('tbody'),
    all = get<HTMLInputElement>('thead input'),
    empty = get<HTMLElement>('.fm-empty'),
    note = get<HTMLElement>('.fm-note'),
    queue = get<HTMLElement>('.fm-queue'),
    context = get<HTMLElement>('.fm-context'),
    dialogs = createDialogs(root)
  let disposed = false,
    visible = false,
    initialized = false,
    loading = false,
    loaded = false,
    path = '/sdcard/Download',
    serial = '',
    descending = false,
    page: DirectoryPage | null = null,
    entries: FileEntry[] = [],
    revision = 0,
    request: AbortController | undefined,
    uploading = false,
    polling = false,
    filterTimer: ReturnType<typeof setTimeout> | undefined,
    retryTarget: { serial: string; path: string } | undefined
  const selected = new Set<string>(),
    histories = new Map<string, History>(),
    uploads: Upload[] = [],
    autoDownloads = new Set<string>(),
    autoSaved = new Set<string>(),
    seenTerminal = new Set<string>()
  let jobs: ManagerJob[] = [],
    legacy: FileJob[] = [],
    recordings: {
      id: string
      status: string
      bytes: number
      duration_ms: number
      started_at: string
    }[] = []
  const say = (message: string, error = false) => {
    if (disposed) return
    note.hidden = true
    notify(root, message, error ? 'error' : 'info')
  }
  const run = (work: () => Promise<void>) =>
    void work().catch((error) => {
      if (!disposed) say(String((error as Error).message ?? error), true)
    })
  const picked = () => entries.filter((entry) => selected.has(entry.path))
  function history() {
    let value = histories.get(serial)
    if (!value) {
      value = { paths: [], index: -1 }
      histories.set(serial, value)
    }
    return value
  }
  function controls() {
    const list = picked()
    button('upload').disabled = button('mkdir').disabled =
      !serial || !loaded || loading
    button('download').disabled =
      !list.length || list.some((entry) => entry.type !== 'file')
    button('more').disabled = !list.length
    button('back').disabled = history().index <= 0
    button('forward').disabled = history().index >= history().paths.length - 1
    button('up').disabled = path === '/'
    all.checked = entries.length > 0 && selected.size === entries.length
    all.indeterminate = selected.size > 0 && selected.size < entries.length
    get('.fm-summary span').textContent = page
      ? `${page.matched_count} 项 · 已加载 ${entries.length}${selected.size ? ' · 已选 ' + selected.size + ' 项' : ''}${page.truncated ? ' · 达到 10000 项读取上限' : ''}`
      : loading
        ? '正在读取目录…'
        : ''
  }
  function breadcrumbs() {
    const container = get('.fm-breadcrumbs')
    container.replaceChildren()
    const parts = path.split('/').filter(Boolean)
    const add = (text: string, target: string) => {
      const node = el('button', text)
      node.title = target
      node.onclick = () => run(() => browse(target))
      container.append(node)
    }
    add('存储', '/')
    let target = ''
    for (const part of parts) {
      target += '/' + part
      container.append(el('span', '/'))
      add(part, target)
    }
    for (const item of root.querySelectorAll<HTMLButtonElement>(
      '.fm-sidebar button',
    ))
      item.setAttribute('aria-current', String(item.dataset.path === path))
  }
  function emptyState(title: string, message = '', retry = false) {
    empty.hidden = false
    empty.replaceChildren()
    const icon = el('div')
    icon.innerHTML = fileIcon('folder')
    empty.append(icon, el('strong', title), el('p', message))
    if (retry) {
      const node = el('button', '重新读取')
      node.onclick = () => run(() => browse(path, false))
      empty.append(node)
    }
  }
  function renderRows() {
    tbody.replaceChildren()
    for (const entry of entries) {
      const row = el('tr')
      row.dataset.entryPath = entry.path
      row.setAttribute('aria-selected', String(selected.has(entry.path)))
      row.tabIndex = 0
      const cell = el('td'),
        check = el('input')
      check.type = 'checkbox'
      check.checked = selected.has(entry.path)
      check.setAttribute('aria-label', '选择 ' + entry.name)
      const toggle = () => {
        if (selected.has(entry.path)) selected.delete(entry.path)
        else selected.add(entry.path)
        check.checked = selected.has(entry.path)
        row.setAttribute('aria-selected', String(check.checked))
        controls()
      }
      check.onchange = toggle
      cell.append(check)
      const nameCell = el('td'),
        wrap = el(
          'div',
          undefined,
          'fm-entry ' + (entry.type === 'directory' ? 'folder' : ''),
        ),
        icon = el('span')
      icon.innerHTML = fileIcon(entry.type === 'directory' ? 'folder' : 'file')
      const label = el('div', undefined, 'fm-entry-label'),
        name = el('button', entry.name, 'fm-entry-name'),
        sub = el(
          'span',
          (entry.type === 'directory'
            ? '文件夹'
            : entry.type === 'symlink'
              ? '符号链接'
              : bytes(entry.bytes)) +
            ' · ' +
            dateText(entry.modified_at),
          'fm-entry-sub',
        )
      name.title = entry.name
      if (previewableImage(entry)) name.title += ' · 点击预览'
      name.onclick = () => {
        if (entry.type === 'directory') run(() => browse(entry.path))
        else if (previewableImage(entry)) run(() => openImagePreview(dialogs, serial, entry))
        else {
          selected.clear()
          selected.add(entry.path)
          renderRows()
          controls()
        }
      }
      name.ondblclick = () => {
        if (entry.type !== 'directory' && !previewableImage(entry)) run(() => details(entry))
      }
      label.append(name, sub)
      wrap.append(icon, label)
      nameCell.append(wrap)
      const size = el(
          'td',
          entry.type === 'directory' ? '—' : bytes(entry.bytes),
          'fm-size',
        ),
        date = el('td', dateText(entry.modified_at), 'fm-date'),
        more = el('td'),
        menu = el('button', undefined, 'fm-row-menu')
      menu.innerHTML = fileIcon('more')
      menu.setAttribute('aria-label', '操作 ' + entry.name)
      menu.onclick = () => {
        const rect = menu.getBoundingClientRect()
        if (!selected.has(entry.path)) {
          selected.clear()
          selected.add(entry.path)
          renderRows()
          controls()
        }
        showMenu(rect.left, rect.bottom)
      }
      more.append(menu)
      row.append(cell, nameCell, size, date, more)
      row.oncontextmenu = (event) => {
        event.preventDefault()
        if (!selected.has(entry.path)) {
          selected.clear()
          selected.add(entry.path)
          renderRows()
          controls()
        }
        showMenu(event.clientX, event.clientY)
      }
      row.onkeydown = (event) => {
        if (event.target !== row) return
        if (event.key === ' ') {
          event.preventDefault()
          toggle()
        } else if (event.key === 'Enter') {
          event.preventDefault()
          if (entry.type === 'directory') run(() => browse(entry.path))
          else if (previewableImage(entry)) run(() => openImagePreview(dialogs, serial, entry))
          else run(() => details(entry))
        }
      }
      tbody.append(row)
    }
    empty.hidden = entries.length > 0
    if (!entries.length && loaded)
      emptyState(
        page?.read_count ? '没有符合筛选的文件' : '这个文件夹是空的',
        filter.value
          ? '清空筛选可查看当前目录文件'
          : '可点击上传文件，或将电脑文件拖到这里。',
      )
    controls()
  }
  async function remember() {
    if (!serial || !loaded) return
    await extraApi('/file-manager/places', {
      serial,
      path,
      sort: sort.value,
      descending,
      hidden: hidden.checked,
    })
  }
  async function browse(target: string, push = true, offset = 0) {
    if (!serial) {
      emptyState('请选择手机')
      return
    }
    target = phonePath(target)
    const preserve = !push && target === path && !offset
    const own = ++revision,
      ownSerial = serial
    request?.abort()
    request = new AbortController()
    loading = true
    if (!offset && !preserve) {
      loaded = false
      entries = []
      selected.clear()
      tbody.replaceChildren()
      emptyState('正在读取目录…')
    }
    path = target
    root.dataset.currentPath = target
    root.dataset.currentSerial = ownSerial
    root.dataset.loaded = 'false'
    pathInput.value = target
    breadcrumbs()
    controls()
    try {
      const result = await extraApi<DirectoryPage>(
        '/file-manager/directory?' +
          new URLSearchParams({
            serial: ownSerial,
            path: target,
            offset: String(offset),
            limit: '200',
            sort: sort.value,
            descending: descending ? '1' : '0',
            hidden: hidden.checked ? '1' : '0',
            filter: filter.value,
          }),
        undefined,
        request.signal,
      )
      if (disposed || own !== revision || ownSerial !== serial) return
      const keep = preserve
        ? new Map(
            entries
              .filter((entry) => selected.has(entry.path))
              .map((entry) => [entry.path, entry.version]),
          )
        : new Map<string, string>()
      if (!offset) selected.clear()
      page = result
      entries = offset
        ? [
            ...new Map(
              [...entries, ...result.entries].map((entry) => [
                entry.path,
                entry,
              ]),
            ).values(),
          ]
        : result.entries
      loaded = true
      root.dataset.loaded = 'true'
      for (const entry of entries)
        if (keep.get(entry.path) === entry.version) selected.add(entry.path)
      if (push && !offset) {
        const h = history()
        if (h.paths[h.index] !== target) {
          h.paths = h.paths.slice(0, h.index + 1)
          h.paths.push(target)
          h.index = h.paths.length - 1
        }
      }
      button('load-more').hidden = result.next_offset === null
      renderRows()
      run(remember)
      if (result.truncated)
        say(
          '当前最多读取 10000 项；筛选只覆盖已读取的当前目录，请进入更小的目录。',
        )
      else say('')
    } catch (error) {
      if (own === revision && !disposed) {
        loaded = false
        root.dataset.loaded = 'false'
        page = null
        entries = []
        selected.clear()
        tbody.replaceChildren()
        button('load-more').hidden = true
        emptyState('无法读取此目录', (error as Error).message, true)
        say((error as Error).message, true)
      }
    } finally {
      if (own === revision) {
        loading = false
        controls()
      }
    }
  }
  async function refreshDevices() {
    const data = await extraApi<{
      devices: { serial: string; model: string; state: string }[]
    }>('/devices')
    if (disposed) return
    const old = serial || preferredSerial()
    device.replaceChildren()
    if (!data.devices.length) {
      device.append(new Option('没有已连接的手机', ''))
      serial = ''
      loaded = false
      emptyState('没有已连接的手机', '连接 USB 并授权后，点击刷新目录。')
      controls()
      return
    }
    for (const item of data.devices) {
      const option = new Option(
        item.model +
          ' · ' +
          item.serial +
          (item.state === 'device' ? '' : ' · ' + item.state),
        item.serial,
      )
      option.disabled = item.state !== 'device'
      device.append(option)
    }
    if (old && !data.devices.some((item) => item.serial === old)) {
      const option = new Option(old + ' · 未连接', old)
      option.disabled = true
      device.prepend(option)
    }
    const online = data.devices.filter((item) => item.state === 'device')
    if (!old && online.length !== 1)
      device.prepend(new Option('请选择手机', ''))
    device.value = old || (online.length === 1 ? online[0]!.serial : '')
    if (!serial) serial = device.value
  }
  async function start() {
    if (initialized) return
    initialized = true
    try {
      const saved = await extraApi<{
        places: Record<
          string,
          { path: string; sort: string; descending: boolean; hidden: boolean }
        >
        lastSerial: string | null
      }>('/file-manager/places')
      serial = saved.lastSerial ?? preferredSerial()
      await refreshDevices()
      if (!serial && saved.lastSerial) {
        serial = saved.lastSerial
        device.value = serial
      }
      const place = saved.places[serial]
      if (place) {
        path = place.path
        sort.value = place.sort
        descending = place.descending
        hidden.checked = place.hidden
      }
      button('descending').textContent = descending ? '↓' : '↑'
      if (serial) await browse(path)
      await refreshJobs()
    } catch (error) {
      initialized = false
      say((error as Error).message, true)
    }
  }
  async function enqueue(value: ManagerRequest) {
    const job = await extraApi<ManagerJob>('/file-manager/jobs', value)
    jobs.unshift(job)
    renderJobs()
    run(refreshJobs)
    return job
  }
  async function batch(
    operation: ManagerRequest['operation'],
    list: FileEntry[],
    destination?: { directory: string; name?: string },
  ) {
    if (list.length > 100) throw new Error('每批最多操作 100 项，请缩小选择')
    const ownSerial = serial
    let accepted = 0
    try {
      for (const entry of list) {
        await enqueue({
          operation,
          serial: ownSerial,
          path: entry.path,
          expected_version: entry.version,
          ...(destination
            ? {
                destination: childPath(
                  destination.directory,
                  destination.name ?? entry.name,
                ),
              }
            : {}),
          ...(['copy', 'delete'].includes(operation)
            ? { recursive: true }
            : {}),
        })
        accepted++
      }
      say(`已加入 ${accepted} 项${names[operation]}作业`)
      selected.clear()
      renderRows()
      setQueue(true)
    } catch (error) {
      say(
        `已加入 ${accepted} / ${list.length} 项；${(error as Error).message}`,
        true,
      )
    }
  }
  async function operation(
    action: string,
    snapshot?: FileEntry[],
    selectedSerial = serial,
  ) {
    context.hidden = true
    if (serial !== selectedSerial) throw new Error('设备已变化，请重新选择文件')
    const list = snapshot ?? picked()
    if (list.length > 100) throw new Error('每批最多操作 100 项')
    if (action === 'mkdir') {
      const ownSerial = serial,
        ownPath = path,
        name = await dialogs.name('新建文件夹', '', '创建于 ' + path)
      if (name) {
        await enqueue({
          operation: 'mkdir',
          serial: ownSerial,
          path: childPath(ownPath, name),
        })
        setQueue(true)
      }
      return
    }
    if (!list.length) return
    if (action === 'details') {
      await details(list[0]!)
      return
    }
    if (action === 'download') {
      const ownSerial = serial
      for (const entry of list) {
        if (entry.type !== 'file')
          throw new Error('第一版下载支持普通文件；文件夹打包下载将在后续提供')
        const job = await enqueue({
          operation: 'pull',
          serial: ownSerial,
          path: entry.path,
          expected_version: entry.version,
        })
        autoDownloads.add(job.id)
      }
      say('已加入下载作业；取回并校验后发起浏览器保存，也可在作业中再次保存。')
      setQueue(true)
      return
    }
    if (action === 'rename') {
      if (list.length !== 1) throw new Error('重命名请选择一项')
      const ownSerial = serial,
        entry = list[0]!,
        name = await dialogs.name(
          '重命名',
          entry.name,
          '当前路径：' + entry.path,
        )
      if (name && name !== entry.name)
        await enqueue({
          operation: 'rename',
          serial: ownSerial,
          path: entry.path,
          destination: childPath(parentPath(entry.path), name),
          expected_version: entry.version,
        })
      setQueue(true)
      return
    }
    if (action === 'copy' || action === 'move') {
      const ownSerial = serial,
        result = await dialogs.folder(
          names[action] + '到…',
          serial,
          path,
          list.length === 1 ? list[0]!.name : undefined,
        )
      if (result) {
        if (serial !== ownSerial) throw new Error('设备已变化，请重新选择文件')
        if (
          list.some(
            (entry) =>
              entry.path ===
              childPath(result.directory, result.name ?? entry.name),
          )
        )
          throw new Error('源和目标相同，请选择其他目录或修改目标名称')
        await batch(action, list, result)
      }
      return
    }
    if (action === 'delete') {
      const ownSerial = serial
      if (
        await dialogs.confirm(
          '删除 ' + list.length + ' 项',
          `设备：${serial}\n将永久删除以下路径：\n${list.map((entry) => entry.path).join('\n')}\n\n此操作不能撤销。`,
          '删除',
          true,
        )
      ) {
        if (serial !== ownSerial) throw new Error('设备已变化，请重新选择文件')
        await batch('delete', list)
      }
      return
    }
    if (action === 'install') {
      if (list.length !== 1 || !list[0]!.name.toLowerCase().endsWith('.apk'))
        throw new Error('请选择一个 APK 文件')
      const entry = list[0]!,
        ownSerial = serial
      if (
        await dialogs.confirm(
          '安装 APK',
          entry.path + '\n按手机系统提示确认安装。',
          '开始安装',
        )
      )
        await enqueue({
          operation: 'install',
          serial: ownSerial,
          path: entry.path,
          expected_version: entry.version,
        })
      setQueue(true)
    }
  }
  function showMenu(x: number, y: number) {
    context.replaceChildren()
    const list = picked(),
      selectedSerial = serial
    for (const [action, label] of [
      ['download', '下载'],
      ['copy', '复制到…'],
      ['move', '移动到…'],
      ['rename', '重命名'],
      ['details', '文件详情'],
      ['install', '安装 APK'],
      ['delete', '删除'],
    ]) {
      const node = el(
        'button',
        label,
        action === 'delete' ? 'danger' : undefined,
      )
      node.setAttribute('role', 'menuitem')
      node.disabled =
        !list.length ||
        (action === 'rename' || action === 'details'
          ? list.length !== 1
          : action === 'download'
            ? list.some((entry) => entry.type !== 'file')
            : action === 'install'
              ? list.length !== 1 ||
                !list[0]!.name.toLowerCase().endsWith('.apk')
              : false)
      node.onclick = () => run(() => operation(action!, list, selectedSerial))
      context.append(node)
    }
    context.hidden = false
    context.style.left = Math.max(8, Math.min(x, innerWidth - 186)) + 'px'
    context.style.top = Math.max(8, Math.min(y, innerHeight - 310)) + 'px'
    context.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }
  async function details(entry: FileEntry) {
    const ownSerial = serial
    await dialogs.open<void>('文件详情', (view) => {
      const dl = el('dl'),
        hash = el('dd'),
        path = el('dd', entry.path)
      for (const [key, value] of [
        ['名称', entry.name],
        ['路径', ''],
        ['类型', entry.type],
        ['大小', bytes(entry.bytes)],
        ['修改时间', dateText(entry.modified_at)],
      ]) {
        dl.append(el('dt', key), key === '路径' ? path : el('dd', value))
      }
      dl.append(el('dt', 'SHA-256'), hash)
      hash.textContent = '按需计算'
      view.body.append(dl, el('p', '设备：' + ownSerial, 'muted'))
      const abort = new AbortController()
      view.dialog.addEventListener('close', () => abort.abort(), { once: true })
      view.button('关闭', () => view.done(null))
      view.button('复制路径', () => {
        void navigator.clipboard
          .writeText(entry.path)
          .then(() => {
            if (view.dialog.open)
              hash.textContent =
                hash.textContent === '按需计算'
                  ? '路径已复制；哈希按需计算'
                  : hash.textContent
          })
          .catch(() => view.error('无法写入电脑剪贴板，请选中路径文字复制'))
      })
      const calculate = view.button('计算 SHA-256', () => {
        calculate.disabled = true
        hash.textContent = '正在读取并核对…'
        void extraApi<RemoteStat>(
          '/file-manager/stat?' +
            new URLSearchParams({
              serial: ownSerial,
              path: entry.path,
              hash: '1',
            }),
          undefined,
          abort.signal,
        )
          .then((value) => {
            if (view.dialog.open)
              hash.textContent = value.sha256 ?? '文件不存在或无法计算'
          })
          .catch((error) => {
            if (view.dialog.open) {
              hash.textContent = '计算失败，可重试'
              view.error(error.message)
            }
          })
          .finally(() => {
            calculate.disabled = false
          })
      })
      calculate.disabled = entry.type !== 'file'
    })
  }
  function setQueue(show: boolean) {
    queue.hidden = !show
    button('queue').setAttribute('aria-expanded', String(show))
  }
  async function resolveConflict(job: ManagerJob) {
    await dialogs.open<void>('处理同名文件', (view) => {
      view.body.append(
        el(
          'p',
          `设备：${job.serial}\n目标：${job.conflict?.path}\n已有：${job.conflict?.type === 'directory' ? '文件夹' : bytes(job.conflict?.bytes)} · ${dateText(job.conflict?.modified_at)}`,
        ),
      )
      const name = el('input')
      name.type = 'text'
      name.value = leaf(job.conflict?.path ?? job.path)
      name.setAttribute('aria-label', '冲突后的新名称')
      view.body.append(name)
      const choose = async (choice: string) => {
        try {
          await extraApi('/file-manager/jobs/' + job.id + '/resolve', {
            choice,
            name: name.value,
          })
          view.done(null)
          await refreshJobs()
        } catch (error) {
          view.error((error as Error).message)
        }
      }
      view.button('稍后处理', () => view.done(null))
      view.button('跳过', () => void choose('skip'))
      view.button('改名并继续', () => void choose('rename'), 'primary')
      const overwrite = view.button(
        '覆盖',
        () => void choose('overwrite'),
        'danger',
      )
      overwrite.disabled = job.conflict?.type !== 'file'
    })
  }
  async function retry(job: ManagerJob) {
    if (job.operation === 'push') {
      const source = uploads.find((upload) => upload.job_id === job.id)
      if (source) {
        addUploads([source.file], { serial: job.serial, path: job.path }, true)
      } else {
        retryTarget = { serial: job.serial, path: job.path }
        pick.click()
        say('请重新选择电脑源文件；目标保持为 ' + job.path)
      }
      return
    }
    if (
      job.outcome_uncertain &&
      !(await dialogs.confirm(
        '核对后重试',
        `上次结果不确定，重试前请核对源和目标。\n${job.path}${job.destination ? '\n→ ' + job.destination : ''}`,
        '已核对，重试',
      ))
    )
      return
    await extraApi('/file-manager/jobs/' + job.id + '/retry', {
      confirm_uncertain: job.outcome_uncertain === true,
    })
    setQueue(true)
    await refreshJobs()
  }
  let jobSignature = ''
  function renderJobs() {
    const local = uploads.filter((upload) => !upload.job_id)
    const signature = JSON.stringify([
      local.map(({ id, status, percent, error }) => ({
        id,
        status,
        percent,
        error,
      })),
      jobs,
      legacy,
      recordings,
    ])
    if (signature === jobSignature) return
    jobSignature = signature
    queue.replaceChildren()
    for (const upload of local) {
      const row = el('div', undefined, 'fm-job')
      row.dataset.uploadId = upload.id
      row.append(
        el('strong', upload.file.name),
        el(
          'small',
          `上传 · ${upload.status === 'queued' ? '等待从电脑上传' : upload.status === 'uploading' ? '电脑 → Harness' + (upload.percent === undefined ? '' : ' · ' + upload.percent + '%') : upload.status === 'failed' ? '失败' : '已取消'} · ${bytes(upload.file.size)}\n${upload.serial} · ${upload.path}${upload.error ? '\n' + upload.error : ''}`,
        ),
      )
      if (upload.status === 'uploading' && upload.percent !== undefined) {
        const progress = el('progress')
        progress.max = 100
        progress.value = upload.percent
        progress.setAttribute('aria-label', '电脑上传进度')
        row.append(progress)
      }
      const actions = el('div', undefined, 'fm-job-actions')
      if (['queued', 'uploading'].includes(upload.status)) {
        const cancel = el('button', '取消')
        cancel.onclick = () => {
          upload.abort.abort(new Error('用户取消上传'))
          upload.status = 'cancelled'
          renderJobs()
        }
        actions.append(cancel)
      } else if (upload.status === 'failed' || upload.status === 'cancelled') {
        const retry = el('button', '重试')
        retry.onclick = () =>
          addUploads(
            [upload.file],
            { serial: upload.serial, path: upload.path },
            true,
          )
        actions.append(retry)
      }
      row.append(actions)
      queue.append(row)
    }
    const children = new Set(jobs.map((job) => job.child_job_id))
    for (const job of jobs) {
      const row = el('div', undefined, 'fm-job')
      row.dataset.jobId = job.id
      const head = el('div', undefined, 'fm-job-head')
      head.append(
        el('strong', leaf(job.path)),
        el('small', names[job.status] ?? job.status),
      )
      const status =
        job.status === 'running'
          ? (names[job.phase] ?? '正在操作')
          : names[job.status]
      row.append(
        head,
        el(
          'small',
          `${names[job.operation]} · ${status}${job.bytes !== undefined ? ' · ' + bytes(job.bytes) : ''}\n${job.serial} · ${job.path}${job.destination ? '\n→ ' + job.destination : ''}${job.error ? '\n' + job.error : ''}${job.outcome_uncertain ? '\n操作结果待核对，请检查实际文件' : ''}${job.record_error ? '\n' + job.record_error : ''}`,
        ),
      )
      const actions = el('div', undefined, 'fm-job-actions')
      const action = (text: string, work: () => Promise<void>) => {
        const node = el('button', text)
        node.onclick = () => run(work)
        actions.append(node)
      }
      if (job.download_id && job.status === 'completed')
        action('保存文件', async () => {
          await downloadFile(job.download_id!)
          say('已发起浏览器保存：' + leaf(job.path))
        })
      if (job.status === 'conflict')
        action('处理冲突', () => resolveConflict(job))
      if (['queued', 'running', 'conflict'].includes(job.status))
        action('取消', async () => {
          await extraApi('/file-manager/jobs/' + job.id + '/cancel', {})
          await refreshJobs()
        })
      if (job.status === 'failed' || job.status === 'cancelled')
        action('重试', () => retry(job))
      row.append(actions)
      queue.append(row)
    }
    for (const job of legacy
      .filter((job) => !children.has(job.id))
      .slice(0, 10)) {
      const row = el('div', undefined, 'fm-job')
      row.append(
        el('strong', `${names[job.kind]} · ${names[job.status]}`),
        el('small', job.remote_path ?? job.local_path),
      )
      if (job.kind === 'pull' && job.status === 'completed') {
        const save = el('button', '保存文件')
        save.onclick = () =>
          run(async () => {
            await downloadFile(job.id)
          })
        row.append(save)
      }
      if (job.status === 'running') {
        const cancel = el('button', '取消')
        cancel.onclick = () =>
          run(async () => {
            await extraApi('/file-jobs/' + job.id, {})
            await refreshJobs()
          })
        row.append(cancel)
      }
      queue.append(row)
    }
    if (recordings.length) {
      const group = el('details'),
        summary = el('summary', '录制文件 · ' + recordings.length)
      group.append(summary)
      for (const record of recordings.slice(0, 20)) {
        const row = el('div', undefined, 'fm-job')
        row.append(
          el(
            'small',
            dateText(record.started_at) +
              ' · ' +
              bytes(record.bytes) +
              ' · ' +
              (record.duration_ms / 1000).toFixed(1) +
              ' 秒',
          ),
        )
        if (record.status === 'saved') {
          const save = el('button', '保存录像')
          save.onclick = () =>
            run(async () => {
              await downloadFile(record.id)
            })
          row.append(save)
        }
        group.append(row)
      }
      queue.append(group)
    }
    if (!queue.childElementCount)
      queue.append(el('p', '还没有文件作业。', 'fm-note'))
    const active =
      jobs.filter((job) =>
        ['queued', 'running', 'conflict'].includes(job.status),
      ).length +
      local.filter((upload) => ['queued', 'uploading'].includes(upload.status))
        .length
    button('queue').querySelector('span')!.textContent =
      '传输与作业' + (active ? ' · ' + active : '')
  }
  async function refreshJobs() {
    if (polling || disposed) return
    polling = true
    try {
      const result = await extraApi<{
        jobs: ManagerJob[]
        transfers: FileJob[]
        recordings: typeof recordings
      }>('/file-manager/jobs')
      resetNotice(root, 'file-jobs')
      if (disposed) return
      jobs = result.jobs
      legacy = result.transfers
      recordings = result.recordings
      let changed = false
      for (const job of jobs)
        if (
          !['queued', 'running', 'conflict'].includes(job.status) &&
          !seenTerminal.has(job.id)
        ) {
          seenTerminal.add(job.id)
          if (job.serial === serial) changed = true
          if (
            job.operation === 'pull' &&
            job.status === 'completed' &&
            job.download_id &&
            autoDownloads.has(job.id) &&
            !autoSaved.has(job.id)
          ) {
            autoSaved.add(job.id)
            run(async () => {
              await downloadFile(job.download_id!)
              say('已发起浏览器保存：' + leaf(job.path))
            })
          }
        }
      renderJobs()
      if (changed && visible && loaded && !loading && pathInput.hidden)
        run(() => browse(path, false))
    } catch (error) {
      if (visible) notify(root, error, 'error', 'file-jobs')
    } finally {
      polling = false
    }
  }
  const pause = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      signal.throwIfAborted()
      const timer = setTimeout(() => {
          signal.removeEventListener('abort', abort)
          resolve()
        }, ms),
        abort = () => {
          clearTimeout(timer)
          reject(signal.reason)
        }
      signal.addEventListener('abort', abort, { once: true })
    })
  async function uploadQueue() {
    if (uploading || disposed) return
    uploading = true
    try {
      for (;;) {
        const upload = uploads.find((upload) => upload.status === 'queued')
        if (!upload || disposed) break
        let staged: string | undefined
        try {
          upload.status = 'uploading'
          renderJobs()
          const cached = await uploadFile(
            upload.file,
            upload.abort.signal,
            (loaded, total) => {
              upload.percent = Math.floor((loaded / total) * 100)
              renderJobs()
            },
          )
          staged = cached.id
          upload.abort.signal.throwIfAborted()
          const job = await enqueue({
            operation: 'push',
            serial: upload.serial,
            path: upload.path,
            upload_id: staged,
          })
          staged = undefined
          upload.job_id = job.id
          upload.status = 'accepted'
          renderJobs()
          for (;;) {
            upload.abort.signal.throwIfAborted()
            const current = await extraApi<ManagerJob>(
              '/file-manager/jobs/' + job.id,
              undefined,
              upload.abort.signal,
            )
            if (!['queued', 'running'].includes(current.status)) break
            await refreshJobs()
            await pause(650, upload.abort.signal)
          }
          await refreshJobs()
        } catch (error) {
          if (upload.job_id)
            await extraApi(
              '/file-manager/jobs/' + upload.job_id + '/cancel',
              {},
            ).catch(() => {})
          upload.status = upload.abort.signal.aborted ? 'cancelled' : 'failed'
          upload.error = (error as Error).message
          renderJobs()
        } finally {
          if (staged)
            await extraApi('/file-manager/discard-upload/' + staged, {}).catch(
              () => {},
            )
        }
      }
    } finally {
      uploading = false
    }
  }
  function addUploads(files: File[], target = { serial, path }, exact = false) {
    if (!target.serial || (!loaded && !exact)) {
      say('请先进入可读取的手机目录', true)
      return
    }
    if (
      files.length +
        uploads.filter((upload) =>
          ['queued', 'uploading'].includes(upload.status),
        ).length >
      100
    ) {
      say('每批最多上传 100 个文件', true)
      return
    }
    for (const file of files) {
      if (file.size > 2 * 1024 ** 3) {
        say(file.name + ' 超过 2 GiB 上限', true)
        continue
      }
      try {
        uploads.push({
          id: crypto.randomUUID(),
          file,
          serial: target.serial,
          path: exact ? target.path : childPath(target.path, file.name),
          status: 'queued',
          abort: new AbortController(),
        })
      } catch (error) {
        say(file.name + '：' + (error as Error).message, true)
      }
    }
    setQueue(true)
    renderJobs()
    run(uploadQueue)
  }
  all.onchange = () => {
    selected.clear()
    if (all.checked) for (const entry of entries) selected.add(entry.path)
    renderRows()
  }
  button('upload').onclick = () => {
    retryTarget = undefined
    pick.click()
  }
  pick.onchange = () => {
    const files = Array.from(pick.files ?? [])
    if (retryTarget) {
      const target = retryTarget
      retryTarget = undefined
      if (files.length !== 1) {
        say('重试上传请选择一个文件', true)
      } else addUploads(files, target, true)
    } else addUploads(files)
    pick.value = ''
  }
  button('mkdir').onclick = () => run(() => operation('mkdir'))
  button('download').onclick = () => run(() => operation('download'))
  button('more').onclick = () => {
    const rect = button('more').getBoundingClientRect()
    showMenu(rect.left, rect.bottom)
  }
  button('queue').onclick = () => {
    setQueue(Boolean(queue.hidden))
    run(refreshJobs)
  }
  button('path').onclick = () => {
    pathInput.hidden = !pathInput.hidden
    get('.fm-breadcrumbs').hidden = !pathInput.hidden
    if (!pathInput.hidden) {
      pathInput.value = path
      pathInput.focus()
      pathInput.select()
    }
  }
  pathInput.onkeydown = (event) => {
    if (event.key === 'Enter') {
      pathInput.hidden = true
      get('.fm-breadcrumbs').hidden = false
      run(() => browse(pathInput.value))
    }
    if (event.key === 'Escape') {
      pathInput.hidden = true
      get('.fm-breadcrumbs').hidden = false
    }
  }
  button('back').onclick = () => {
    const h = history()
    if (h.index > 0) {
      h.index--
      run(() => browse(h.paths[h.index]!, false))
    }
  }
  button('forward').onclick = () => {
    const h = history()
    if (h.index < h.paths.length - 1) {
      h.index++
      run(() => browse(h.paths[h.index]!, false))
    }
  }
  button('up').onclick = () => run(() => browse(parentPath(path)))
  button('refresh').onclick = () =>
    run(async () => {
      await refreshDevices()
      await browse(path, false)
    })
  button('load-more').onclick = () => {
    if (page?.next_offset !== null && page?.next_offset !== undefined)
      run(() => browse(path, false, page!.next_offset!))
  }
  sort.onchange = hidden.onchange = () => run(() => browse(path, false))
  button('descending').onclick = () => {
    descending = !descending
    button('descending').textContent = descending ? '↓' : '↑'
    run(() => browse(path, false))
  }
  filter.oninput = () => {
    clearTimeout(filterTimer)
    filterTimer = setTimeout(() => run(() => browse(path, false)), 220)
  }
  device.onchange = () =>
    run(async () => {
      dialogs.dispose()
      request?.abort()
      const ownSerial = device.value
      serial = ownSerial
      revision++
      loaded = false
      entries = []
      selected.clear()
      filter.value = ''
      renderRows()
      const saved = await extraApi<{
          places: Record<
            string,
            { path: string; sort: string; descending: boolean; hidden: boolean }
          >
        }>('/file-manager/places'),
        place = saved.places[ownSerial]
      if (serial !== ownSerial || disposed) return
      sort.value = place?.sort ?? 'name'
      descending = place?.descending ?? false
      hidden.checked = place?.hidden ?? false
      button('descending').textContent = descending ? '↓' : '↑'
      await browse(place?.path ?? '/sdcard/Download')
    })
  const shortcuts = get<HTMLSelectElement>('.fm-quickselect')
  for (const [label, target] of quick) {
    shortcuts.append(new Option(label, target))
    const node = el('button', label)
    node.dataset.path = target
    node.onclick = () => run(() => browse(target))
    get('.fm-sidebar').append(node)
  }
  shortcuts.onchange = () => run(() => browse(shortcuts.value))
  shortcuts.value = '/sdcard/Download'
  const dismiss = (event: Event) => {
    if (!context.contains(event.target as Node)) context.hidden = true
  }
  document.addEventListener('pointerdown', dismiss)
  const escape = (event: KeyboardEvent) => {
    if (event.key === 'Escape') context.hidden = true
  }
  document.addEventListener('keydown', escape)
  const frame = get<HTMLElement>('.fm'),
    drop = get<HTMLElement>('.fm-drop')
  let dragDepth = 0
  frame.ondragenter = (event) => {
    if (event.dataTransfer?.types.includes('Files')) {
      event.preventDefault()
      dragDepth++
      drop.hidden = false
    }
  }
  frame.ondragover = (event) => {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
  }
  frame.ondragleave = () => {
    if (--dragDepth <= 0) {
      dragDepth = 0
      drop.hidden = true
    }
  }
  frame.ondrop = (event) => {
    event.preventDefault()
    dragDepth = 0
    drop.hidden = true
    const items = Array.from(event.dataTransfer?.items ?? [])
    if (items.some((item) => item.webkitGetAsEntry?.()?.isDirectory)) {
      say('第一版支持上传文件，请先选择文件夹内的文件。', true)
      return
    }
    addUploads(Array.from(event.dataTransfer?.files ?? []))
  }
  const unload = (event: BeforeUnloadEvent) => {
    if (
      uploads.some(
        (upload) => upload.status === 'queued' || upload.status === 'uploading',
      )
    ) {
      event.preventDefault()
      event.returnValue = ''
    }
  }
  window.addEventListener('beforeunload', unload)
  const timer = setInterval(() => {
    if (visible) run(refreshJobs)
  }, 1300)
  controls()
  emptyState('文件管理', '切换到本页后读取手机目录。')
  return {
    show(value: boolean) {
      visible = value
      if (!value) dialogs.dispose()
      if (value) {
        run(start)
        if (initialized && serial && !loading) run(() => browse(path, false))
        run(refreshJobs)
      }
    },
    dispose() {
      disposed = true
      revision++
      request?.abort()
      clearTimeout(filterTimer)
      clearInterval(timer)
      dialogs.dispose()
      for (const upload of uploads)
        if (upload.status === 'queued' || upload.status === 'uploading')
          upload.abort.abort(new Error('文件页面已关闭'))
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('beforeunload', unload)
    },
  }
}
