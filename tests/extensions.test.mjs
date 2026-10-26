import{test}from'node:test'
import assert from'node:assert/strict'
import{mkdir,mkdtemp,readFile,writeFile,stat}from'node:fs/promises'
import{Readable,PassThrough}from'node:stream'
import{join}from'node:path'
import{FileService,remotePath,shellArg}from'../dist/files.js'
import{MediaStore,mediaPatch}from'../dist/media-settings.js'
import{InputController}from'../dist/input.js'
import{Context}from'@deepseek-ai/cordis'
import{ToolRuntime}from'@deepseek-ai/dsh-tools'
import{registerAndroidTools}from'../dist/tools.js'
import{TaskLedger}from'../dist/tasks.js'
const signal=()=>new AbortController().signal
test('closing the service aborts an unfinished upload and rejects further operations',async()=>{
 const root=await directory(),service=new FileService({},root);await service.load();const source=new PassThrough(),upload=service.stage(source,'partial.bin',signal()),rejected=assert.rejects(upload,/abort|关闭/i);source.write(Buffer.alloc(20));await service.close();await rejected;await assert.rejects(service.stage(Readable.from(['x']),'late.bin',signal()),/关闭/);await assert.rejects(service.start('push','phone',{local_path:'C:/file'},signal()),/关闭/)
})
async function directory(){await mkdir('.build/tests',{recursive:true});return mkdtemp(join(process.cwd(),'.build/tests/extensions-'))}
test('remote paths reject traversal and control characters while Android shell quoting preserves spaces, quotes and metacharacters',()=>{
 for(const path of ['relative','/sdcard/../private','/sdcard/a\ncommand','/sdcard/\0bad'])assert.throws(()=>remotePath(path))
 assert.equal(remotePath('/sdcard/中文 /a$`"\'()'),'/sdcard/中文 /a$`"\'()');assert.equal(shellArg("a'b$()`"),"'a'\\''b$()`'")
})
test('staged uploads cannot choose a local path, close removes only its own staged files, restart marks unfinished file jobs uncertain',async()=>{
 const root=await directory(),service=new FileService({},root);await service.load();const unrelated=join(service.directory,'keep.txt');await writeFile(unrelated,'keep')
 const upload=await service.stage(Readable.from([Buffer.from('你好\0binary')]),'../中文.bin',signal());assert.equal(upload.name,'中文.bin');assert.equal((await readFile(service.source(undefined,upload.id))).toString(),'你好\0binary');assert.throws(()=>service.source('relative'));assert.throws(()=>service.source(undefined,'invented'))
 const record={id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',kind:'push',status:'running',serial:'phone',started_at:new Date().toISOString(),local_path:'C:/source'};await writeFile(join(service.directory,record.id+'.json'),JSON.stringify(record));const restored=new FileService({},root);await restored.load();assert.equal(restored.get(record.id).status,'failed');assert.match(restored.get(record.id).error,/未知/)
 const staged=service.source(undefined,upload.id);await service.close();await assert.rejects(stat(staged),/ENOENT/);assert.equal(await readFile(unrelated,'utf8'),'keep')
})
test('media settings retain independent partial updates across restart and reject invalid values before mutation',async()=>{
 const root=await directory(),media=new MediaStore(root);await media.load();await Promise.all([media.save({maxSize:1920,audio:true}),media.save({maxFps:45,audioSource:'playback'})]);const restored=new MediaStore(root);await restored.load();assert.deepEqual(restored.value,{maxSize:1920,maxFps:45,videoBitRate:4000000,audio:true,audioSource:'playback'});const before=JSON.stringify(restored.value);for(const patch of [{maxSize:0},{maxFps:121},{videoBitRate:Infinity},{audio:'yes'},{audioSource:'mic'},{unknown:1}])assert.throws(()=>mediaPatch(patch));assert.equal(JSON.stringify(restored.value),before)
})
test('device controls are ordered with touch release; explicit clipboard writes never paste and denied input stays denied',async()=>{
 const calls=[],writer={async injectTouch(p){calls.push(['touch',p.action])},async setDisplayPower(on){calls.push(['screen',on])},async rotateDevice(){calls.push(['rotate'])},async expandNotificationPanel(){calls.push(['notifications'])},async expandSettingPanel(){calls.push(['settings'])},async collapseNotificationPanel(){calls.push(['collapse'])},async setClipboard(p){calls.push(['clip',p])},async injectKeyCode(){},async injectText(){},async injectScroll(){}}
 const input=new InputController(writer);await input.setGeometry(100,200);const p={...input.geometry,x:20,y:30};await input.send({kind:'pointer',phase:'down',...p});await Promise.all([input.control('screen_off'),input.control('screen_on'),input.control('rotate'),input.control('notifications'),input.control('quick_settings'),input.control('collapse_panels')]);assert.deepEqual(calls.slice(0,4),[['touch',0],['touch',1],['screen',false],['screen',true]])
 await input.setClipboard('中文');assert.equal(calls.at(-1)[1].paste,false);input.block('拒绝输入注入');await assert.rejects(input.setClipboard('anything'),/拒绝/);await input.close()
})
test('native extensions validate arguments and retain real installation failures instead of announcing success',async t=>{
 const ctx=new Context();ctx.provide('systemPrompt',{tools(){}});const registry=new ToolRuntime(ctx),tasks=new TaskLedger(),calls=[]
 const runtime={tasks,async bind(){return'phone'},async endSession(){},extensions:{files:{async start(kind,serial,args){calls.push({kind,serial,args});return{id:'job',promise:Promise.resolve({status:'failed',error:'INSTALL_FAILED_USER_RESTRICTED'})}}}}};registerAndroidTools(ctx,runtime);t.after(async()=>{await tasks.close();await ctx.fiber.dispose()});let n=0;const run=(name,args)=>registry.execute({name,arguments:args,callId:'extension-'+ ++n,agent:{id:'test'},signal:signal()})
 assert.equal((await run('android_install_apk',{})).isError,true);assert.equal((await run('android_install_apk',{local_path:'C:/a.apk',upload_id:'fake'})).isError,true);assert.equal((await run('android_device_control',{action:'root'})).isError,true);assert.equal((await run('android_capture_settings',{action:'set',audio_source:'mic'})).isError,true);const result=await run('android_install_apk',{local_path:'C:/test.apk'});assert.equal(result.isError,false);assert.equal(result.value.status,'failed');assert.match(registry.get('android_install_apk').presentResult({},result).content[0].text,/INSTALL_FAILED_USER_RESTRICTED/);assert.equal(calls.length,1)
})
