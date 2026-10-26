import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createServer} from 'node:http'
import {ResultStore} from '../dist/results.js'
import {createPanel} from '../dist/host.js'
const source={observation_id:'actual_observation',captured_at:'2026-10-24T12:00:00Z',serial:'phone',screenshot:{attachmentId:'image',mediaType:'image/png',bytes:24,width:100,height:200}}
const input=(title='原始标题',extra={})=>({title,status:'complete',summary:'社区讨论摘要',columns:['内容'],rows:[{cells:['实际正文 [.*]'],observation_ids:[source.observation_id],note:'备注检索'}],...extra})
const save=(store,call,title='原始标题')=>store.save('session',call,'task',input(title),()=>source,new AbortController().signal)
async function directory(){await mkdir('.build/tests',{recursive:true});return mkdtemp(join(process.cwd(),'.build/tests/result-management-'))}

test('rename preserves content, sources, original time and idempotency of a legacy saved tool call',async()=>{
 const root=await directory(),store=new ResultStore(root);await store.load();const saved=await save(store,'old')
 const legacy={...saved};delete legacy.input_hash;await writeFile(join(root,'results',saved.id+'.json'),JSON.stringify(legacy))
 const restored=new ResultStore(root);await restored.load();const renamed=await restored.rename(saved.id,'  新名称  ')
 assert.equal(renamed.title,'新名称');assert.equal(renamed.created_at,saved.created_at);assert.deepEqual(renamed.rows,saved.rows);assert.deepEqual(renamed.sources,saved.sources);assert(renamed.updated_at)
 const retried=await save(restored,'old');assert.equal(retried.id,saved.id);assert.equal(retried.title,'新名称');assert.equal(restored.query().total,1)
 await assert.rejects(restored.rename(saved.id,'\n空名称'),error=>error.status===400);assert.equal(restored.get(saved.id).title,'新名称')
})
test('deleted results persist in recent deletion, remain on disk and can be restored after restart',async()=>{
 const root=await directory(),store=new ResultStore(root);await store.load();const saved=await save(store,'one')
 await store.remove(saved.id);await store.remove(saved.id);assert.equal(store.get(saved.id),null);assert.equal(store.query().total,0);assert.equal(store.query({deleted:true}).total,1);assert((await readFile(join(root,'results',saved.id+'.json'),'utf8')).includes('deleted_at'))
 const loaded=new ResultStore(root);await loaded.load();assert.equal(loaded.query({deleted:true}).total,1);await assert.rejects(loaded.rename(saved.id,'不能改'),error=>error.status===409)
 const restored=await loaded.restore(saved.id);assert.equal(restored.deleted_at,undefined);assert.deepEqual(restored.sources,saved.sources);assert.deepEqual(restored.rows,saved.rows);assert.equal(loaded.query().total,1)
})
test('retrying a deleted tool call does not silently recreate or restore the result',async()=>{
 const store=new ResultStore(),saved=await save(store,'one');await store.remove(saved.id)
 const retried=await save(store,'one');assert.equal(retried.id,saved.id);assert(retried.deleted_at);assert.equal(store.query().total,0);assert.equal(store.query({deleted:true}).total,1)
})
test('literal normalized search covers title, summary, cells and notes without regex behavior',async()=>{
 const store=new ResultStore();await save(store,'a','ＡＢＣ热榜');await store.save('s','b','t',input('其他',{summary:'没有匹配',rows:[{cells:['普通正文'],observation_ids:[source.observation_id],note:''}]}),()=>source,new AbortController().signal)
 for(const query of ['abc','社区讨论','实际正文','备注检索','[.*]'])assert.equal(store.query({query}).total,1)
 assert.equal(store.query({query:'不存在'}).total,0)
})
test('timestamp ranges include the start and exclude the following midnight for local date filtering',async()=>{
 const root=await directory(),store=new ResultStore(root);await store.load()
 const dates=['2026-10-23T15:59:59.999Z','2026-10-23T16:00:00.000Z','2026-10-24T15:59:59.999Z','2026-10-24T16:00:00.000Z']
 for(const [i,created_at]of dates.entries()){const saved=await save(store,String(i),'记录'+i);await writeFile(join(root,'results',saved.id+'.json'),JSON.stringify({...saved,created_at}))}
 const loaded=new ResultStore(root);await loaded.load();const filtered=loaded.query({from:'2026-10-23T16:00:00.000Z',before:'2026-10-24T16:00:00.000Z'});assert.deepEqual(filtered.results.map(r=>r.title),['记录2','记录1'])
 assert.throws(()=>loaded.query({from:'2026-02-30T00:00:00.000Z'}),error=>error.status===400);assert.throws(()=>loaded.query({from:dates[3],before:dates[0]}),error=>error.status===400)
})
test('pagination can reach results older than the previous 100-result display limit',async()=>{
 const root=await directory(),store=new ResultStore(root);await store.load();let oldest
 for(let i=0;i<105;i++){const saved=await save(store,String(i),'记录'+i);oldest??=saved.id}
 assert.equal(store.summaries().length,100);assert.equal(store.query().total,105);assert.equal(store.query({offset:100}).results.length,5);assert.equal(store.query({offset:100}).has_more,false)
 const loaded=new ResultStore(root);await loaded.load();assert.deepEqual(loaded.query({offset:100}).results.map(r=>r.id),store.query({offset:100}).results.map(r=>r.id));
 assert(store.get(oldest));assert.equal(store.query({query:'记录0'}).total,1);assert.throws(()=>store.query({offset:-1}),error=>error.status===400)
})
test('queued rename/delete/restore operations preserve the latest committed metadata',async()=>{
 const store=new ResultStore(),saved=await save(store,'one')
 await Promise.all([store.rename(saved.id,'新名称'),store.remove(saved.id),store.restore(saved.id)])
 assert.equal(store.get(saved.id).title,'新名称');assert.equal(store.get(saved.id).deleted_at,undefined);assert.equal(store.query({query:'新名称'}).total,1)
})
test('HTTP management is authenticated, reversible and reflected in exports without internal hashes',async t=>{
 const panel=await createPanel({},()=>[],{async readImage(){return{data:Buffer.from([137,80,78,71])}}}),server=createServer(panel.handler)
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await panel.close();await new Promise(resolve=>server.close(resolve))})
 const saved=await save(panel.results,'one'),base=`http://127.0.0.1:${server.address().port}/x-android/results`,headers={'x-android-client':'1','content-type':'application/json'}
 const post=(action,value={},custom=headers)=>fetch(`${base}/${saved.id}/${action}`,{method:'POST',headers:custom,body:JSON.stringify(value)})
 assert.equal((await post('delete',{},{})).status,403);assert.equal((await post('delete',{}, {...headers,origin:'https://foreign.invalid'})).status,403);assert.equal((await fetch(`${base}/${saved.id}/delete`,{headers})).status,404)
 assert.equal((await post('rename',{title:'正式标题'})).status,200);const json=await(await fetch(`${base}/${saved.id}`,{headers})).json();assert.equal(json.title,'正式标题');assert.equal(json.input_hash,undefined)
 assert((await(await fetch(`${base}/${saved.id}/export?format=markdown`,{headers})).text()).includes('正式标题'))
 assert.equal((await post('delete')).status,200);assert.equal((await fetch(`${base}/${saved.id}`,{headers})).status,404);assert.equal((await fetch(`${base}/${saved.id}/export?format=csv`,{headers})).status,404)
 assert.equal((await(await fetch(`${base}?deleted=1`,{headers})).json()).total,1);assert((await(await fetch(`${base}/${saved.id}?deleted=1`,{headers})).json()).deleted_at)
 assert.equal((await post('restore')).status,200);assert.equal((await fetch(`${base}/${saved.id}/source/1`,{headers})).status,200);assert.equal((await fetch(`${base}?from=wrong`,{headers})).status,400)
})
