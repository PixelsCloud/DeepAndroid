import assert from 'node:assert/strict'
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {createPanel} from '../dist/host.js'
import {registerAndroidTools} from '../dist/tools.js'
import {pngSize} from '../dist/observation.js'
await mkdir('.build/tests',{recursive:true});await mkdir('.build/evidence',{recursive:true})
const directory=await mkdtemp(join(process.cwd(),'.build/tests/clock-'));await mkdir(join(directory,'images'));let image=0
const attachments={async saveImage({data}){const attachmentId='clock-'+(++image);await writeFile(join(directory,'images',attachmentId+'.png'),data);return{attachmentId,mediaType:'image/png',bytes:data.length,...pngSize(data)}},async readImage(ref){return{data:await readFile(join(directory,'images',ref.attachmentId+'.png'))}}}
const panel=await createPanel({dataDir:directory},()=>[],attachments),ctx=new Context();ctx.provide('systemPrompt',{tools(){}});const registry=new ToolRuntime(ctx);ctx.provide('llm',{async resolveModelInfo(){return{inputModalities:['text','image']}}});ctx.provide('attachments',attachments);registerAndroidTools(ctx,panel.runtime)
const agent={id:'clock-native-smoke',session:{requestContext:()=>({provider:'integration',model:'no-model'})},options:{}},results=[];let call=0
async function run(name,args={}){const result=await registry.execute({callId:'clock-'+(++call),name,arguments:args,agent,signal:AbortSignal.timeout(65000)});results.push({name,args,result});assert.equal(result.isError,false,JSON.stringify(result));return result.value}
try{
 const apps=await run('android_apps',{query:'时钟'});assert(apps.apps.some(a=>a.name==='时钟'))
 const opened=await run('android_open_app',{app_name:'时钟'});const pkg=opened.app.package_name
 const watch=await run('android_tap_target',{text:'秒表',exact:true,package_name:pkg,max_attempts:3});assert.equal(watch.action_sent,true)
 const observed=await run('android_observe');const labels=observed.elements.filter(e=>e.package_name===pkg).map(e=>e.text||e.description).filter(Boolean);console.log('Clock labels',labels)
 assert(labels.includes('秒表'));assert(labels.some(s=>s.includes('开始')||s.includes('启动')))
 const saved=await run('android_save_result',{title:'时钟原生交互验收',status:'complete',summary:'打开已安装的时钟 App，切换至秒表并读取当前界面，没有启动计时。',columns:['页面文字'],rows:labels.slice(0,12).map(text=>({cells:[text],observation_ids:[observed.observation_id]}))});assert(saved.result_id)
 await run('android_key',{key:'home'});const home=await run('android_observe');assert(home.elements.some(e=>e.package_name==='com.miui.home'));await run('android_release');ctx.emit('agent/status',{agent,status:'idle'});await panel.tasks.flush();assert.equal(panel.results.query().total,1)
 await writeFile('.build/evidence/clock-smoke.json',JSON.stringify({pass:true,directory,package:pkg,labels,resultId:saved.result_id,kind:'Real phone + actual native ToolRuntime; no model invocation and no timer started',results},null,2));console.log('PASS clock app → stopwatch tab → observed labels → native saved result with screenshot → Home')
}catch(error){await writeFile('.build/evidence/clock-failure.json',JSON.stringify({error:String(error),results},null,2));throw error}finally{await panel.close();await ctx.fiber.dispose()}
