import { mkdir,readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicJson,dataDirectory } from './config.js'
export interface MediaSettings {maxSize:number;maxFps:number;videoBitRate:number;audio:boolean;audioSource:'output'|'playback'}
export const DEFAULT_MEDIA:MediaSettings={maxSize:1280,maxFps:30,videoBitRate:4_000_000,audio:false,audioSource:'output'}
export function mediaPatch(input:unknown):Partial<MediaSettings>{
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('画面参数格式无效');const value=input as Record<string,unknown>
  if(Object.keys(value).some(k=>!Object.hasOwn(DEFAULT_MEDIA,k)))throw new Error('未知画面参数')
  for(const[key,min,max]of [['maxSize',256,4096],['maxFps',1,120],['videoBitRate',100_000,40_000_000]]as const){if(value[key]!==undefined&&(!Number.isInteger(value[key])||Number(value[key])<min||Number(value[key])>max))throw new Error(`${key} 须为 ${min}–${max}`)}
  if(value.audio!==undefined&&typeof value.audio!=='boolean')throw new Error('audio 须为布尔值')
  if(value.audioSource!==undefined&&!['output','playback'].includes(String(value.audioSource)))throw new Error('audioSource 须为 output 或 playback')
  return value as Partial<MediaSettings>
}
export class MediaStore{
  value={...DEFAULT_MEDIA};warning:string|null=null;readonly directory:string;private tail=Promise.resolve()
  constructor(directory?:string){this.directory=dataDirectory(directory)}
  async load(overrides:Partial<MediaSettings>={}){await mkdir(this.directory,{recursive:true});try{this.value={...DEFAULT_MEDIA,...mediaPatch(JSON.parse(await readFile(join(this.directory,'video-settings.json'),'utf8')))}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')this.warning='画面设置无法读取，已使用默认值'}this.value={...this.value,...mediaPatch(overrides)}}
  save(input:unknown){const patch=mediaPatch(input);const result=this.tail.then(async()=>{const value={...this.value,...patch};await atomicJson(join(this.directory,'video-settings.json'),value);this.value=value;this.warning=null;return{...value}});this.tail=result.then(()=>{},()=>{});return result}
}
