import type {DeviceService} from './device.js'
import {remotePath} from './remote-path.js'
import {quoteAndroidArg as quote} from './android-shell.js'

export interface MediaQuery {kind?:'image'|'video'|'audio'|'all';name_contains?:string;directory?:string;modified_after?:string;limit?:number;cursor?:string}
const sql=(value:string)=>"'"+value.replaceAll("'","''")+"'"
const like=(value:string)=>value.replace(/[\\%_]/g,char=>'\\'+char)
const number=(value:string)=>value==='NULL'?null:BigInt(value)>BigInt(Number.MAX_SAFE_INTEGER)?value:Number(value)
const columns=['_id','_size','date_modified','date_added','media_type','width','height','duration']
const fields=['_display_name','_data','mime_type']
export function validateMediaQuery(input:MediaQuery){
 const kind=input.kind??'all',limit=input.limit??10
 if(!['image','video','audio','all'].includes(kind)||!Number.isInteger(limit)||limit<1||limit>20)throw new Error('媒体类型须为 image/video/audio/all，limit 须为 1–20')
 if(input.name_contains!==undefined&&(!input.name_contains.length||input.name_contains.length>256||/[\x00-\x1f\x7f]/.test(input.name_contains)))throw new Error('名称筛选须为 1–256 字普通文字')
 if(input.directory!==undefined)remotePath(input.directory)
 const after=input.modified_after===undefined?undefined:Date.parse(input.modified_after)
 if(after!==undefined&&(!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(input.modified_after!)||!Number.isFinite(after)||after<0))throw new Error('modified_after 须为有效的非负 ISO 时间')
 if(input.cursor!==undefined&&(!/^\d{1,19}:\d{1,19}$/.test(input.cursor)||input.cursor.split(':').some(value=>BigInt(value)>9223372036854775807n)))throw new Error('cursor 须使用上次媒体查询返回的实际游标')
 return{kind,limit,after}
}
export function parseMediaRows(text:string,limit:number){
 if(text.trim()==='No result found.')return[]
 const lines=text.trimEnd().split(/\r?\n/)
 if(!lines.length||lines.length>limit||!text.trim())throw new Error('媒体提供器没有返回可确认的查询结果')
 return lines.map((line,index)=>{
  const prefix=`Row: ${index} `;if(!line.startsWith(prefix))throw new Error('媒体查询失败或返回格式不支持：'+line.slice(0,300))
  const values=line.slice(prefix.length).split(', ');if(values.length!==columns.length)throw new Error('媒体元数据列数不符，未猜测字段')
  const result:Record<string,string>={};for(let n=0;n<columns.length;n++){const match=values[n]!.match(/^([a-z_]+)=(\d+|NULL)$/);if(!match||match[1]!==columns[n])throw new Error('媒体元数据无效，未猜测字段');result[columns[n]!]=match[2]!}
  if(result._id==='NULL'||result.date_modified==='NULL')throw new Error('媒体记录缺少 ID 或修改时间');return result
 })
}
/** Each string column is queried separately and base64 framed; file names cannot impersonate metadata delimiters. */
export function parseMediaStrings(text:string,ids:string[]){
 const lines=text.trimEnd().split(/\r?\n/),result=new Map<string,Record<string,string|null>>()
 if(lines.length!==ids.length*fields.length)throw new Error('媒体详情返回不完整，未猜测文件路径')
 let n=0;for(const id of ids){const row:Record<string,string|null>={};for(const field of fields){const prefix=id+':'+field+':',line=lines[n++]!;if(!line.startsWith(prefix)||!/^[A-Za-z0-9+/]*={0,2}$/.test(line.slice(prefix.length)))throw new Error('媒体详情边界无效');const value=Buffer.from(line.slice(prefix.length),'base64').toString('utf8'),header='Row: 0 '+field+'=';if(value.trim()==='No result found.'){row[field]=null;continue}if(!value.startsWith(header)||!value.endsWith('\n'))throw new Error('媒体详情查询失败：'+value.slice(0,300));const raw=value.slice(header.length).replace(/\r?\n$/,'');row[field]=raw==='NULL'?null:raw}result.set(id,row)}return result
}
export async function queryMedia(device:DeviceService,serial:string,input:MediaQuery,signal:AbortSignal){
 const{kind,limit,after}=validateMediaQuery(input),shell=(args:string[],timeout=15000)=>device.runShell(serial,args,signal,timeout),user=(await shell(['am','get-current-user'])).trim()
 if(!/^\d+$/.test(user))throw new Error('无法确定当前 Android 用户')
 const conditions=[kind==='all'?'media_type IN (1,2,3)':'media_type='+({image:1,audio:2,video:3}[kind]),'date_modified IS NOT NULL'];let directory:string|undefined
 if(input.name_contains!==undefined)conditions.push('_display_name LIKE '+sql('%'+like(input.name_contains)+'%')+" ESCAPE '\\'")
 if(after!==undefined)conditions.push('date_modified >= '+Math.ceil(after/1000))
 if(input.directory!==undefined){directory=remotePath((await shell(['readlink','-f','--',remotePath(input.directory)])).trim());const owner=directory.match(/^\/storage\/emulated\/(\d+)(?:\/|$)/)?.[1];if(!directory.startsWith('/storage/')||(owner!==undefined&&owner!==user))throw new Error('媒体目录须属于当前用户的共享存储');conditions.push('_data LIKE '+sql(like(directory.replace(/\/$/,'')+'/')+'%')+" ESCAPE '\\'")}
 if(input.cursor){const[modified,id]=input.cursor.split(':');conditions.push(`(date_modified < ${modified} OR (date_modified = ${modified} AND _id < ${id}))`)}
 const args=['content','query','--user',user,'--uri','content://media/external/file','--projection',columns.join(':'),'--where',conditions.join(' AND '),'--sort','date_modified DESC, _id DESC']
 // Android's content CLI has no portable limit argument. Bound its numeric-only output at the phone, including a lookahead row.
 const rows=parseMediaRows(await shell(['sh','-c',args.map(quote).join(' ')+` 2>&1 | head -n ${limit+1}`]),limit+1),hasMore=rows.length>limit,page=rows.slice(0,limit),ids=page.map(row=>row._id!)
 let strings=new Map<string,Record<string,string|null>>()
 if(ids.length){const commands=ids.flatMap(id=>fields.map(field=>{const query=['content','query','--user',user,'--uri','content://media/external/file/'+id,'--projection',field];return `printf ${quote(id+':'+field+':')}; ${query.map(quote).join(' ')} 2>&1 | base64 -w 0; printf '\\n'`}));strings=parseMediaStrings(await shell(['sh','-c',commands.join('; ')],90000),ids)}
 signal.throwIfAborted();if((await shell(['am','get-current-user'])).trim()!==user)throw new Error('Android 用户在媒体查询期间变化，未返回另一用户的数据')
 const items=page.map(row=>{const detail=strings.get(row._id!)!,path=detail._data;let pathError:string|null=null;try{if(path!==null)remotePath(path!)}catch{pathError='媒体路径包含不支持的字符，未提供给文件操作'}const modified=number(row.date_modified!),seconds=Number(row.date_modified),date=seconds*1000;return{id:row._id,content_uri:'content://media/external/file/'+row._id,name:detail._display_name,path:pathError?null:path,mime_type:detail.mime_type,kind:({1:'image',2:'audio',3:'video'}as Record<string,string>)[row.media_type!]??'unknown',bytes:number(row._size!),modified_seconds:modified,modified_at:date<=8.64e15?new Date(date).toISOString():null,added_seconds:number(row.date_added!),width:number(row.width!),height:number(row.height!),duration_ms:number(row.duration!),available:detail._display_name!==null&&path!==null&&!pathError,...(pathError?{error:pathError}:{})}})
 const last=page.at(-1);return{status:items.some(item=>!item.available)?'partial':'listed',serial,user_id:Number(user),source:'MediaStore',items,count:items.length,has_more:hasMore,next_cursor:hasMore&&last?last.date_modified+':'+last._id:null,directory:directory??null,snapshot:false,guidance:'媒体索引可能陈旧或缺失，路径和 bytes 不是文件当前存在的证明；需要时调用 android_file_stat。按修改时间和 ID 倒序，游标分页不是原子快照，保持相同筛选条件。名称按字面子串筛选（系统 LIKE 可忽略 ASCII 大小写）。不读取文件正文、不打开应用、不触发媒体扫描。'}
}
