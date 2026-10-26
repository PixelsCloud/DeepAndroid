import { DeviceService } from '../dist/device.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const run=promisify(execFile)
const adb=async(...args)=>(await run('adb',['-s','e2b3b128',...args],{encoding:'utf8',timeout:15000,windowsHide:true})).stdout
const top=async()=>((await adb('shell','dumpsys','activity','activities')).split('\n').filter(line=>/topResumedActivity|mResumedActivity/.test(line)).join('\n'))
async function waitTop(predicate){const end=Date.now()+5000;while(Date.now()<end){const value=await top();if(predicate(value))return value;await new Promise(r=>setTimeout(r,100))}throw new Error('Unexpected foreground activity')}
const abort=new AbortController(),service=new DeviceService()
const video=await service.open('e2b3b128',abort.signal)
const timeout=setTimeout(()=>abort.abort(),25000)
const pumping=(async()=>{try{while(!abort.signal.aborted){const r=await video.read();if(r.done)break}}catch(error){if(!abort.signal.aborted)throw error}})()
try{
  const checks=[]
  await video.input.send({kind:'key',key:'home'})
  await waitTop(text=>text.includes('com.miui.home'))
  checks.push({test:'Home returns to launcher',result:'pass'})
  await adb('shell','am','start','-a','android.settings.SETTINGS')
  await waitTop(text=>text.includes('com.android.settings'))
  const focusedUntil=Date.now()+5000
  while(Date.now()<focusedUntil){const w=await adb('shell','dumpsys','window');if(w.split('\n').some(line=>line.includes('mCurrentFocus=Window')&&line.includes('com.android.settings')))break;await new Promise(r=>setTimeout(r,100))}
  await new Promise(r=>setTimeout(r,500))
  await video.input.send({kind:'key',key:'back'})
  await waitTop(text=>!text.includes('com.android.settings'))
  checks.push({test:'Back exits Settings',result:'pass'})
  await video.input.send({kind:'key',key:'recent'})
  await adb('shell','uiautomator','dump','/data/local/tmp/dsh-android-recents.xml')
  const xml=await adb('shell','cat','/data/local/tmp/dsh-android-recents.xml')
  const overview=/recents|task_stack|clear_all|清理|全部清除|关闭所有/.test(xml)
  assert(overview,'Recents view must be observable')
  checks.push({test:'Recent tasks view',result:'pass'})
  await video.input.send({kind:'key',key:'home'})
  await waitTop(text=>text.includes('com.miui.home'))
  const report={timestamp:new Date().toISOString(),checks,final:'launcher'}
  await writeFile('.build/evidence/system-keys.json',JSON.stringify(report,null,2))
  console.log(JSON.stringify(report,null,2))
}finally{clearTimeout(timeout);abort.abort();await video.close();await pumping}
