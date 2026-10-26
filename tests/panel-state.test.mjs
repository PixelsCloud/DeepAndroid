import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createServer} from 'node:http'
import {PanelStateStore,DEFAULT_PANEL_STATE,panelPatch} from '../dist/panel-state.js'
import {createPanel} from '../dist/host.js'
async function directory(){await mkdir('.build/tests',{recursive:true});return mkdtemp(join(process.cwd(),'.build/tests/panel-'))}
test('older installations default to automatic single-phone connection without changing existing data',async()=>{
 const root=await directory();await writeFile(join(root,'unrelated.json'),'original');const store=new PanelStateStore(root);await store.load()
 assert.deepEqual(store.value,DEFAULT_PANEL_STATE);assert.equal(store.warning,null);assert.equal(await readFile(join(root,'unrelated.json'),'utf8'),'original')
})
test('concurrent partial updates preserve page, selected phone, explicit disconnection and startup preference across restart',async()=>{
 const root=await directory(),store=new PanelStateStore(root);await store.load()
 await Promise.all([store.update({panel:'results'}),store.update({serial:'phone-a',connection:'disconnected'}),store.update({autoOpen:false})]);await store.flush()
 const loaded=new PanelStateStore(root);await loaded.load();assert.deepEqual(loaded.value,{version:1,panel:'results',serial:'phone-a',connection:'disconnected',autoOpen:false})
 await loaded.update({connection:'connected'});assert.equal(loaded.value.panel,'results');assert.equal(loaded.value.serial,'phone-a')
})
test('malformed state is preserved with a warning and invalid updates never replace a committed choice',async()=>{
 const root=await directory();await writeFile(join(root,'panel-state.json'),'{broken');const store=new PanelStateStore(root);await store.load();assert(store.warning);assert.equal(await readFile(join(root,'panel-state.json'),'utf8'),'{broken')
 for(const input of [null,[],{version:2},{panel:['phone']},{panel:'bad'},{connection:['auto']},{connection:'bad'},{serial:'\n'},{serial:2},{autoOpen:1},{unknown:true}])assert.throws(()=>panelPatch(input))
 await store.update({panel:'debug'});assert.equal(store.warning,null);assert.throws(()=>store.update({panel:'invalid'}));assert.equal(store.value.panel,'debug')
})
test('panel-state endpoints fence cross-origin writes and persist validated patches',async t=>{
 const root=await directory(),panel=await createPanel({dataDir:root}),server=createServer(panel.handler)
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await panel.close();await new Promise(resolve=>server.close(resolve))})
 const base=`http://127.0.0.1:${server.address().port}/x-android/panel-state`,headers={'x-android-client':'1','content-type':'application/json'}
 assert.equal((await fetch(base)).status,403);assert.equal((await fetch(base,{method:'POST',headers:{...headers,origin:'https://foreign.invalid'},body:'{}'})).status,403)
 assert.equal((await fetch(base,{method:'POST',headers,body:'{"panel":["phone"]}'})).status,400)
 const response=await fetch(base,{method:'POST',headers,body:JSON.stringify({panel:'results',connection:'disconnected'})});assert.equal(response.status,200)
 const restored=new PanelStateStore(root);await restored.load();assert.equal(restored.value.panel,'results');assert.equal(restored.value.connection,'disconnected')
})
