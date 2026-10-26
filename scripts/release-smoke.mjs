import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, realpath, writeFile, mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
const run=promisify(execFile),profile=process.argv[2]
assert(profile&&/^[a-z0-9_-]+$/i.test(profile),'Pass the already-installed isolated acceptance profile name')
const harnessHome=process.env.DSH_HOME||join(process.env.USERPROFILE,'.dsh'),profileDir=join(harnessHome,'profiles',profile)
const pluginDir=await realpath(join(profileDir,'node_modules','dsh-android'))
assert(!pluginDir.toLowerCase().startsWith(resolve('.').toLowerCase()),'Installed package must be outside the development workspace')
const expectedVersion=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version
const manifest=JSON.parse(await readFile(join(pluginDir,'package.json'),'utf8'));assert.equal(manifest.version,expectedVersion)
for(const file of ['dist/ui.js','dist/host.js'])assert.deepEqual(await readFile(join(pluginDir,file)),await readFile(file),'Installed artifact differs: '+file)
await mkdir('.build/tests',{recursive:true});const dataDir=await mkdtemp(join(resolve('.build/tests'),'installed-release-'))
const doctor=JSON.parse((await run(process.execPath,[join(pluginDir,'bin','doctor.mjs'),'--json'],{cwd:profileDir,windowsHide:true,timeout:30000})).stdout)
assert.equal(doctor.ok,true);assert(doctor.adb.path.endsWith('adb.exe'))
const app=join(process.env.LOCALAPPDATA,'Programs','DeepSeek Harness')
const child=spawn(join(app,'DeepSeek Harness.exe'),['--expose-internals',join(app,'resources','app.asar','dsh','node_modules','@deepseek-ai','dsh-desktop-host','lib','cli.js'),'--profile',profile,'--no-open','--port','0'],{cwd:profileDir,windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',DSH_ANDROID_DATA_DIR:dataDir}})
let output='',diagnostics='',browser
child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>diagnostics+=data)
const closed=new Promise(resolve=>child.once('close',code=>resolve(code)))
let ended=false;closed.then(()=>ended=true)
try {
  let launch
  for(let i=0;i<300;i++){
    launch=output.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+[^\s\u001b]*/)?.[0]
    if(launch)break
    if(ended)throw new Error('Isolated Harness exited before serving: '+diagnostics.slice(-2000))
    await new Promise(resolve=>setTimeout(resolve,100))
  }
  assert(launch,'No launch URL was emitted by the isolated Harness')
  const origin=new URL(launch).origin,headers={'x-android-client':'1'}
  let health
  for(let i=0;i<100;i++){
    const response=await fetch(origin+'/x-android/health',{headers})
    if(response.ok){health=await response.json();break}
    await new Promise(resolve=>setTimeout(resolve,100))
  }
  assert.equal(health?.pluginVersion,expectedVersion);assert.equal(health.nativeTools.length,44)
  const diagnosis=await(await fetch(origin+'/x-android/doctor',{headers})).json();assert.equal(diagnosis.ok,true)
  const templates=await(await fetch(origin+'/x-android/templates',{headers})).json();assert(templates.templates.length>=3)
  browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true})
  const page=await browser.newPage({viewport:{width:480,height:1100}}),errors=[];page.on('pageerror',error=>errors.push(error.message))
  // Exchange the CLI's own launch token normally, then mount only the installed panel for isolated visual QA.
  await page.goto(launch)
  // Leave the Harness shell before the standalone fixture so its modal/focus handlers cannot affect this page.
  await page.goto(origin+'/x-android/health')
  await page.setContent('<!doctype html><style>body{margin:0;background:#15191e;color:white}#root{height:100vh;max-width:480px;margin:auto}</style><div id="root"></div><script type="module">import{mountPanel}from"/x-android/ui.js";window.disposePanel=mountPanel(document.getElementById("root"))</script>')
  await page.waitForFunction(()=>document.querySelector('.android-video canvas')&&Number(document.querySelector('#root')?.dataset.framesRendered)>0,null,{timeout:25000})
  await mkdir('.build/evidence',{recursive:true});await page.screenshot({path:'.build/evidence/release-installed-panel.png'})
  const state=await(await fetch(origin+'/x-android/health',{headers})).json();assert.equal(state.state,'streaming')
  await page.getByRole('button',{name:'断开',exact:true}).click();await page.getByRole('status').filter({hasText:'已断开'}).waitFor()
  assert.deepEqual(errors,[])
  const evidence={pass:true,profile,pluginDir,version:manifest.version,standaloneDoctor:doctor,registeredTools:health.nativeTools,video:{width:state.width,height:state.height,packets:state.packets},templates:templates.templates.map(item=>item.title),errors,notes:'Archive installation and runtime use the isolated profile on C:, with no source-directory link or runtime-compatibility exemption.'}
  await writeFile('.build/evidence/release-smoke.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2))
} catch(error) {
  await mkdir('.build/evidence',{recursive:true});await writeFile('.build/evidence/release-failure.txt',String(error)+'\n'+diagnostics.slice(-5000));throw error
} finally {await browser?.close();if(!ended)child.kill('SIGINT');await closed}
