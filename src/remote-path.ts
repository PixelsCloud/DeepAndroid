import {posix} from 'node:path'
export function remotePath(value:unknown):string{
  if(typeof value!=='string'||!value.startsWith('/')||value.length>4096||/[\x00-\x1f\x7f]/.test(value)||value.split('/').includes('..'))throw new Error('手机路径须为绝对路径，不能包含 .. 或控制字符')
  const path=posix.normalize(value);return path==='/'?path:path.replace(/\/+$/,'')
}
export function mutationPath(value:unknown){
  const path=remotePath(value)
  if(path==='/'||/^\/(?:sdcard|mnt\/sdcard|storage(?:\/emulated(?:\/\d+)?|\/self(?:\/primary)?|\/[^/]+)?|data(?:\/local(?:\/tmp)?)?)$/.test(path))throw new Error('不能修改存储根目录或 ADB 临时根目录，请提供具体文件或子目录')
  return path
}
