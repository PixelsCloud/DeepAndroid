import { createWriteStream,type WriteStream } from 'node:fs'
import { mkdir,readdir,readFile,stat } from 'node:fs/promises'
import { finished } from 'node:stream/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AndroidRuntime,RuntimeEvent } from './runtime.js'
import { atomicJson,dataDirectory } from './config.js'

function size(value:number){for(let n=1;n<=8;n++){if(value<2**(7*n)-1){const out=Buffer.alloc(n);let v=BigInt(value)|(1n<<BigInt(7*n));for(let i=n-1;i>=0;i--){out[i]=Number(v&255n);v>>=8n}return out}}throw new Error('Matroska element too large')}
function id(value:number){const hex=value.toString(16);return Buffer.from(hex.length%2?'0'+hex:hex,'hex')}
function element(key:number,...data:Uint8Array[]){const payload=Buffer.concat(data);return Buffer.concat([id(key),size(payload.length),payload])}
function uint(key:number,value:number){let n=1;while(value>=2**(8*n))n++;const data=Buffer.alloc(n);let v=BigInt(value);for(let i=n-1;i>=0;i--){data[i]=Number(v&255n);v>>=8n}return element(key,data)}
function text(key:number,value:string){return element(key,Buffer.from(value))}
function float(key:number,value:number){const b=Buffer.alloc(8);b.writeDoubleBE(value);return element(key,b)}
export function annexB(data:Uint8Array){const starts:{start:number;body:number}[]=[];for(let i=0;i<data.length-2;i++){if(data[i]===0&&data[i+1]===0){if(data[i+2]===1){starts.push({start:i,body:i+3});i+=2}else if(data[i+2]===0&&data[i+3]===1){starts.push({start:i,body:i+4});i+=3}}}return starts.map((s,i)=>data.subarray(s.body,starts[i+1]?.start??data.length)).filter(s=>s.length)}
export function avcConfig(data:Uint8Array){const units=annexB(data),sps=units.filter(u=>(u[0]!&31)===7),pps=units.filter(u=>(u[0]!&31)===8);if(!sps.length||!pps.length||sps[0]!.length<4)throw new Error('H.264 SPS/PPS 不完整，不能开始录制');const encoded=(items:Uint8Array[])=>items.map(u=>{if(u.length>65535)throw new Error('H.264 configuration too large');const b=Buffer.alloc(2);b.writeUInt16BE(u.length);return Buffer.concat([b,u])});return Buffer.concat([Buffer.from([1,sps[0]![1]!,sps[0]![2]!,sps[0]![3]!,255,224|sps.length]),...encoded(sps),Buffer.from([pps.length]),...encoded(pps)])}
function avcFrame(data:Uint8Array){const units=annexB(data);if(!units.length)throw new Error('H.264 不是 Annex B 格式');return Buffer.concat(units.map(u=>{const b=Buffer.alloc(4);b.writeUInt32BE(u.length);return Buffer.concat([b,u])}))}
export function mkvHeader(config:Uint8Array,width:number,height:number,audio:boolean){
  const ebml=element(0x1a45dfa3,uint(0x4286,1),uint(0x42f7,1),uint(0x42f2,4),uint(0x42f3,8),text(0x4282,'matroska'),uint(0x4287,4),uint(0x4285,2))
  const info=element(0x1549a966,uint(0x2ad7b1,1_000_000),text(0x4d80,'dsh-android'),text(0x5741,'dsh-android'))
  const video=element(0xae,uint(0xd7,1),uint(0x73c5,1),uint(0x83,1),uint(0x9c,0),text(0x86,'V_MPEG4/ISO/AVC'),element(0x63a2,avcConfig(config)),element(0xe0,uint(0xb0,width),uint(0xba,height)))
  const sound=audio?element(0xae,uint(0xd7,2),uint(0x73c5,2),uint(0x83,2),uint(0x9c,0),text(0x86,'A_PCM/INT/LIT'),element(0xe1,float(0xb5,48000),uint(0x9f,2),uint(0x6264,16))):Buffer.alloc(0)
  return Buffer.concat([ebml,id(0x18538067),Buffer.from('01ffffffffffffff','hex'),info,element(0x1654ae6b,video,sound)])
}
function block(track:number,time:number,key:boolean,data:Uint8Array){const b=Buffer.alloc(4);b[0]=128|track;b.writeInt16BE(time,1);b[3]=key?128:0;return element(0xa3,b,data)}
export interface Recording {id:string;serial:string;status:'recording'|'saved'|'failed';started_at:string;finished_at?:string;local_path:string;bytes:number;duration_ms:number;audio:boolean;width:number;height:number;reason?:string;error?:string}
interface Active {record:Recording;stream:WriteStream;done:Promise<void>;unsubscribe:()=>void;timer?:ReturnType<typeof setTimeout>;keyframeTimer?:ReturnType<typeof setTimeout>;first?:bigint;cluster:number;config?:Uint8Array;header:boolean;pending:number;stopping?:Promise<Recording>}
/** Records the original device packets; no viewer, extra encoder or FFmpeg process is required. */
export class RecordingService{
  readonly directory:string;private records=new Map<string,Recording>();private active?:Active;private starting=false
  constructor(readonly runtime:AndroidRuntime,directory?:string){this.directory=join(dataDirectory(directory),'recordings')}
  async load(){await mkdir(this.directory,{recursive:true});for(const file of await readdir(this.directory)){if(!/^[a-f0-9-]{36}\.json$/.test(file))continue;try{const record=JSON.parse(await readFile(join(this.directory,file),'utf8')) as Recording;if(record.id+'.json'!==file||typeof record.started_at!=='string'||typeof record.local_path!=='string'||!['recording','saved','failed'].includes(record.status))continue;if(record.status==='recording'){record.status='failed';record.error='插件在录制时退出；文件可能不完整';await atomicJson(join(this.directory,file),record)}this.records.set(record.id,record)}catch{}}}
  list(){return [...this.records.values()].sort((a,b)=>b.started_at.localeCompare(a.started_at)).slice(0,100).map(r=>({...r}))}
  get(id:string){const r=this.records.get(id);return r?{...r}:undefined}
  current(){return this.active?{...this.active.record}:null}
  async start(serial:string,signal:AbortSignal,maxSeconds=600){
    if(this.active||this.starting)throw new Error('正在录制，请先停止当前录制');if(!Number.isInteger(maxSeconds)||maxSeconds<1||maxSeconds>3600)throw new Error('录制时长须为 1–3600 秒')
    this.starting=true
    try{
    await this.runtime.ensure(serial);signal.throwIfAborted();if(this.active)throw new Error('正在录制，请先停止当前录制')
    const record:Recording={id:randomUUID(),serial,status:'recording',started_at:new Date().toISOString(),local_path:'',bytes:0,duration_ms:0,audio:this.runtime.audioStatus==='success',width:0,height:0};record.local_path=join(this.directory,record.id+'.mkv')
    await atomicJson(join(this.directory,record.id+'.json'),record);signal.throwIfAborted()
    const stream=createWriteStream(record.local_path,{flags:'wx'}),done=finished(stream);void done.catch(()=>{})
    const active:Active={record,stream,done,unsubscribe:()=>{},cluster:-1,header:false,pending:0};this.active=active;this.records.set(record.id,record)
    stream.on('error',error=>{record.error=String(error.message);void this.stop('写入失败')})
    let replay=true;active.unsubscribe=this.runtime.subscribe(event=>{if(replay&&event.type==='packet'&&event.packet.type==='data')return;this.accept(active,event)});replay=false
    active.timer=setTimeout(()=>void this.stop('已达到录制时长上限'),maxSeconds*1000)
    active.keyframeTimer=setTimeout(()=>{if(this.active===active&&!active.header)void this.stop('8 秒内未收到可录制的关键帧')},8000)
    try{await this.runtime.resetVideo();signal.throwIfAborted()}catch(error){record.error=String(error);await this.stop('开始录制失败');throw error}return{...record,guidance:'正在后台录制；关闭面板不会停止。请显式停止录制取得文件。旋转或断线会结束当前片段。'}
    }finally{this.starting=false}
  }
  private write(active:Active,data:Buffer){if(active.pending+data.length>16*1024**2)throw new Error('磁盘写入积压超过 16 MiB');if(active.record.bytes+data.length>512*1024**2){void this.stop('已达到 512 MiB 上限');return}active.pending+=data.length;active.record.bytes+=data.length;active.stream.write(data,()=>{active.pending-=data.length})}
  private accept(active:Active,event:RuntimeEvent){
    if(active!==this.active||active.stopping)return
    try{
      if(event.type==='state'&&['idle','error'].includes(event.state.state)){void this.stop(event.state.state==='error'?'手机连接中断':'手机已断开');return}
      if(event.type==='packet'){
        const packet=event.packet
        if(packet.type==='session'){if(active.header&&(packet.width!==active.record.width||packet.height!==active.record.height)){void this.stop('画面尺寸变化，已保存当前片段');return}active.record.width=packet.width;active.record.height=packet.height;return}
        if(packet.type==='configuration'){if(active.header&&active.config&&!Buffer.from(active.config).equals(packet.data)){void this.stop('编码参数变化，已保存当前片段');return}active.config=packet.data;return}
        if(!active.header){if(!packet.keyframe||!active.config||!active.record.width||!active.record.height)return;this.write(active,mkvHeader(active.config,active.record.width,active.record.height,active.record.audio));active.header=true;clearTimeout(active.keyframeTimer);active.first=packet.pts??0n}
        this.frame(active,1,packet.pts??0n,!!packet.keyframe,avcFrame(packet.data))
      }else if(event.type==='audio-packet'&&active.header&&active.record.audio){this.frame(active,2,event.pts,true,event.data)}
    }catch(error){active.record.error=String((error as Error).message??error);void this.stop('录制失败，保留已有数据')}
  }
  private frame(active:Active,track:number,pts:bigint,key:boolean,data:Uint8Array){const time=Number((pts-active.first!)/1000n);if(time<0)return;if(!Number.isSafeInteger(time)||time>3_660_000)throw new Error('设备录制时间戳不连续');if(active.cluster<0||time-active.cluster>5000){active.cluster=time;this.write(active,Buffer.concat([id(0x1f43b675),Buffer.from('01ffffffffffffff','hex'),uint(0xe7,time)]))}if(time-active.cluster< -32768)return;this.write(active,block(track,time-active.cluster,key,data));active.record.duration_ms=Math.max(active.record.duration_ms,time)}
  async stop(reason='用户停止录制'):Promise<Recording|null>{
    const active=this.active;if(!active)return null;if(active.stopping)return active.stopping
    active.stopping=(async()=>{clearTimeout(active.timer);clearTimeout(active.keyframeTimer);active.unsubscribe();active.stream.end();try{await active.done}catch(error){active.record.error??=String(error)}active.record.status=active.header&&!active.record.error?'saved':'failed';if(!active.header)active.record.error??='没有收到可录制的关键帧';active.record.reason=reason;active.record.finished_at=new Date().toISOString();active.record.bytes=(await stat(active.record.local_path).catch(()=>({size:0}))).size;await atomicJson(join(this.directory,active.record.id+'.json'),active.record);if(this.active===active)this.active=undefined;return{...active.record}})();return active.stopping
  }
}
