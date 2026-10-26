import{test}from'node:test'
import assert from'node:assert/strict'
import{createServer}from'node:http'
import{mkdir,mkdtemp}from'node:fs/promises'
import{join}from'node:path'
import{setTimeout as delay}from'node:timers/promises'
import{createPanel}from'../dist/host.js'

test('file manager HTTP fences writes, rejects host paths/root mutation and keeps asynchronous jobs pinned without video',async()=>{
 await mkdir('.build/tests',{recursive:true});const dataDir=await mkdtemp(join(process.cwd(),'.build/tests/manager-http-')),panel=await createPanel({dataDir}),server=createServer(panel.handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port,headers={'x-android-client':'1','content-type':'application/json'},calls=[];panel.files.remote.stat=async(_s,path)=>({status:'not_found',exists:false,path});panel.files.remote.manage=async(serial,args)=>{calls.push({serial,...args});return{status:'completed'}}
 const request=(path,value,extra={})=>fetch(origin+'/x-android'+path,{method:value?'POST':'GET',headers:{...headers,...extra},body:value?JSON.stringify(value):undefined})
 try{assert.equal((await fetch(origin+'/x-android/file-manager/jobs')).status,403);assert.equal((await request('/file-manager/jobs',{operation:'delete',serial:'phone',path:'/sdcard/x'},{origin:'https://bad.invalid'})).status,403);assert.equal((await request('/file-manager/jobs',{operation:'delete',serial:'phone',path:'/sdcard',recursive:true})).status,500);assert.equal((await request('/file-manager/jobs',{operation:'push',serial:'phone',path:'/sdcard/x',local_path:'C:/private'})).status,500)
  const response=await request('/file-manager/jobs',{operation:'mkdir',serial:'phone-a',path:'/sdcard/Download/own'});assert.equal(response.status,202);const job=await response.json();for(let n=0;n<100&&panel.fileManager.get(job.id).status!=='completed';n++)await delay(5);assert.equal(panel.fileManager.get(job.id).status,'completed');assert.equal(calls[0].serial,'phone-a');assert.equal(panel.state.state,'idle');assert.equal((await request('/file-manager/jobs/'+job.id)).status,200);assert.equal((await request('/file-manager/jobs/missing')).status,404)
  await request('/file-manager/places',{serial:'phone-a',path:'/sdcard/Download',sort:'name'});await request('/file-manager/places',{serial:'phone-b',path:'/sdcard/Pictures',sort:'modified'});const places=await(await request('/file-manager/places')).json();assert.equal(places.places['phone-a'].path,'/sdcard/Download');assert.equal(places.places['phone-b'].path,'/sdcard/Pictures');assert.equal(places.lastSerial,'phone-b');assert.equal((await request('/file-manager/jobs/'+job.id+'/retry',{})).status,500)
 }finally{await panel.close();await new Promise(resolve=>server.close(resolve))}
})
