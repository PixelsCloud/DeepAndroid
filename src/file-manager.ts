import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicJson } from './config.js'
import { quoteAndroidArg } from './android-shell.js'
import type { FileService } from './files.js'
import { mutationPath, remotePath } from './remote-path.js'
import type { RemoteStat } from './remote-files.js'
import {
  type ManagerRequest,
  type ManagerJob,
  type DirectoryOptions,
  type FileEntry,
  operations,
  deviceSerial,
  fileName,
  childPath,
  parentPath,
  entryVersion,
  validateDirectory,
  directoryPage,
} from './file-manager-model.js'

const uuid = /^[a-f0-9-]{36}$/
type Place = {
  path: string
  sort: 'name' | 'size' | 'modified'
  descending: boolean
  hidden: boolean
}
export function managerRequest(value: Record<string, unknown>): ManagerRequest {
  if (
    Object.keys(value).some(
      (key) =>
        ![
          'operation',
          'serial',
          'path',
          'destination',
          'upload_id',
          'recursive',
          'expected_version',
        ].includes(key),
    )
  )
    throw new Error('文件操作包含未知参数')
  if (!operations.includes(value.operation as ManagerRequest['operation']))
    throw new Error('未知文件操作')
  const operation = value.operation as ManagerRequest['operation'],
    serial = deviceSerial(value.serial),
    path = remotePath(value.path)
  if (operation !== 'pull' && operation !== 'install') mutationPath(path)
  const needsDestination = ['copy', 'move', 'rename'].includes(operation)
  if (needsDestination !== (typeof value.destination === 'string'))
    throw new Error(
      '复制、移动和重命名须指定完整目标路径，其他操作不接受 destination',
    )
  const destination = needsDestination
    ? mutationPath(value.destination)
    : undefined
  if (destination === path) throw new Error('源和目标路径相同')
  if (operation === 'rename' && parentPath(path) !== parentPath(destination!))
    throw new Error('重命名须在同一目录中进行')
  if (
    operation === 'push'
      ? typeof value.upload_id !== 'string' || !uuid.test(value.upload_id)
      : value.upload_id !== undefined
  )
    throw new Error('上传须使用实际暂存标识，其他操作不接受 upload_id')
  if (
    (value.recursive !== undefined && typeof value.recursive !== 'boolean') ||
    (value.expected_version !== undefined &&
      (typeof value.expected_version !== 'string' ||
        value.expected_version.length > 256))
  )
    throw new Error('文件操作参数无效')
  return {
    operation,
    serial,
    path,
    ...(destination ? { destination } : {}),
    ...(operation === 'push' ? { upload_id: value.upload_id as string } : {}),
    ...(value.recursive !== undefined
      ? { recursive: value.recursive as boolean }
      : {}),
    ...(typeof value.expected_version === 'string'
      ? { expected_version: value.expected_version }
      : {}),
  }
}
function version(stat: RemoteStat) {
  return entryVersion(
    stat.type ?? 'special',
    stat.bytes ?? 0,
    stat.mtime_seconds ?? '0',
  )
}
export class FileManagerService {
  readonly directory: string
  private jobs = new Map<string, ManagerJob>()
  private active?: { id: string; abort: AbortController; done: Promise<void> }
  private worker?: Promise<void>
  private writes = Promise.resolve()
  private closed = false
  private accepting = 0
  private uploadClaims = new Set<string>()
  places: Record<string, Place> = {}
  lastSerial: string | null = null
  constructor(readonly files: FileService) {
    this.directory = join(files.directory, 'manager')
  }
  private persist(job: ManagerJob) {
    const snapshot = structuredClone(job)
    const work = this.writes.then(() =>
      atomicJson(join(this.directory, snapshot.id + '.json'), snapshot),
    )
    this.writes = work.then(
      () => {},
      () => {},
    )
    return work
  }
  async load() {
    await mkdir(this.directory, { recursive: true })
    const history: ManagerJob[] = [],
      interrupted: ManagerJob[] = []
    for (const name of (await readdir(this.directory)).filter((name) =>
      /^[a-f0-9-]{36}\.json$/.test(name),
    )) {
      try {
        const job = JSON.parse(
          await readFile(join(this.directory, name), 'utf8'),
        ) as ManagerJob
        if (
          job.id + '.json' !== name ||
          !operations.includes(job.operation) ||
          typeof job.serial !== 'string' ||
          typeof job.path !== 'string' ||
          typeof job.started_at !== 'string' ||
          !Number.isFinite(Date.parse(job.started_at))
        )
          continue
        if (['queued', 'running', 'conflict'].includes(job.status)) {
          job.outcome_uncertain = job.status === 'running'
          job.status = 'failed'
          job.phase = 'interrupted'
          job.finished_at = new Date().toISOString()
          job.error = '插件已重启，未自动重放操作；请核对手机实际文件后重试'
          await this.persist(job)
          interrupted.push(job)
        } else {
          history.push(job)
        }
      } catch {}
    }
    // UUID enumeration order has no relationship to task creation time.
    // Always recover outstanding work, even when it predates retained history.
    history.sort((a, b) => b.started_at.localeCompare(a.started_at))
    for (const job of [...history.slice(0, 1000), ...interrupted])
      this.jobs.set(job.id, job)
    try {
      const value = JSON.parse(
        await readFile(join(this.directory, 'places.json'), 'utf8'),
      )
      for (const [serial, place] of Object.entries(value.places ?? {}).slice(
        0,
        20,
      )) {
        deviceSerial(serial)
        const p = place as Place
        remotePath(p.path)
        validateDirectory(p)
        this.places[serial] = {
          path: p.path,
          sort: p.sort ?? 'name',
          descending: p.descending === true,
          hidden: p.hidden === true,
        }
      }
      if (typeof value.lastSerial === 'string')
        this.lastSerial = deviceSerial(value.lastSerial)
    } catch {}
  }
  async savePlace(input: Record<string, unknown>) {
    const serial = deviceSerial(input.serial),
      path = remotePath(input.path),
      sort = (input.sort ?? 'name') as Place['sort']
    validateDirectory({ sort })
    const work = this.writes.then(async () => {
      const next = {
        ...this.places,
        [serial]: {
          path,
          sort,
          descending: input.descending === true,
          hidden: input.hidden === true,
        },
      }
      while (Object.keys(next).length > 20) delete next[Object.keys(next)[0]!]
      const value = { places: next, lastSerial: serial }
      await atomicJson(join(this.directory, 'places.json'), value)
      this.places = next
      this.lastSerial = serial
      return value
    })
    this.writes = work.then(
      () => {},
      () => {},
    )
    return work
  }
  get(id: string) {
    const job = this.jobs.get(id)
    if (!job) return undefined
    const value = structuredClone(job),
      child = job.child_job_id ? this.files.get(job.child_job_id) : undefined
    if (job.status === 'running' && child) {
      if (child.status === 'running')
        value.phase = child.phase ?? 'transferring'
      value.bytes = child.bytes
      value.sha256 = child.sha256
    }
    return value
  }
  list() {
    const jobs = [...this.jobs.values()].sort((a, b) =>
      b.started_at.localeCompare(a.started_at),
    )
    const active = (job: ManagerJob) =>
      ['queued', 'running', 'conflict'].includes(job.status)
    return [
      ...jobs.filter(active),
      ...jobs.filter((job) => !active(job)).slice(0, 100),
    ].map((job) => this.get(job.id)!)
  }
  async listDirectory(
    serial: string,
    path: string,
    options: DirectoryOptions,
    signal: AbortSignal,
  ) {
    deviceSerial(serial)
    path = remotePath(path)
    validateDirectory(options)
    return this.files.remote.connected(serial, signal, async (adb) => {
      const info = await adb.sync.stat(path)
      if ((info.mode & 0xf000) !== 0x4000) throw new Error('目标不是目录')
      // Legacy ADB LIST can silently return DONE for a denied directory on some OEMs.
      const permission = await this.files.remote.device.runShell(
        serial,
        [
          'sh',
          '-c',
          `if [ -r ${quoteAndroidArg(path)} ] && [ -x ${quoteAndroidArg(path)} ]; then printf readable; else printf denied; fi`,
        ],
        signal,
      )
      if (permission.trim() !== 'readable')
        throw new Error('没有读取此目录的权限')
      const entries: FileEntry[] = []
      let truncated = false
      for await (const entry of adb.sync.opendir(path)) {
        signal.throwIfAborted()
        if (entry.name === '.' || entry.name === '..') continue
        if (entries.length >= 10000) {
          truncated = true
          break
        }
        if (entry.name.includes('/') || /[\x00-\x1f\x7f]/.test(entry.name))
          continue
        const type: FileEntry['type'] =
            (entry.mode & 0xf000) === 0x4000
              ? 'directory'
              : (entry.mode & 0xf000) === 0x8000
                ? 'file'
                : (entry.mode & 0xf000) === 0xa000
                  ? 'symlink'
                  : 'special',
          bytes =
            entry.size <= BigInt(Number.MAX_SAFE_INTEGER)
              ? Number(entry.size)
              : String(entry.size),
          seconds = String(entry.mtime),
          date = Number(entry.mtime) * 1000
        entries.push({
          name: entry.name,
          path: path.replace(/\/$/, '') + '/' + entry.name,
          type,
          bytes,
          mtime_seconds: seconds,
          modified_at: date <= 8.64e15 ? new Date(date).toISOString() : null,
          version: entryVersion(type, bytes, seconds),
        })
      }
      return directoryPage(serial, path, entries, truncated, options)
    })
  }
  async enqueue(input: Record<string, unknown>) {
    if (this.closed) throw new Error('文件管理器已关闭')
    const request = managerRequest(input)
    if (
      [...this.jobs.values()].filter((job) =>
        ['queued', 'running', 'conflict'].includes(job.status),
      ).length +
        this.accepting >=
      100
    )
      throw new Error('等待任务过多，请先处理队列')
    if (request.upload_id) {
      if (this.uploadClaims.has(request.upload_id))
        throw new Error('该上传文件已被任务使用')
      this.files.source(undefined, request.upload_id)
      this.uploadClaims.add(request.upload_id)
    }
    this.accepting++
    try {
      const job: ManagerJob = {
        ...request,
        id: randomUUID(),
        status: 'queued',
        phase: 'queued',
        started_at: new Date().toISOString(),
      }
      try {
        await this.persist(job)
      } catch (error) {
        if (request.upload_id) this.uploadClaims.delete(request.upload_id)
        throw error
      }
      this.jobs.set(job.id, job)
      this.pump()
      return this.get(job.id)!
    } finally {
      this.accepting--
    }
  }
  private pump() {
    if (this.worker || this.closed) return
    this.worker = this.run().finally(() => {
      this.worker = undefined
      if (
        !this.closed &&
        [...this.jobs.values()].some((job) => job.status === 'queued')
      )
        this.pump()
    })
    void this.worker.catch((error) =>
      console.error('[dsh-android] file manager:', String(error)),
    )
  }
  private async run() {
    for (;;) {
      if (this.closed) return
      const job = [...this.jobs.values()].find((job) => job.status === 'queued')
      if (!job) return
      const abort = new AbortController(),
        timer = setTimeout(
          () => abort.abort(new Error('文件作业超过 5 分钟')),
          300000,
        )
      let complete!: () => void
      let mutationStarted = false
      this.active = {
        id: job.id,
        abort,
        done: new Promise<void>((resolve) => {
          complete = resolve
        }),
      }
      job.status = 'running'
      job.phase = 'preparing'
      try {
        await this.persist(job)
        abort.signal.throwIfAborted()
        const source = await this.files.remote.stat(
          job.serial,
          job.path,
          false,
          abort.signal,
        )
        if (
          job.expected_version &&
          source.exists &&
          version(source) !== job.expected_version
        )
          throw new Error('文件在选择后已变化，请刷新目录后重新操作')
        const target = job.operation === 'push' ? job.path : job.destination
        if (target) {
          const existing =
            job.operation === 'push'
              ? source
              : await this.files.remote.stat(
                  job.serial,
                  target,
                  false,
                  abort.signal,
                )
          if (
            existing.exists &&
            (!job.overwrite || job.overwrite_version !== version(existing))
          ) {
            job.status = 'conflict'
            job.phase = 'conflict'
            job.conflict = {
              path: target,
              type: existing.type ?? 'special',
              bytes: existing.bytes,
              modified_at: existing.modified_at,
              version: version(existing),
            }
            continue
          }
        }
        const transfer = async (
          kind: 'push' | 'pull' | 'install',
          args: {
            local_path?: string
            upload_id?: string
            remote_path?: string
            overwrite?: boolean
            expected_destination_version?: string
          },
        ) => {
          abort.signal.throwIfAborted()
          if (kind !== 'pull') mutationStarted = true
          const task = await this.files.start(
            kind,
            job.serial,
            args,
            abort.signal,
          )
          job.child_job_id = task.id
          await this.persist(job)
          const result = await task.promise
          if (result.status !== 'completed')
            throw new Error(result.error ?? '文件传输未完成')
          job.bytes = result.bytes
          job.sha256 = result.sha256
          if (kind === 'pull') {
            job.phase = 'verifying'
            if (
              (await this.files.remote.hash(
                job.serial,
                job.path,
                abort.signal,
              )) !== result.sha256
            )
              throw new Error(
                '取回文件与手机当前文件哈希不同，请核对是否正在写入后重试',
              )
          }
          return result
        }
        if (job.operation === 'push')
          await transfer('push', {
            upload_id: job.upload_id,
            remote_path: job.path,
            overwrite: job.overwrite === true,
            expected_destination_version: job.overwrite_version,
          })
        else if (job.operation === 'pull') {
          const result = await transfer('pull', { remote_path: job.path })
          job.download_id = result.id
        } else if (job.operation === 'install') {
          if (!job.path.toLowerCase().endsWith('.apk'))
            throw new Error('请选择单个 APK 文件')
          const apk = await transfer('pull', { remote_path: job.path })
          job.phase = 'installing'
          await transfer('install', { local_path: apk.local_path })
        } else if (!(job.operation === 'delete' && !source.exists)) {
          job.phase = 'executing'
          mutationStarted = true
          await this.files.remote.manage(
            job.serial,
            {
              action: job.operation,
              path: job.path,
              destination: job.destination,
              recursive: job.recursive,
              overwrite: job.overwrite,
              expected_source_version: job.expected_version,
              expected_destination_version: job.overwrite_version,
            },
            abort.signal,
          )
        }
        abort.signal.throwIfAborted()
        job.status = 'completed'
        job.phase = 'finished'
      } catch (error) {
        job.status = abort.signal.aborted ? 'cancelled' : 'failed'
        job.outcome_uncertain = abort.signal.aborted || mutationStarted
        job.error = String((error as Error).message ?? error).slice(0, 1500)
      } finally {
        clearTimeout(timer)
        if (job.status !== 'conflict')
          job.finished_at = new Date().toISOString()
        await this.persist(job).catch((error) => {
          job.record_error = '记录保存失败：' + String(error)
        })
        if (job.upload_id && job.status !== 'conflict') {
          this.uploadClaims.delete(job.upload_id)
          await this.files.discardUpload(job.upload_id)
        }
        this.active = undefined
        complete()
      }
    }
  }
  async resolve(id: string, input: Record<string, unknown>) {
    if (this.active?.id === id) await this.active.done
    const job = this.jobs.get(id)
    if (!job || job.status !== 'conflict' || !job.conflict)
      throw new Error('该任务没有待处理的同名冲突')
    if (this.closed) throw new Error('文件管理器已关闭')
    if (input.choice === 'skip') {
      job.status = 'skipped'
      job.phase = 'finished'
      job.finished_at = new Date().toISOString()
      if (job.upload_id) {
        this.uploadClaims.delete(job.upload_id)
        await this.files.discardUpload(job.upload_id)
      }
    } else if (input.choice === 'overwrite') {
      if (job.conflict.type !== 'file')
        throw new Error('仅可覆盖普通文件，不合并或覆盖已有目录')
      job.overwrite = true
      job.overwrite_version = job.conflict.version
      job.status = 'queued'
      job.phase = 'queued'
    } else if (input.choice === 'rename') {
      const path = childPath(
        parentPath(job.conflict.path),
        fileName(input.name),
      )
      if (job.operation === 'push') job.path = path
      else job.destination = path
      job.overwrite = false
      delete job.overwrite_version
      job.status = 'queued'
      job.phase = 'queued'
    } else throw new Error('请选择跳过、改名或覆盖')
    delete job.conflict
    await this.persist(job)
    this.pump()
    return this.get(id)!
  }
  async cancel(id: string) {
    if (this.active?.id === id && this.jobs.get(id)?.status === 'conflict')
      await this.active.done
    const job = this.jobs.get(id)
    if (!job) throw new Error('文件作业不存在')
    if (!['queued', 'running', 'conflict'].includes(job.status))
      return { status: job.status, already_finished: true }
    if (this.active?.id === id) {
      this.active.abort.abort(new Error('用户取消文件操作'))
      job.phase = 'cancelling'
      return { status: 'cancelling', already_finished: false }
    }
    job.status = 'cancelled'
    job.phase = 'finished'
    job.finished_at = new Date().toISOString()
    job.outcome_uncertain = false
    if (job.upload_id) {
      this.uploadClaims.delete(job.upload_id)
      await this.files.discardUpload(job.upload_id)
    }
    await this.persist(job)
    return { status: 'cancelled', already_finished: false }
  }
  async retry(id: string, confirmUncertain: boolean) {
    const job = this.jobs.get(id)
    if (!job || !['failed', 'cancelled'].includes(job.status))
      throw new Error('只有失败或取消的作业可重试')
    if (job.operation === 'push')
      throw new Error('上传源文件已释放，请重新选择电脑文件')
    if (job.outcome_uncertain && !confirmUncertain)
      throw new Error('上次结果不确定，请核对实际源和目标后明确重试')
    return this.enqueue({
      operation: job.operation,
      serial: job.serial,
      path: job.path,
      ...(job.destination ? { destination: job.destination } : {}),
      recursive: job.recursive,
      ...(job.expected_version
        ? { expected_version: job.expected_version }
        : {}),
    })
  }
  async discardUpload(id: string) {
    if (!uuid.test(id)) throw new Error('暂存标识无效')
    if (this.uploadClaims.has(id)) return { discarded: false }
    await this.files.discardUpload(id)
    return { discarded: true }
  }
  async close() {
    this.closed = true
    this.active?.abort.abort(new Error('插件关闭'))
    for (const job of this.jobs.values())
      if (job.status === 'queued' || job.status === 'conflict')
        await this.cancel(job.id)
    await this.worker
    await this.writes
  }
}
