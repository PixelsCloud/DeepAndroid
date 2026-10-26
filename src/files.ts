import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createReadStream,createWriteStream } from 'node:fs'
import { mkdir,readFile,stat,rename,link,unlink,readdir } from 'node:fs/promises'
import { resolve,join,basename,isAbsolute,extname } from 'node:path'
import { randomUUID,createHash } from 'node:crypto'
import { Transform,type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { DeviceService } from './device.js'
import { atomicJson,dataDirectory } from './config.js'
import {quoteAndroidArg as shellArg} from './android-shell.js'
import {RemoteFiles} from './remote-files.js'
import {remotePath} from './remote-path.js'
export {remotePath} from './remote-path.js'
export {quoteAndroidArg as shellArg} from './android-shell.js'

const run=promisify(execFile),MAX_BYTES=2*1024**3
export interface FileJob {id:string;kind:'push'|'pull'|'install';serial:string;status:'running'|'completed'|'failed'|'cancelled';started_at:string;finished_at?:string;local_path:string;remote_path?:string;bytes?:number;sha256?:string;error?:string;output?:string;phase?:string;background?:boolean;cancel_requested?:boolean;outcome_uncertain?:boolean}
export class FileService{
  readonly directory:string
  readonly remote:RemoteFiles
  private jobs=new Map<string,FileJob>()
  private active=new Map<string,AbortController>()
  private pending=new Set<Promise<FileJob>>()
  private uploads=new Map<string,{path:string;name:string;bytes:number}>()
  private uploadAborts=new Set<AbortController>()
  private uploadPending=new Set<Promise<void>>()
  private closed=false
  constructor(readonly device:DeviceService,directory?:string){this.directory=join(dataDirectory(directory),'files');this.remote=new RemoteFiles(device)}
  async load(){await mkdir(this.directory,{recursive:true});for(const file of await readdir(this.directory)){if(/^upload-[a-f0-9-]{36}(?:\..*)?$/.test(file)){const info=await stat(join(this.directory,file)).catch(()=>null);if(info&&Date.now()-info.mtimeMs>86400000)await unlink(join(this.directory,file)).catch(()=>{});continue}if(!/^[a-f0-9-]{36}\.json$/.test(file))continue;try{const job=JSON.parse(await readFile(join(this.directory,file),'utf8')) as FileJob;if(job.id+'.json'!==file||typeof job.started_at!=='string'||typeof job.local_path!=='string'||!['push','pull','install'].includes(job.kind)||!['running','completed','failed','cancelled'].includes(job.status))continue;if(job.status==='running'){job.status='failed';job.phase='interrupted';job.outcome_uncertain=true;job.error='插件已重启，之前的操作结果未知；请核对目标文件或已安装应用';job.finished_at=new Date().toISOString();await this.persist(job)}this.jobs.set(job.id,job)}catch{}}}
  private persist(job:FileJob){return atomicJson(join(this.directory,job.id+'.json'),job)}
  list(){return [...this.jobs.values()].sort((a,b)=>b.started_at.localeCompare(a.started_at)).slice(0,100).map(job=>({...job}))}
  get(id:string){const job=this.jobs.get(id);return job?{...job}:undefined}
  cancel(id:string){const job=this.jobs.get(id);if(!job)throw new Error('传输任务不存在，请使用实际 job_id');const current=this.active.get(id);if(!current)return{status:job.status,id,job_id:id,already_finished:true,guidance:'任务已经结束；取消不会撤销已完成的文件操作'};job.cancel_requested=true;current.abort(new Error('用户取消文件操作'));return{status:'cancelling',id,job_id:id,already_finished:false,guidance:'已请求取消，须查询任务实际状态；取消不保证目标不存在或安装未发生'}}
  async stage(source:Readable,name:string,signal:AbortSignal){
    if(this.closed)throw new Error('文件服务已关闭');if(this.uploadAborts.size>=3||this.uploads.size>=8)throw new Error('暂存文件过多，请等待传输结束或重新加载面板服务')
    const id=randomUUID(),clean=basename(name.replaceAll('\\','/'));if(!clean||clean.length>240||/[\0\r\n]/.test(clean))throw new Error('文件名无效')
    const path=join(this.directory,`upload-${id}${extname(clean)}`);let bytes=0
    const abort=new AbortController();this.uploadAborts.add(abort)
    const writing=pipeline(source,new Transform({transform(chunk,_encoding,done){bytes+=chunk.length;done(bytes>MAX_BYTES?new Error('文件超过 2 GiB 上限'):null,chunk)}}),createWriteStream(path,{flags:'wx'}),{signal:AbortSignal.any([signal,abort.signal])});this.uploadPending.add(writing)
    try{await writing;this.uploads.set(id,{path,name:clean,bytes});return{id,name:clean,bytes}}
    catch(error){await unlink(path).catch(()=>{});throw error}
    finally{this.uploadAborts.delete(abort);this.uploadPending.delete(writing)}
  }
  source(local?:string,upload?:string){if(upload){const staged=this.uploads.get(upload);if(!staged)throw new Error('暂存文件不存在或插件已重启，请重新选择文件');return staged.path}if(!local||!isAbsolute(local)||/[\0\r\n]/.test(local))throw new Error('电脑文件须为绝对路径');return resolve(local)}
  uploadName(id:string){return this.uploads.get(id)?.name}
  async listRemote(serial:string,path:string,signal:AbortSignal){
    path=remotePath(path);signal.throwIfAborted();const adb=await this.device.client.createAdb({serial});const abort=()=>void adb.close();signal.addEventListener('abort',abort,{once:true})
    try{signal.throwIfAborted();const entries=await adb.sync.readdir(path);return{serial,path,entries:entries.filter(e=>e.name!=='.'&&e.name!=='..').slice(0,1000).map(e=>({name:e.name,type:(e.mode&0xf000)===0x4000?'directory':(e.mode&0xf000)===0xa000?'symlink':'file',bytes:Number(e.size),modified_at:Number(e.mtime)})),truncated:entries.length>1000}}
    finally{signal.removeEventListener('abort',abort);await adb.close()}
  }
  async start(kind:FileJob['kind'],serial:string,args:{local_path?:string;upload_id?:string;remote_path?:string;overwrite?:boolean;background?:boolean},signal:AbortSignal){
    if(this.closed)throw new Error('文件服务已关闭')
    if(this.active.size>=3)throw new Error('最多同时执行 3 个文件操作')
    signal.throwIfAborted();const id=randomUUID(),abort=new AbortController(),combined=AbortSignal.any([...(args.background?[AbortSignal.timeout(300000)]:[signal]),abort.signal])
    const local=kind==='pull'?(args.local_path?this.source(args.local_path):join(this.directory,`download-${id}-${basename(remotePath(args.remote_path))}`)):this.source(args.local_path,args.upload_id)
    const remote=kind==='install'?undefined:remotePath(args.remote_path??('/sdcard/Download/'+(args.upload_id?this.uploadName(args.upload_id):basename(local))))
    if(kind!=='install'&&remote==='/')throw new Error('目标必须是文件路径，不能是根目录')
    const job:FileJob={id,kind,serial,status:'running',phase:'preparing',background:args.background===true,started_at:new Date().toISOString(),local_path:local,...(remote?{remote_path:remote}:{})}
    this.jobs.set(id,job);this.active.set(id,abort)
    if(args.upload_id)this.uploads.delete(args.upload_id)
    try{await this.persist(job);signal.throwIfAborted();combined.throwIfAborted()}catch(error){job.status='cancelled';job.finished_at=new Date().toISOString();job.error=String(error);this.active.delete(id);if(args.upload_id)await unlink(local).catch(()=>{});await this.persist(job).catch(()=>{});throw error}
    const promise=(async()=>{try{await this.perform(job,args.overwrite===true,combined);combined.throwIfAborted();job.status='completed';job.phase='finished'}catch(error){job.status=combined.aborted?'cancelled':'failed';job.outcome_uncertain=combined.aborted;job.error=String((error as Error).message??error).slice(0,2000)}finally{job.finished_at=new Date().toISOString();this.active.delete(id);if(args.upload_id)await unlink(local).catch(()=>{});await this.persist(job)}return{...job}})()
    this.pending.add(promise);void promise.finally(()=>this.pending.delete(promise)).catch(()=>{})
    return{id,promise}
  }
  private async perform(job:FileJob,overwrite:boolean,signal:AbortSignal){
    const adb=(await this.device.adbInfo()).path,args=['-P',String(this.device.config.adbPort),'-s',job.serial]
    const command=(extra:string[],timeout=300_000)=>{signal.throwIfAborted();return run(adb,[...args,...extra],{windowsHide:true,timeout,maxBuffer:2*1024**2,signal})}
    if(job.kind==='install'){
      if(extname(job.local_path).toLowerCase()!=='.apk')throw new Error('仅支持单个 .apk；拆分 APK / XAPK 尚不支持')
      const info=await stat(job.local_path);if(!info.isFile()||info.size>MAX_BYTES)throw new Error('APK 无效或超过 2 GiB')
      job.bytes=info.size
      job.phase='installing'
      try{const result=await command(['install','--no-incremental','-r',job.local_path]);job.output=(result.stdout+result.stderr).trim();if(!/^Success\s*$/m.test(job.output))throw new Error(job.output||'安装没有返回 Success，请核对手机')}
      catch(error){const e=error as Error&{stdout?:string;stderr?:string};throw new Error((e.stdout??'')+(e.stderr??'')||e.message)}
      return
    }
    if(job.kind==='push'){
      const info=await stat(job.local_path);if(!info.isFile()||info.size>MAX_BYTES)throw new Error('只支持不超过 2 GiB 的普通文件')
      job.bytes=info.size;const target=job.remote_path!,temporary=target+'.dsh-'+job.id+'.part'
      try{
        // Shell arguments are quoted for the Android shell, in addition to execFile's local argv isolation.
        const check=await command(['shell',`if [ -d ${shellArg(target)} ]; then echo DIRECTORY; elif [ -e ${shellArg(target)} ] || [ -L ${shellArg(target)} ]; then echo EXISTS; fi`]);if(check.stdout.trim()==='DIRECTORY')throw new Error('手机目标是目录，请提供完整的目标文件名');if(!overwrite&&check.stdout.trim()==='EXISTS')throw new Error('手机目标文件已存在；需要明确 overwrite=true 才可覆盖')
        job.phase='transferring';await command(['push',job.local_path,temporary]);signal.throwIfAborted()
        job.phase='committing'
        await this.remote.publishTransfer(job.serial,temporary,target,overwrite,signal)
        job.phase='verifying';job.sha256=await fileHash(job.local_path,signal)
        const verification=await command(['shell',`sha256sum ${shellArg(target)}`]);if(verification.stdout.trim().slice(0,64)!==job.sha256)throw new Error('手机文件 SHA-256 与当前电脑源文件不同，请核对源文件是否在传输时发生变化')
      }finally{await run(adb,[...args,'shell',`rm -f ${shellArg(temporary)}`],{windowsHide:true,timeout:5000}).catch(()=>{})}
    }else{
      if(!overwrite){try{await stat(job.local_path);throw new Error('电脑目标文件已存在；需要明确 overwrite=true 才可覆盖')}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}}
      const connection=await this.device.client.createAdb({serial:job.serial})
      try{const info=await connection.sync.lstat(job.remote_path!);if((info.mode&0xf000)!==0x8000||Number(info.size)>MAX_BYTES)throw new Error('只支持不超过 2 GiB 的普通文件')}finally{await connection.close()}
      const temporary=job.local_path+'.dsh-'+job.id+'.part'
      try{job.phase='transferring';await command(['pull',job.remote_path!,temporary]);signal.throwIfAborted();job.phase='verifying';job.bytes=(await stat(temporary)).size;job.sha256=await fileHash(temporary,signal);job.phase='committing';if(overwrite)await rename(temporary,job.local_path);else{await link(temporary,job.local_path);await unlink(temporary)}}finally{await unlink(temporary).catch(()=>{})}
    }
  }
  async close(){this.closed=true;for(const abort of this.uploadAborts)abort.abort(new Error('插件关闭'));for(const abort of this.active.values())abort.abort(new Error('插件关闭'));await this.remote.close();await Promise.allSettled([...this.pending,...this.uploadPending]);for(const upload of this.uploads.values())await unlink(upload.path).catch(()=>{});this.uploads.clear()}
}
export async function fileHash(path:string,signal:AbortSignal){const hash=createHash('sha256');for await(const data of createReadStream(path,{signal})){signal.throwIfAborted();hash.update(data)}return hash.digest('hex')}
