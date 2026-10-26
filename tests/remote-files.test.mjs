import{test}from'node:test'
import assert from'node:assert/strict'
import{mkdir,mkdtemp,writeFile}from'node:fs/promises'
import{join}from'node:path'
import{randomUUID}from'node:crypto'
import{setTimeout as delay}from'node:timers/promises'
import{remotePath,mutationPath}from'../dist/remote-path.js'
import{RemoteFiles}from'../dist/remote-files.js'
import{FileService}from'../dist/files.js'
import{DeviceService}from'../dist/device.js'
import{Context}from'@deepseek-ai/cordis'
import{ToolRuntime}from'@deepseek-ai/dsh-tools'
import{TaskLedger}from'../dist/tasks.js'
import{registerAndroidTools}from'../dist/tools.js'
const signal=()=>new AbortController().signal
async function directory(){await mkdir('.build/tests',{recursive:true});return mkdtemp(join(process.cwd(),'.build/tests/file-tools-'))}
const found=(fingerprint='new')=>({status:'found',exists:true,serial:'phone',path:'/sdcard/Download/result.txt',type:'file',bytes:10,fingerprint,mtime_seconds:'100'})

test('normalized remote paths reject traversal/control characters and protect alias storage roots',()=>{
 assert.equal(remotePath('/sdcard//Download/./a/'),'/sdcard/Download/a');assert.equal(mutationPath("/sdcard/Download/a ' $ &.txt"),"/sdcard/Download/a ' $ &.txt")
 for(const path of ['/','/sdcard/.','/storage/emulated/0','/storage/ABCD-1234','/storage/self/primary','/data/local/tmp'])assert.throws(()=>mutationPath(path),path)
 for(const path of ['relative','/sdcard/../x','/sdcard/a\ncmd','/sdcard/a\tcmd'])assert.throws(()=>remotePath(path),path)
})
test('stat distinguishes real ENOENT from denied access and returns lossless sizes, timestamps and fingerprints',async()=>{
 let close=0,fail;const adb={sync:{async lstat(){if(fail)throw new Error(fail);return{mode:0o100644,size:9007199254740993n,mtime:100n,ctime:101n,ino:4n}}},async close(){close++}},remote=new RemoteFiles({client:{async createAdb(){return adb}}})
 const value=await remote.stat('phone','/sdcard/Download/a',false,signal());assert.equal(value.bytes,'9007199254740993');assert.equal(value.modified_at,'1970-01-01T00:01:40.000Z');assert.match(value.fingerprint,/9007199254740993:100/);fail='ENOENT';assert.equal((await remote.stat('phone','/missing',false,signal())).exists,false);fail='EACCES';await assert.rejects(remote.stat('phone','/private',false,signal()),/EACCES/);assert.equal(close,3);await remote.close()
})
test('stat refuses a hash result if the source changes during reading',async()=>{
 let n=0;const remote=new RemoteFiles({client:{async createAdb(){return{sync:{async lstat(){return{mode:0o100644,size:10n,mtime:BigInt(++n),ctime:1n}}},async close(){}}}}});remote.hash=async()=> 'a'.repeat(64);await assert.rejects(remote.stat('phone','/sdcard/a',true,signal()),/计算哈希期间变化/);await remote.close()
})
test('file waits exclude an old fingerprint, reset the stability clock and never call stability producer completion',async()=>{
 const remote=new RemoteFiles({});let samples=0;remote.stat=async()=>found(++samples<3?'old':'new');const result=await remote.wait('phone',{path:'/sdcard/Download/result.txt',different_from:'old',timeout_ms:2500,stable_ms:500,poll_ms:250},signal());assert.equal(result.status,'stable');assert.equal(result.file.fingerprint,'new');assert(result.attempts>=5);assert.equal(result.completion_guaranteed,false);await remote.close()
})
test('file waits return timed_out for an unchanged old file and propagate cancellation instead of claiming no file exists',async()=>{
 const remote=new RemoteFiles({});remote.stat=async()=>found('old');const timeout=await remote.wait('phone',{path:'/sdcard/Download/result.txt',different_from:'old',timeout_ms:500,stable_ms:500,poll_ms:250},signal());assert.equal(timeout.status,'timed_out');assert.equal(timeout.last_stat.exists,true)
 const abort=new AbortController(),pending=remote.wait('phone',{path:'/sdcard/Download/result.txt',timeout_ms:2000,stable_ms:1000},abort.signal),rejected=assert.rejects(pending,/user stop/);abort.abort(new Error('user stop'));await rejected;await remote.close()
})
test('path and wait bounds fail before opening a device transport',async()=>{
 const remote=new RemoteFiles({});await assert.rejects(remote.manage('phone',{action:'delete',path:'/sdcard',recursive:true},signal()),/根目录/);await assert.rejects(remote.manage('phone',{action:'move',path:'/sdcard/a'},signal()),/destination/);await assert.rejects(remote.wait('phone',{path:'/sdcard/a',timeout_ms:100},signal()),/等待/);await remote.close()
})
test('deleting a final symlink removes the link itself, without canonicalizing or following its target',async()=>{
 const calls=[],path='/data/local/tmp/test/link',remote=new RemoteFiles({async runShell(_serial,args){calls.push(args);return args[0]==='readlink'?'/data/local/tmp/test':''}});let removed=false
 remote.stat=async(_serial,value)=>value==='/data/local/tmp/test'?{exists:true,type:'directory'}:value===path&&!removed?{exists:true,type:'symlink',bytes:1}:{exists:false}
 remote.device.runShell=async(_serial,args)=>{calls.push(args);if(args[0]==='rm')removed=true;return args[0]==='readlink'?'/data/local/tmp/test':''}
 const result=await remote.manage('phone',{action:'delete',path},signal());assert.equal(result.status,'completed');assert.deepEqual(calls,[['readlink','-f','--','/data/local/tmp/test'],['rm','-f','--',path]]);await remote.close()
})
test('interrupted persisted jobs remain explicitly uncertain after a plugin restart',async()=>{
 const root=await directory(),files=new FileService({},root),id=randomUUID();await mkdir(files.directory,{recursive:true});await writeFile(join(files.directory,id+'.json'),JSON.stringify({id,kind:'push',status:'running',phase:'committing',started_at:new Date().toISOString(),local_path:join(root,'source.txt'),serial:'phone'}));await files.load();const job=files.get(id);assert.equal(job.status,'failed');assert.equal(job.phase,'interrupted');assert.equal(job.outcome_uncertain,true);assert.equal(files.cancel(id).already_finished,true);await files.close()
})
test('background transfers survive the creating call signal, cancel by fixed ID and report cancellation as uncertain',async()=>{
 const root=await directory(),files=new FileService({},root);await files.load();let started=false
 files.perform=async(_job,_overwrite,taskSignal)=>{started=true;await delay(60000,undefined,{signal:taskSignal})}
 const abort=new AbortController(),task=await files.start('pull','phone',{remote_path:'/sdcard/Download/a',background:true},abort.signal);assert(started);abort.abort(new Error('tool call finished'));await delay(5);assert.equal(files.get(task.id).status,'running');assert.equal(files.cancel(task.id).status,'cancelling');const result=await task.promise;assert.equal(result.status,'cancelled');assert.equal(result.outcome_uncertain,true);assert.equal(files.cancel(task.id).already_finished,true);const snapshot=files.get(task.id);snapshot.status='completed';assert.equal(files.get(task.id).status,'cancelled');await files.close()
})
test('file intents request only read grants, include stream and URI for sharing, and never claim recipient delivery',async()=>{
 const device=new DeviceService(),calls=[];device.shell=async(_serial,args)=>{calls.push(args);return args[0]==='am'&&args[1]==='get-current-user'?'0':'Status: ok\nActivity: com.example.viewer/.Share\nComplete'}
 const result=await device.presentFile('phone','share','content://media/external/file/123','image/png','com.example.viewer',0,signal());assert.equal(result.status,'sent');assert.equal(result.delivery_confirmed,false);assert.equal(result.send_action_performed,false);assert.equal(result.write_permission_requested,false);assert(calls.at(-1).includes('--grant-read-uri-permission'));assert(!calls.at(-1).includes('--grant-write-uri-permission'));assert(calls.at(-1).includes('android.intent.extra.STREAM'));assert.equal(calls.at(-1).filter(s=>s==='content://media/external/file/123').length,2)
 await assert.rejects(device.presentFile('phone','open','content://untrusted/private','text/plain',undefined,0,signal()),/URI/)
})
test('file presentation rejects a switched Android user before launching any receiver',async()=>{
 const device=new DeviceService(),calls=[];device.shell=async(_s,args)=>{calls.push(args);return'10'};await assert.rejects(device.presentFile('phone','open','content://media/external/file/1','image/png',undefined,0,signal()),/用户已变化/);assert.equal(calls.length,1)
})
test('actual Harness registry exposes background start, offline status and idempotent cancellation without a panel',async()=>{
 const ctx=new Context();ctx.provide('systemPrompt',{tools(){}});const registry=new ToolRuntime(ctx),root=await directory(),files=new FileService({},root),tasks=new TaskLedger();await files.load();await writeFile(join(root,'source.txt'),'fixture');files.perform=async(_job,_overwrite,taskSignal)=>delay(60000,undefined,{signal:taskSignal});const runtime={tasks,async bind(){return'phone'},async endSession(){},extensions:{files}};registerAndroidTools(ctx,runtime);let n=0
 const call=(name,args)=>registry.execute({name,arguments:args,callId:'files-'+ ++n,agent:{id:'fixture'},signal:AbortSignal.timeout(10000)})
 try{const start=await call('android_push_file',{local_path:join(root,'source.txt'),remote_path:'/sdcard/Download/test.txt',wait:false});assert.equal(start.isError,false);assert.equal(start.value.status,'started');const id=start.value.job_id;assert.equal((await call('android_transfer_status',{job_id:id})).value.status,'running');assert.equal((await call('android_transfer_cancel',{job_id:id})).value.status,'cancelling');await delay(20);assert.equal((await call('android_transfer_status',{job_id:id})).value.status,'cancelled');assert.equal((await call('android_transfer_cancel',{job_id:id})).value.already_finished,true);assert.equal((await call('android_transfer_status',{job_id:'invented'})).isError,true)}finally{await files.close();await tasks.close();await ctx.fiber.dispose()}
})
