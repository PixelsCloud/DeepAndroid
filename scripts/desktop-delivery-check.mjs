import assert from'node:assert/strict'
import{readFile,readdir,writeFile}from'node:fs/promises'
import{join}from'node:path'
import{createHash}from'node:crypto'
import{setTimeout as delay}from'node:timers/promises'
const[phase,port,tag='160']=process.argv.slice(2);assert(/^\d{3}$/.test(tag));assert(['before','after'].includes(phase)&&/^\d+$/.test(port??''));const origin='http://127.0.0.1:'+port,headers={'x-android-client':'1'},directory=join(process.env.USERPROFILE,'.dsh','android'),profile=join(process.env.USERPROFILE,'.dsh','profiles','desktop'),hash=data=>createHash('sha256').update(data).digest('hex')
const get=async path=>{const response=await fetch(origin+'/x-android'+path,{headers});assert(response.ok,`${path}: ${response.status}`);return response}
let health;for(let i=0;i<100;i++){health=await(await get('/health')).json();if(phase==='before'||health.state==='streaming')break;await delay(300)}
const records=await(await get('/records')).json();assert.equal(health.owner,null,'Do not update a busy phone runtime');assert(!records.tasks.some(task=>task.status==='running'),'Do not update an active native task')
const resultFiles=(await readdir(join(directory,'results'))).filter(name=>name.endsWith('.json')),reports=[],images=[]
for(const name of resultFiles){const raw=await readFile(join(directory,'results',name)),report=JSON.parse(raw);reports.push({id:report.id,name,sha256:hash(raw)});if(!report.deleted_at)for(let index=0;index<report.sources.length;index++){const data=Buffer.from(await(await get(`/results/${report.id}/source/${index+1}`)).arrayBuffer());assert.equal(data.subarray(0,8).toString('hex'),'89504e470d0a1a0a');images.push({report:report.id,index:index+1,sha256:hash(data)})}}
reports.sort((a,b)=>a.id.localeCompare(b.id));images.sort((a,b)=>a.report.localeCompare(b.report)||a.index-b.index)
const configFiles={};for(const name of ['package.json','pnpm-lock.yaml','cordis.patch.yml'])configFiles[name]=hash(await readFile(join(profile,name)))
const evidence={phase,port,health,reports,images,profileFiles:configFiles,checked_at:new Date().toISOString()}
if(phase==='after'){const before=JSON.parse(await readFile(`.build/evidence/desktop-${tag}-before.json`,'utf8')),version=JSON.parse(await readFile('package.json','utf8')).version;assert.equal(health.pluginVersion,version);assert.equal(health.nativeTools.length,44);assert.equal(health.state,'streaming');assert(health.viewers>=1);for(const report of before.reports)assert.deepEqual(reports.find(r=>r.id===report.id),report);for(const image of before.images)assert.deepEqual(images.find(i=>i.report===image.report&&i.index===image.index),image);assert.deepEqual(configFiles,before.profileFiles);evidence.pass=true}
await writeFile(`.build/evidence/desktop-${tag}-${phase==='after'?'delivery-health':'before'}.json`,JSON.stringify(evidence,null,2));console.log(JSON.stringify({pass:phase==='after'?true:undefined,phase,pluginVersion:health.pluginVersion,state:health.state,viewers:health.viewers,tools:health.nativeTools.length,reports:reports.length,images:images.length,profileUnchanged:phase==='after'?true:undefined}))
