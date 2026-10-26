import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdir,mkdtemp,readFile,writeFile,cp} from 'node:fs/promises'
import {join} from 'node:path'
import {createServer} from 'node:http'
import {createPanel} from '../dist/host.js'
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1kAAAAASUVORK5CYII=','base64')
test('backup copy restores legacy results, rename/deletion, preferences, templates and original screenshot exports',async t=>{
 await mkdir('.build/tests',{recursive:true});const base=await mkdtemp(join(process.cwd(),'.build/tests/upgrade-')),original=join(base,'original'),backup=join(base,'backup'),restored=join(base,'restored')
 const panel=await createPanel({dataDir:original});await mkdir(join(original,'images'));await writeFile(join(original,'images','proof.png'),png)
 const source={observation_id:'old-observation',captured_at:'2026-10-24T12:00:00Z',serial:'fixture-phone',screenshot:{attachmentId:'proof',mediaType:'image/png',bytes:png.length,width:1,height:1}}
 const input=title=>({title,status:'complete',summary:'升级测试',columns:['内容'],rows:[{cells:['备份正文'],observation_ids:[source.observation_id]}]})
 const a=await panel.results.save('s','a','t',input('旧版本结果'),()=>source,new AbortController().signal)
 const b=await panel.results.save('s','b','t',input('改名之前'),()=>source,new AbortController().signal);await panel.results.rename(b.id,'改名之后')
 const c=await panel.results.save('s','c','t',input('已删除'),()=>source,new AbortController().signal);await panel.results.remove(c.id)
 await panel.preferences.save({adbPath:'auto',maxCalls:42,taskTimeoutMs:120000});await panel.templates.save({title:'备份模板',body:'打开 {{app}}',defaults:{app:'设置'}});await panel.panelState.update({panel:'results',serial:'fixture-phone',connection:'disconnected',autoOpen:false});await panel.close()
 // Version 0.7 result files predate input_hash and remain readable without rewriting them.
 const legacy={...a};delete legacy.input_hash;const legacyFile=join(original,'results',a.id+'.json');await writeFile(legacyFile,JSON.stringify(legacy));const before=await readFile(legacyFile)
 await cp(original,backup,{recursive:true});await cp(backup,restored,{recursive:true})
 const loaded=await createPanel({dataDir:restored},()=>[],{readImage:async ref=>{assert.equal(ref.attachmentId,'proof');return{data:await readFile(join(restored,'images',ref.attachmentId+'.png'))}}}),server=createServer(loaded.handler)
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await loaded.close();await new Promise(resolve=>server.close(resolve))})
 assert.equal(loaded.results.query().total,2);assert.equal(loaded.results.get(a.id).title,'旧版本结果');assert.equal(loaded.results.get(b.id).title,'改名之后');assert.equal(loaded.results.get(c.id),null);assert.equal(loaded.results.query({deleted:true}).total,1)
 assert.equal(loaded.preferences.value.maxCalls,42);assert(loaded.templates.list().some(item=>item.title==='备份模板'));assert.equal(loaded.panelState.value.autoOpen,false);assert.equal(loaded.panelState.value.connection,'disconnected')
 assert.deepEqual(await readFile(join(restored,'results',a.id+'.json')),before)
 const headers={'x-android-client':'1'},url=`http://127.0.0.1:${server.address().port}/x-android/results/${a.id}`
 assert.deepEqual(Buffer.from(await(await fetch(url+'/source/1',{headers})).arrayBuffer()),png)
 for(const format of ['markdown','csv','bundle']){const response=await fetch(url+'/export?format='+format,{headers});assert.equal(response.status,200);assert((await response.arrayBuffer()).byteLength>30)}
 await loaded.results.restore(c.id);assert.equal(loaded.results.query().total,3);assert.deepEqual(loaded.results.get(c.id).sources,c.sources)
})
