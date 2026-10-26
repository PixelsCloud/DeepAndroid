import {posix} from 'node:path'
import {randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import type {Adb} from '@yume-chan/adb'
import type {DeviceService} from './device.js'
import {remotePath,mutationPath} from './remote-path.js'
import {quoteAndroidArg as quote} from './android-shell.js'

const MAX_BYTES=2*1024**3,MAX_ENTRIES=1000
export interface RemoteStat{status:'found'|'not_found';exists:boolean;serial:string;path:string;type?:'file'|'directory'|'symlink'|'special';bytes?:number|string;mtime_seconds?:string;modified_at?:string|null;fingerprint?:string;mode?:string;sha256?:string}
export interface ManageFileOptions{action:'mkdir'|'copy'|'move'|'rename'|'delete';path:string;destination?:string;recursive?:boolean;overwrite?:boolean}
export interface WaitFileOptions{path:string;timeout_ms?:number;stable_ms?:number;poll_ms?:number;min_bytes?:number;different_from?:string;modified_after?:string}
export function missingFile(error:unknown){return /^(?:ENOENT|No such file or directory)$/i.test(String((error as Error)?.message??error))}
function safeNumber(value:bigint){return value<=BigInt(Number.MAX_SAFE_INTEGER)?Number(value):String(value)}
function timestamp(seconds:bigint){const value=Number(seconds)*1000;return Number.isFinite(value)&&Math.abs(value)<=8.64e15?new Date(value).toISOString():null}

/** Uses only this plugin's ADB transport and normal shell permissions. No root, glob expansion or recursive symlink following. */
export class RemoteFiles{
  private tails=new Map<string,Promise<unknown>>()
  private shutdown=new AbortController()
  constructor(readonly device:DeviceService){}
  private shell(serial:string,args:string[],signal:AbortSignal,timeout=10000){return this.device.runShell(serial,args,AbortSignal.any([signal,this.shutdown.signal]),timeout)}
  async connected<T>(serial:string,signal:AbortSignal,work:(adb:Adb)=>Promise<T>){
    signal=AbortSignal.any([signal,this.shutdown.signal])
    signal.throwIfAborted();const adb=await this.device.client.createAdb({serial}),abort=()=>void adb.close();signal.addEventListener('abort',abort,{once:true})
    try{signal.throwIfAborted();return await work(adb)}finally{signal.removeEventListener('abort',abort);await adb.close()}
  }
  async stat(serial:string,value:string,includeHash:boolean,signal:AbortSignal):Promise<RemoteStat>{
    const path=remotePath(value)
    return this.connected(serial,signal,async adb=>{
      let info;try{info=await adb.sync.lstat(path)}catch(error){signal.throwIfAborted();if(missingFile(error))return{status:'not_found',exists:false,serial,path};throw error}
      const type=(info.mode&0xf000)===0x8000?'file':(info.mode&0xf000)===0x4000?'directory':(info.mode&0xf000)===0xa000?'symlink':'special'
      const result:RemoteStat={status:'found',exists:true,serial,path,type,bytes:safeNumber(info.size),mtime_seconds:String(info.mtime),modified_at:timestamp(info.mtime),fingerprint:[info.size,info.mtime,info.ctime??'',('ino'in info?info.ino:'')??''].join(':'),mode:(info.mode&0o7777).toString(8)}
      if(includeHash){if(type!=='file'||info.size>BigInt(MAX_BYTES))throw new Error('哈希仅支持不超过 2 GiB 的普通文件');result.sha256=await this.hash(serial,path,signal);const after=await adb.sync.lstat(path);if(after.size!==info.size||after.mtime!==info.mtime||after.ctime!==info.ctime)throw new Error('文件在计算哈希期间变化，请等待稳定后重新查询')}
      signal.throwIfAborted();return result
    })
  }
  async hash(serial:string,path:string,signal:AbortSignal){const text=await this.shell(serial,['sha256sum','--',remotePath(path)],signal,120000),hash=text.match(/^([a-f0-9]{64})\b/i)?.[1];if(!hash)throw new Error('手机未返回有效的 SHA-256');return hash.toLowerCase()}
  private async canonical(serial:string,path:string,signal:AbortSignal){const text=(await this.shell(serial,['readlink','-f','--',path],signal)).trim();if(!text.startsWith('/')||/[\r\n\0]/.test(text))throw new Error('无法确定手机真实路径');return remotePath(text)}
  private async target(serial:string,value:string,parents:boolean,signal:AbortSignal){
    const path=mutationPath(value),parts=[posix.basename(path)];let parent=posix.dirname(path)
    for(let i=0;i<64;i++){
      const info=await this.stat(serial,parent,false,signal)
      if(info.exists){const real=await this.canonical(serial,parent,signal),target=mutationPath(posix.join(real,...parts));if(!target.startsWith('/storage/')&&!target.startsWith('/data/local/tmp/'))throw new Error('修改仅支持共享存储或 /data/local/tmp 下的具体路径');return target}
      if(!parents)throw new Error('目标父目录不存在，请先创建目录')
      parts.unshift(posix.basename(parent));parent=posix.dirname(parent)
    }
    throw new Error('路径层级超过 64')
  }
  async exclusive<T>(serial:string,signal:AbortSignal,work:()=>Promise<T>){const previous=this.tails.get(serial)??Promise.resolve(),operation=previous.catch(()=>{}).then(()=>{signal.throwIfAborted();return work()});this.tails.set(serial,operation);try{return await operation}finally{if(this.tails.get(serial)===operation)this.tails.delete(serial)}}
  private async inspectTree(serial:string,path:string,allowLinks:boolean,signal:AbortSignal){
    return this.connected(serial,signal,async adb=>{
      let entries=0,bytes=0n
      const walk=async(current:string,depth:number)=>{signal.throwIfAborted();if(depth>32||++entries>MAX_ENTRIES)throw new Error('目录操作最多 1000 项、32 层');const info=await adb.sync.lstat(current),type=info.mode&0xf000;if(type===0xa000){if(!allowLinks)throw new Error('复制目录包含符号链接，请明确选择普通源文件');return}if(type===0x8000){bytes+=info.size;if(bytes>BigInt(MAX_BYTES))throw new Error('目录操作累计文件大小超过 2 GiB');return}if(type!==0x4000)throw new Error('仅支持普通文件、目录或删除符号链接');for(const entry of await adb.sync.readdir(current))if(entry.name!=='.'&&entry.name!=='..'){if(/[\/\0]/.test(entry.name))throw new Error('目录包含无效名称');await walk(posix.join(current,entry.name),depth+1)}}
      await walk(path,0);return{entries,bytes:Number(bytes)}
    })
  }
  async manage(serial:string,input:ManageFileOptions,signal:AbortSignal){
    if(!['mkdir','copy','move','rename','delete'].includes(input.action))throw new Error('未知文件操作')
    mutationPath(input.path);if(input.destination!==undefined)mutationPath(input.destination)
    if(['copy','move','rename'].includes(input.action)!==(input.destination!==undefined))throw new Error('复制、移动、重命名需要 destination，其他操作不接受 destination')
    if(input.overwrite&& !['copy','move','rename'].includes(input.action))throw new Error('overwrite 仅适用于复制、移动和重命名')
    return this.exclusive(serial,signal,async()=>{
      const path=await this.target(serial,input.path,input.action==='mkdir'&&input.recursive===true,signal),source=await this.stat(serial,path,false,signal)
      if(input.action==='mkdir'){if(source.exists){if(source.type!=='directory')throw new Error('该路径已存在且不是目录');return{status:'unchanged',serial,path,action:input.action}}await this.shell(serial,['mkdir',...(input.recursive?['-p']:[]),'--',path],signal);return{status:'completed',serial,path,action:input.action,result:await this.stat(serial,path,false,signal)}}
      if(!source.exists)throw new Error('源文件或目录不存在')
      if(input.action==='delete'){
        if(source.type==='directory'&&input.recursive)await this.inspectTree(serial,path,true,signal)
        await this.shell(serial,source.type==='directory'?(input.recursive?['rm','-rf','--',path]:['rmdir','--',path]):['rm','-f','--',path],signal,120000)
        if((await this.stat(serial,path,false,signal)).exists)throw new Error('删除结果未确认，目标仍存在')
        return{status:'completed',serial,path,action:input.action,recursive:input.recursive===true}
      }
      const destination=await this.target(serial,input.destination!,false,signal)
      if(path===destination)throw new Error('源路径和目标路径相同')
      if(input.action==='rename'&&posix.dirname(path)!==posix.dirname(destination))throw new Error('rename 只改变同一目录中的名称，跨目录请用 move')
      if(source.type==='directory'&&destination.startsWith(path+'/'))throw new Error('不能把目录放入自身内部')
      const existing=await this.stat(serial,destination,false,signal)
      if(existing.exists&&!input.overwrite)throw new Error('目标已存在，需要明确 overwrite=true 才可覆盖')
      if(existing.type==='directory')throw new Error('不覆盖已有目录；请指定一个不存在的完整目标路径')
      if(existing.exists&&existing.type!==source.type)throw new Error('源和已有目标的文件类型不同，未覆盖')
      if(source.type==='special')throw new Error('不操作特殊文件')
      if(source.type==='file'&&BigInt(source.bytes??0)>BigInt(MAX_BYTES))throw new Error('单个复制或移动文件最大 2 GiB')
      if(input.action==='copy'){
        if(source.type==='symlink')throw new Error('复制不跟随符号链接，请指定普通源文件')
        if(source.type==='directory'&&!input.recursive)throw new Error('复制目录需要 recursive=true')
        await this.inspectTree(serial,path,false,signal)
        const temporary=posix.join(posix.dirname(destination),'.dsh-copy-'+randomUUID()+'.part')
        try{
          await this.shell(serial,['cp',...(source.type==='directory'?['-R']:[]),'--',path,temporary],signal,120000)
          let hash:string|undefined
          if(source.type==='file'){hash=await this.hash(serial,path,signal);if(await this.hash(serial,temporary,signal)!==hash)throw new Error('复制哈希不一致，源文件可能正在变化')}
          await this.commit(serial,temporary,destination,input.overwrite===true,signal)
          return{status:'completed',serial,path,destination,action:input.action,result:{...await this.stat(serial,destination,false,signal),...(hash?{sha256:hash}:{})}}
        }finally{await this.device.runShell(serial,['rm','-rf','--',temporary],AbortSignal.timeout(5000)).catch(()=>{})}
      }
      if(source.type==='directory')await this.inspectTree(serial,path,true,signal)
      await this.commit(serial,path,destination,input.overwrite===true,signal)
      return{status:'completed',serial,path,destination,action:input.action,result:await this.stat(serial,destination,false,signal),guidance:'跨文件系统移动不保证原子性；发生取消或错误后请查询源和目标，再决定是否重试。'}
    })
  }
  private async commit(serial:string,source:string,destination:string,overwrite:boolean,signal:AbortSignal){
    const command=`mv ${overwrite?'-f':'-n'} -T -- ${quote(source)} ${quote(destination)}; status=$?; if [ "$status" -ne 0 ]; then exit "$status"; fi; if [ -e ${quote(source)} ] || [ -L ${quote(source)} ]; then echo '目标已存在或移动没有完成' >&2; exit 43; fi`
    await this.shell(serial,['sh','-c',command],signal,120000)
  }
  publishTransfer(serial:string,source:string,destination:string,overwrite:boolean,signal:AbortSignal){return this.exclusive(serial,signal,()=>this.commit(serial,source,destination,overwrite,signal))}
  async close(){this.shutdown.abort(new Error('文件服务已关闭'));await Promise.allSettled(this.tails.values())}
  async wait(serial:string,input:WaitFileOptions,signal:AbortSignal){
    const path=remotePath(input.path),timeout=input.timeout_ms??30000,stable=input.stable_ms??1500,poll=input.poll_ms??500,min=input.min_bytes??1
    if(!Number.isInteger(timeout)||timeout<500||timeout>120000||!Number.isInteger(stable)||stable<500||stable>10000||stable>timeout||!Number.isInteger(poll)||poll<250||poll>2000||!Number.isSafeInteger(min)||min<0)throw new Error('等待须为 500–120000 ms，稳定期 500–10000 ms，轮询 250–2000 ms，min_bytes 须为非负整数')
    if(input.different_from!==undefined&&(typeof input.different_from!=='string'||input.different_from.length>256))throw new Error('different_from 须为实际文件指纹')
    const after=input.modified_after!==undefined?Date.parse(input.modified_after):undefined;if(after!==undefined&&!Number.isFinite(after))throw new Error('modified_after 须为 ISO 时间')
    const start=Date.now(),deadline=AbortSignal.any([signal,AbortSignal.timeout(timeout)]);let fingerprint:string|undefined,stableSince=0,last:RemoteStat|null=null,attempts=0
    try{for(;;){deadline.throwIfAborted();last=await this.stat(serial,path,false,deadline);attempts++;const eligible=last.type==='file'&&BigInt(last.bytes??0)>=BigInt(min)&&last.fingerprint!==input.different_from&&(after===undefined||Number(last.mtime_seconds)*1000>=Math.floor(after/1000)*1000);if(eligible){if(last.fingerprint!==fingerprint){fingerprint=last.fingerprint;stableSince=Date.now()}if(Date.now()-stableSince>=stable)return{status:'stable',serial,path,file:last,attempts,elapsed_ms:Date.now()-start,stable_for_ms:Date.now()-stableSince,completion_guaranteed:false,guidance:'文件大小与修改时间在稳定期内未变，不保证生产应用已关闭文件。可能仍在暂停写入；请结合应用或传输任务状态验证。默认可匹配已有文件；需要新产物时提供原先 stat 的 different_from。'}}else{fingerprint=undefined;stableSince=0}await delay(poll,undefined,{signal:deadline})}}
    catch(error){signal.throwIfAborted();if(!deadline.aborted)throw error;return{status:'timed_out',serial,path,last_stat:last,attempts,elapsed_ms:Date.now()-start,completion_guaranteed:false}}
  }
  async prepareFile(serial:string,value:string,mime:string|undefined,signal:AbortSignal){
    const path=remotePath(value),file=await this.stat(serial,path,false,signal)
    if(!file.exists||file.type!=='file')throw new Error('打开或分享需要实际存在的普通文件')
    const canonical=await this.canonical(serial,path,signal)
    if(!canonical.startsWith('/storage/'))throw new Error('该路径不是系统媒体提供器可分享的共享文件；可先复制到 /sdcard/Download')
    if(mime!==undefined&&!/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(mime))throw new Error('MIME 类型无效')
    const user=(await this.shell(serial,['am','get-current-user'],signal)).trim();if(!/^\d+$/.test(user))throw new Error('无法确定共享文件的 Android 用户')
    const owner=canonical.match(/^\/storage\/emulated\/(\d+)\//)?.[1];if(owner!==undefined&&owner!==user)throw new Error('文件属于另一 Android 用户，未打开或共享')
    const scanUri='file://'+canonical.split('/').map(part=>encodeURIComponent(part)).join('/')
    await this.shell(serial,['am','broadcast','--user',user,'-a','android.intent.action.MEDIA_SCANNER_SCAN_FILE','-d',scanUri],signal)
    for(let i=0;i<12;i++){
      const output=await this.shell(serial,['content','query','--user',user,'--uri','content://media/external/file','--projection','_id:_size:mime_type','--where',"_data='"+canonical.replaceAll("'","''")+"'"],signal)
      const rows=output.split('\n').filter(line=>/^Row:/.test(line)),row=rows.length===1?rows[0]:undefined,id=row?.match(/\b_id=(\d+)\b/)?.[1],size=row?.match(/\b_size=(\d+)\b/)?.[1],type=row?.match(/\bmime_type=([\w.+-]+\/[\w.+-]+)/)?.[1]
      if(id&&size===String(file.bytes)){return{path,canonical_path:canonical,user_id:Number(user),content_uri:'content://media/external/file/'+id,mime_type:mime??type??'application/octet-stream',mime_source:mime?'explicit':type?'media_store':'fallback',bytes:file.bytes}}
      await delay(200,undefined,{signal})
    }
    throw new Error('媒体提供器未返回该文件，无法取得正常的只读共享 URI；不使用裸 file:// 作为替代')
  }
}
