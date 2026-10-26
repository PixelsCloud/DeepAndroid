import {test} from 'node:test'
import assert from 'node:assert/strict'
import {parseDeviceState,parseAppInfo,viewUri,parseActivityStart} from '../dist/device-state.js'
import {quoteAndroidArg} from '../dist/android-shell.js'
import {DeviceService} from '../dist/device.js'

test('diagnostics distinguish resumed app, dialog focus, actual keyboard state, keyguard and validated active transport',()=>{
 const value=parseDeviceState({activity:'topResumedActivity=ActivityRecord{abc u0 com.example.reader/.Main t1}',window:'mCurrentFocus=null\nmCurrentFocus=Window{a u0 com.android.permissioncontroller/.Grant}\nKeyguardServiceDelegate\n  showing=false\n',input:'mInputShown=false\nmIsInputViewShown=true',power:'mWakefulness=Awake',display:'mCurrentOrientation=1',battery:'level: 50\nscale: 100\nstatus: 2\ntemperature: 0',connectivity:'Active default network: 171\nNetworkAgentInfo{network{100} ni{MOBILE CONNECTED} nc{[ Transports: CELLULAR Capabilities: INTERNET&VALIDATED LinkUpBandwidth=1]}}\nNetworkAgentInfo{network{171} ni{WIFI CONNECTED} nc{[ Transports: WIFI Capabilities: INTERNET&VALIDATED LinkUpBandwidth=1]}}'})
 assert.equal(value.foreground.package_name,'com.example.reader');assert.equal(value.focused_window.package_name,'com.android.permissioncontroller');assert.equal(value.keyboard.shown,false);assert.equal(value.screen.keyguard_showing,false);assert.equal(value.screen.orientation,'landscape');assert.equal(value.screen.physical_power,null);assert.equal(value.battery.percent,50);assert.equal(value.battery.temperature_celsius,0);assert.deepEqual(value.network.transports,['WIFI']);assert.equal(value.network.validated,true)
})
test('missing and vendor diagnostic fields stay unknown, while explicit disconnection and sleep stay false',()=>{
 const unknown=parseDeviceState({});assert.equal(unknown.foreground,null);assert.equal(unknown.keyboard.shown,null);assert.equal(unknown.screen.interactive,null);assert.equal(unknown.screen.keyguard_showing,null);assert.equal(unknown.network.connected,null)
 const offline=parseDeviceState({power:'mWakefulness=Asleep',connectivity:'Active default network: none'});assert.equal(offline.screen.interactive,false);assert.equal(offline.network.connected,false)
 const dreaming=parseDeviceState({power:'mWakefulness=Dreaming'});assert.equal(dreaming.screen.interactive,true)
})
test('package parsing selects the exact package and Android user without truncating a large version code',()=>{
 const raw='Package [com.example.app] (1):\n appId=12345\n versionCode=9007199254740993 minSdk=26 targetSdk=34\n versionName=1.2.3\n pkgFlags=[ HAS_CODE SYSTEM ]\n installerPackageName=null\n User 0: installed=true hidden=false suspended=false stopped=false enabled=0\n firstInstallTime=2020-01-01 00:00:00\n User 10: installed=true hidden=false suspended=true stopped=true enabled=3\n firstInstallTime=2025-01-01 00:00:00\nPackage [com.other.app] (2):\n versionName=other'
 const app=parseAppInfo(raw,'com.example.app',10);assert.equal(app.status,'installed');assert.equal(app.version_code,'9007199254740993');assert.equal(app.version_name,'1.2.3');assert.equal(app.uid,1012345);assert.equal(app.enabled,false);assert.equal(app.stopped,true);assert.equal(app.suspended,true);assert.equal(app.system,true);assert.equal(app.installer,null);assert.equal(app.first_install_time,'2025-01-01 00:00:00')
 assert.equal(parseAppInfo(raw,'com.example.app',12).status,'unconfirmed');assert.equal(parseAppInfo('Unable to find package: com.missing.app','com.missing.app',0).status,'not_installed');assert.equal(parseAppInfo('unrecognized vendor output','com.example.app',0).status,'unconfirmed')
})
test('URI validation preserves literal query text, quotes it for the Android shell and rejects unsupported executable/file inputs',()=>{
 const uri="https://example.test/p?q=a'&token=$HOME;echo",checked=viewUri(uri);assert.equal(checked.uri,uri);assert.equal(checked.action,'android.intent.action.VIEW');assert.equal(viewUri('package:com.example.app').action,'android.settings.APPLICATION_DETAILS_SETTINGS');assert.equal(viewUri('zhihu://questions/123').uri,'zhihu://questions/123');assert.equal(quoteAndroidArg("a'b$();"),"'a'\\''b$();'")
 for(const value of ['javascript:alert(1)','file:///sdcard/secret','content://provider/key','intent://target','data:text/html,test','https://user:pass@example.test','https://example.test/has space','https://example.test/\nanything','package:bad;command'])assert.throws(()=>viewUri(value),value)
})
test('Android launch acknowledgements are separate from missing handlers, permission failures and unknown outcomes',()=>{
 const sent=parseActivityStart('Status: ok\nActivity: com.example.app/.Main\nTotalTime: 23\nWaitTime: 25\nComplete');assert.equal(sent.status,'sent');assert.equal(sent.activity,'com.example.app/.Main');assert.equal(sent.total_time_ms,23)
 assert.equal(parseActivityStart('Error: Activity not started, unable to resolve Intent').status,'failed');assert.equal(parseActivityStart('Permission Denial: blocked').status,'failed');assert.equal(parseActivityStart('unexpected output').status,'unconfirmed')
})
test('stop targets the captured Android user and does not confirm success using another profile after a user switch',async()=>{
 const device=new DeviceService(),calls=[];let queried=0
 device.appInfo=async()=>({status:'installed',user_id:queried++===0?0:10,stopped:queried>1})
 device.shell=async(_serial,args)=>{calls.push(args);return''}
 const result=await device.stopApp('fixture','com.example.app',new AbortController().signal)
 assert.deepEqual(calls,[['am','force-stop','--user','0','com.example.app']]);assert.equal(result.status,'unconfirmed');assert.equal(result.user_id,0)
})
