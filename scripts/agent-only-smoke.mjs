import assert from 'node:assert/strict'
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {setTimeout as delay} from 'node:timers/promises'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {apply} from '../dist/agent.js'
import {DeviceService} from '../dist/device.js'
import {pngSize} from '../dist/observation.js'
import {shellArg} from '../dist/files.js'

await mkdir('.build/tests',{recursive:true});await mkdir('.build/evidence',{recursive:true})
const directory=await mkdtemp(join(process.cwd(),'.build/tests/agent-only-')),ctx=new Context();let promptTools
ctx.provide('systemPrompt',{tools(provider){promptTools=provider}});const registry=new ToolRuntime(ctx)
ctx.provide('attachments',{async saveImage({data}){const attachmentId=randomUUID();await writeFile(join(directory,attachmentId+'.png'),data);return{attachmentId,mediaType:'image/png',bytes:data.length,...pngSize(data)}},async readImage(ref){return{data:await readFile(join(directory,ref.attachmentId+'.png'))}}})
ctx.provide('llm',{async resolveModelInfo(){return{inputModalities:['text','image']}}})
const agent={id:'agent-only-test',options:{},cancel(){},session:{requestContext:()=>({provider:'fixture',model:'vision'})}},steps=[],serial='e2b3b128';let n=0,recording,remote
async function call(name,args={}){const result=await registry.execute({name,arguments:args,callId:'agent-only-'+ ++n,agent,signal:AbortSignal.timeout(60000)});assert.equal(result.isError,false,name+': '+JSON.stringify(result));steps.push({tool:name,status:result.value?.status});return result.value}
try{
 await apply(ctx,{dataDir:directory})
 const schemas=promptTools({scope:agent}).schemas;assert.equal(schemas.length,44)
 const devices=await call('android_devices');assert(devices.devices.some(d=>d.serial===serial&&d.state==='device'));await call('android_bind',{serial})
 const local=join(directory,'agent-transfer.txt'),content=Buffer.from('Agent 工具直接传输 '+randomUUID()),hash=createHash('sha256').update(content).digest('hex');await writeFile(local,content);remote='/sdcard/Download/dsh-agent-'+randomUUID()+'.txt'
 const pushed=await call('android_push_file',{local_path:local,remote_path:remote});assert.equal(pushed.status,'completed');assert.equal(pushed.sha256,hash)
 const listing=await call('android_files',{path:'/sdcard/Download'});assert(listing.entries.some(item=>remote.endsWith('/'+item.name)))
 const pulled=await call('android_pull_file',{remote_path:remote});assert.equal(pulled.status,'completed');assert.deepEqual(await readFile(pulled.local_path),content)
 await call('android_capture_settings',{action:'get'});recording=await call('android_recording',{action:'start',max_seconds:30})
 await call('android_open_app',{package_name:'com.android.settings'});const settings=await call('android_observe');assert(settings.elements.some(e=>e.package==='com.android.settings'||e.package_name==='com.android.settings'))
 await call('android_key',{key:'home'});await delay(400);const home=await call('android_observe');assert(home.elements.some(e=>e.package==='com.miui.home'||e.package_name==='com.miui.home'))
 const video=await call('android_recording',{action:'stop',recording_id:recording.id});recording=undefined;assert.equal(video.status,'saved');assert(video.bytes>1000)
 await call('android_release')
 await writeFile('.build/evidence/agent-only-smoke.json',JSON.stringify({pass:true,directory,modelVisibleTools:schemas.map(s=>s.name),steps,transfer:{sha256:hash,local_path:pulled.local_path},recording:video,scope:'Real USB, headless ./agent entry, actual Harness model-facing schema provider and ToolRuntime dispatch. No web server, browser, panel or button. Model metadata is a fixture; no model/chat invocation.'},null,2))
 console.log('PASS model-visible tools → file push/list/pull → record → Settings → observe → Home → observe → stop/save, without loading any panel')
}finally{
 if(recording)await call('android_recording',{action:'stop',recording_id:recording.id}).catch(()=>{})
 await ctx.fiber.dispose()
 if(remote){const device=new DeviceService();await promisify(execFile)((await device.adbInfo()).path,['-s',serial,'shell',`rm -f ${shellArg(remote)}`],{windowsHide:true,timeout:5000}).catch(()=>{})}
}
