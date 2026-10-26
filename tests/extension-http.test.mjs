import{test}from'node:test'
import assert from'node:assert/strict'
import{createServer}from'node:http'
import{mkdir,mkdtemp,readFile}from'node:fs/promises'
import{join}from'node:path'
import{createPanel}from'../dist/host.js'
test('extension endpoints fence writes/downloads, persist media without a phone, and accept bounded binary staging without arbitrary host paths',async()=>{
 await mkdir('.build/tests',{recursive:true});const directory=await mkdtemp(join(process.cwd(),'.build/tests/extensions-http-')),panel=await createPanel({dataDir:directory}),server=createServer(panel.handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`,headers={'x-android-client':'1','content-type':'application/json'}
 const request=(path,value,extra={})=>fetch(origin+'/x-android'+path,{method:value===undefined?'GET':'POST',headers:{...headers,...extra},body:value===undefined?undefined:JSON.stringify(value)})
 try{
  assert.equal((await fetch(origin+'/x-android/file-jobs')).status,403);assert.equal((await request('/media-settings',{maxSize:1920},{origin:'https://untrusted.invalid'})).status,403)
  const saved=await request('/media-settings',{maxSize:1920,audio:true,audioSource:'playback'});assert.equal(saved.status,200);assert.equal(panel.state.state,'idle');assert.equal((await(await request('/media-settings')).json()).saved.audio,true)
  assert.equal((await request('/media-settings',{maxFps:0})).status,500);assert.equal(panel.media.value.maxFps,30)
  const binary=Buffer.alloc(100000,127),upload=await fetch(origin+'/x-android/file-upload?name='+encodeURIComponent('../../中文.bin'),{method:'POST',headers:{'x-android-client':'1'},body:binary});assert.equal(upload.status,200);const staged=await upload.json();assert.equal(staged.name,'中文.bin');assert.deepEqual(await readFile(panel.files.source(undefined,staged.id)),binary)
  assert.equal((await request('/file-jobs',{kind:'push',serial:'phone',local_path:'C:/private.txt'})).status,500);assert.equal((await request('/recordings',{action:'start',serial:'phone',max_seconds:0})).status,500);assert.equal(panel.state.state,'idle')
  assert.equal((await request('/download-ticket',{id:'invented'})).status,500);assert.equal((await fetch(origin+'/x-android/download/invented?ticket=invented')).status,403);assert.equal((await request('/download/invented')).status,404)
 }finally{await panel.close();await new Promise(r=>server.close(r))}
})
