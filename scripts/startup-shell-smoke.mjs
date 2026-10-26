import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdir,mkdtemp,readFile,realpath,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {chromium} from 'playwright-core'
const profile=process.argv[2];assert(profile&&/^[a-z0-9_-]+$/i.test(profile),'Pass an installed acceptance profile')
await mkdir('.build/tests',{recursive:true});await mkdir('.build/evidence',{recursive:true})
const directory=await mkdtemp(join(process.cwd(),'.build/tests/shell-startup-')),app=join(process.env.LOCALAPPDATA,'Programs','DeepSeek Harness'),plugin=await realpath(join(process.env.USERPROFILE,'.dsh','profiles',profile,'node_modules','dsh-android'))
assert(!plugin.toLowerCase().startsWith(resolve('.').toLowerCase()),'Test the installed archive, not a development link')
const version=JSON.parse(await readFile(join(plugin,'package.json'),'utf8')).version
const child=spawn(join(app,'DeepSeek Harness.exe'),['--expose-internals',join(app,'resources','app.asar','dsh','node_modules','@deepseek-ai','dsh-desktop-host','lib','cli.js'),'--profile',profile,'--no-open','--port','0'],{windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',DSH_ANDROID_DATA_DIR:directory}})
let output='',diagnostics='',ended=false,browser;child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>diagnostics+=x);const closed=new Promise(r=>child.once('close',code=>{ended=true;r(code)}))
const errors=[],checks=[]
try{
 let launch;for(let i=0;i<300;i++){launch=output.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+[^\s\u001b]*/)?.[0];if(launch)break;assert(!ended,diagnostics.slice(-1000));await new Promise(r=>setTimeout(r,100))}assert(launch,'No launch URL')
 const origin=new URL(launch).origin,headers={'x-android-client':'1','content-type':'application/json'}
 async function state(patch){const response=await fetch(origin+'/x-android/panel-state',{headers,method:patch?'POST':'GET',body:patch?JSON.stringify(patch):undefined});assert.equal(response.status,200);return(await response.json()).state}
 browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true})
 async function open(context){const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(launch);const notice=page.getByRole('button',{name:'Continue',exact:true});await page.locator('[data-row-key^="session:"]').first().waitFor();await notice.waitFor({state:'visible',timeout:2000}).catch(()=>{});if(await notice.isVisible())await notice.click();if(!await page.getByRole('button',{name:'Android',exact:true}).isVisible())await page.locator('[data-row-key^="session:"]').filter({hasNotText:/^New Session/}).first().click();await page.getByRole('button',{name:'Android',exact:true}).waitFor();return page}
 const context=await browser.newContext({viewport:{width:1360,height:1000}}),page=await open(context)
 await page.waitForFunction(()=>Number(document.querySelector('.android-panel')?.parentElement?.dataset.framesRendered)>0,null,{timeout:30000})
 const health=await(await fetch(origin+'/x-android/health',{headers})).json();assert.equal(health.pluginVersion,version);assert.equal(health.nativeTools.length,44);assert.equal(health.viewers,1)
 checks.push('actual Harness shell opens Android after a session surface is adopted, without clicking Android')
 await page.getByRole('tab',{name:'结果',exact:true}).click();for(let i=0;i<50&&(await state()).panel!=='results';i++)await page.waitForTimeout(50)
 await page.reload();if(!await page.getByRole('button',{name:'Android',exact:true}).isVisible())await page.locator('[data-row-key^="session:"]').filter({hasNotText:/^New Session/}).first().click()
 await page.getByRole('tab',{name:'结果',selected:true,exact:true}).waitFor();await page.locator('.android-panel').screenshot({path:'.build/evidence/startup-shell-results.png'})
 checks.push('full shell reload restores the Results page')
 await context.close();await state({autoOpen:false,panel:'debug',connection:'disconnected'})
 const disabled=await browser.newContext({viewport:{width:1360,height:1000}}),manual=await open(disabled);await manual.waitForTimeout(1000);assert.equal(await manual.locator('.android-panel').count(),0)
 await manual.getByRole('button',{name:'Android',exact:true}).click();await manual.getByRole('tab',{name:'调试',selected:true,exact:true}).waitFor();assert.equal((await state()).connection,'disconnected')
 checks.push('disabled startup restoration stays closed; the Android button still opens the saved Debug page')
 assert.deepEqual(errors,[]);await writeFile('.build/evidence/startup-shell-smoke.json',JSON.stringify({pass:true,profile,plugin,version,directory,checks,errors,scope:'Installed plugin in actual Harness shell; selects an existing session only; no chat message or model invocation'},null,2));console.log(JSON.stringify({pass:true,checks},null,2))
}catch(error){await writeFile('.build/evidence/startup-shell-failure.txt',String(error)+'\n'+diagnostics.slice(-2000));throw error}finally{await browser?.close();if(!ended)child.kill('SIGINT');await closed}
