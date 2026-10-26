export type FileOperation =
  | 'push'
  | 'pull'
  | 'install'
  | 'mkdir'
  | 'copy'
  | 'move'
  | 'rename'
  | 'delete'
export type ManagerStatus =
  | 'queued'
  | 'running'
  | 'conflict'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped'
export interface FileEntry {
  name: string
  path: string
  type: 'file' | 'directory' | 'symlink' | 'special'
  bytes: number | string
  mtime_seconds: string
  modified_at: string | null
  version: string
}
export interface DirectoryOptions {
  offset?: number
  limit?: number
  sort?: 'name' | 'size' | 'modified'
  descending?: boolean
  hidden?: boolean
  filter?: string
}
export interface DirectoryPage {
  serial: string
  path: string
  entries: FileEntry[]
  offset: number
  next_offset: number | null
  matched_count: number
  read_count: number
  truncated: boolean
  snapshot: false
}
export interface ManagerRequest {
  operation: FileOperation
  serial: string
  path: string
  destination?: string
  upload_id?: string
  recursive?: boolean
  expected_version?: string
}
export interface ManagerJob extends ManagerRequest {
  id: string
  status: ManagerStatus
  phase: string
  started_at: string
  finished_at?: string
  child_job_id?: string
  download_id?: string
  bytes?: number
  sha256?: string
  error?: string
  record_error?: string
  outcome_uncertain?: boolean
  overwrite?: boolean
  overwrite_version?: string
  conflict?: {
    path: string
    type: string
    bytes?: number | string
    modified_at?: string | null
    version: string
  }
}
export const operations: FileOperation[] = [
  'push',
  'pull',
  'install',
  'mkdir',
  'copy',
  'move',
  'rename',
  'delete',
]
export function deviceSerial(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 128 ||
    /[\x00-\x20\x7f]/.test(value)
  )
    throw new Error('设备序列号无效')
  return value
}
export function fileName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    new TextEncoder().encode(value).length > 240 ||
    value === '.' ||
    value === '..' ||
    /[\/\x00-\x1f\x7f]/.test(value)
  )
    throw new Error('名称须为 1–240 字节，不能包含 /、控制字符、. 或 ..')
  return value
}
export function phonePath(value: string): string {
  if (
    !value.startsWith('/') ||
    value.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(value) ||
    value.split('/').includes('..')
  )
    throw new Error('请输入有效的手机绝对路径')
  return (
    '/' +
    value
      .split('/')
      .filter((part) => part && part !== '.')
      .join('/')
  )
}
export function parentPath(value: string) {
  const path = phonePath(value)
  return path.slice(0, path.lastIndexOf('/')) || '/'
}
export function childPath(parent: string, name: string) {
  return phonePath(parent).replace(/\/$/, '') + '/' + fileName(name)
}
export function entryVersion(
  type: string,
  size: number | string,
  mtime: string,
) {
  return `${type}:${size}:${mtime}`
}
export function validateDirectory(options: DirectoryOptions) {
  if (
    !Number.isInteger(options.offset ?? 0) ||
    (options.offset ?? 0) < 0 ||
    (options.offset ?? 0) > 10000 ||
    !Number.isInteger(options.limit ?? 200) ||
    (options.limit ?? 200) < 1 ||
    (options.limit ?? 200) > 500
  )
    throw new Error('目录分页参数无效')
  if (
    options.sort !== undefined &&
    !['name', 'size', 'modified'].includes(options.sort)
  )
    throw new Error('排序方式无效')
  if (
    options.filter !== undefined &&
    (options.filter.length > 256 || /[\x00-\x1f\x7f]/.test(options.filter))
  )
    throw new Error('筛选文字无效')
}
export function directoryPage(
  serial: string,
  path: string,
  entries: FileEntry[],
  truncated: boolean,
  options: DirectoryOptions,
): DirectoryPage {
  validateDirectory(options)
  const needle = (options.filter ?? '').toLocaleLowerCase(),
    matched = entries.filter(
      (entry) =>
        (options.hidden || !entry.name.startsWith('.')) &&
        (!needle || entry.name.toLocaleLowerCase().includes(needle)),
    )
  matched.sort((a, b) => {
    const directories =
      Number(b.type === 'directory') - Number(a.type === 'directory')
    if (directories) return directories
    let order = 0
    if (options.sort === 'size') {
      const left = BigInt(a.bytes),
        right = BigInt(b.bytes)
      order = left < right ? -1 : left > right ? 1 : 0
    } else if (options.sort === 'modified')
      order = Number(a.mtime_seconds) - Number(b.mtime_seconds)
    else order = a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
    return (
      (order || a.name.localeCompare(b.name)) * (options.descending ? -1 : 1)
    )
  })
  const offset = options.offset ?? 0,
    limit = options.limit ?? 200
  return {
    serial,
    path,
    entries: matched.slice(offset, offset + limit),
    offset,
    next_offset: offset + limit < matched.length ? offset + limit : null,
    matched_count: matched.length,
    read_count: entries.length,
    truncated,
    snapshot: false,
  }
}
