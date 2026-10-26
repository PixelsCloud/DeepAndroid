import{test}from'node:test'
import assert from'node:assert/strict'
import{setTimeout as delay}from'node:timers/promises'
import{notificationKey,parseNotificationKeys,parseNotification,readNotifications}from'../dist/notifications.js'
import{normalizedActivity,parseForeground,waitApp,waitNotification}from'../dist/event-waits.js'
import{AndroidRuntime}from'../dist/runtime.js'
import{TaskLedger}from'../dist/tasks.js'
const signal=()=>AbortSignal.timeout(10000),key='0|com.example.app|7|fixture|10123'
function record(k=key,title='导出完成',body="已保存 ' $ &\n第二行",updated=200){const id=notificationKey(k);return`NotificationRecord(0x123: pkg=${id.package_name} user=UserHandle{${id.user_id}} id=${id.id} tag=fixture importance=3 key=${k} bbbc=0: Notification())\n  uid=10123 userId=${id.user_id}\n  flags=0x0\n  key=${k}\n  notification=\n    when=90\n    extras={\n        android.title=String (${title})\n        android.text=String (${body})\n        android.appInfo=ApplicationInfo (app)\n    }\n  publicNotification=\n    None\n  mCreationTimeMs=100\n  mUpdateTimeMs=${updated}\n  mVisibleSinceMs=0\n`}
const item=(fingerprint='old')=>({...parseNotification(record(),key),fingerprint})
const page=(items=[item()],extra={})=>({status:'listed',serial:'phone',user_id:0,captured_at:new Date().toISOString(),items,scanned_count:items.length,scope_total:items.length,next_offset:null,exhaustive:true,unavailable:[],...extra})
const front=(activity='com.example.app.Main',focus='com.example.app')=>({status:'read',serial:'phone',user_id:0,captured_at:new Date().toISOString(),foreground:{package_name:'com.example.app',activity},focused_window:focus?{package_name:focus,activity}:null,keyguard_showing:false})
test('notification keys retain opaque tag/group suffixes while validating user/package identity',()=>{
 for(const k of [key,'-1|android|2147483647|null|1000|ranker_group','0|com.example.app|8|a|b|10123'])assert.equal(notificationKey(k).key,k)
 assert.deepEqual(parseNotificationKeys(''),[]);assert.equal(parseNotificationKeys(key+'\r\n').length,1);for(const text of [key+'\n'+key,'Permission Denial: denied',key+'\nnot-a-key'])assert.throws(()=>parseNotificationKeys(text));assert.throws(()=>notificationKey(key+'\ncmd'))
})
test('notification parser preserves literal multiline content and fingerprints ignore volatile visibility diagnostics',()=>{
 const first=parseNotification(record(),key);assert.equal(first.title,'导出完成');assert.equal(first.text,"已保存 ' $ &\n第二行");assert.equal(first.big_text,null);assert.equal(first.created_time_ms,100);assert.equal(first.updated_time_ms,200);assert.equal(first.when_ms,90)
 assert.equal(parseNotification(record().replace('mVisibleSinceMs=0','mVisibleSinceMs=900'),key).fingerprint,first.fingerprint);assert.notEqual(parseNotification(record(key,'导出完成','更新',201),key).fingerprint,first.fingerprint)
})
test('redaction, duplicate diagnostic fields and mismatching record identities never become trusted values',()=>{
 assert.equal(parseNotification(record(key,'[redacted]'),key).title,null);assert.throws(()=>parseNotification(record('10|com.example.app|7|fixture|1010123'),key),/身份/)
 const spoof=record().replace('        android.text=', '        android.title=String (假标题)\n        android.text=');assert.equal(parseNotification(spoof,key).title,null)
 const time=record().replace('  mCreationTimeMs=100','  mCreationTimeMs=999\n  mCreationTimeMs=100');assert.equal(parseNotification(time,key).created_time_ms,null)
})
test('normal reads scope by current user and exact package before fetching content; literal matching is not regex',async()=>{
 const other='10|com.example.app|7|other|1010123',unrelated='0|com.other.app|1|null|10124',calls=[];const device={async runShell(_s,args){calls.push(args);if(args[0]==='am')return'0';if(args[2].includes("'list'"))return[key,other,unrelated].join('\n')+'\n';return record(key,'标题','完成 [a.*]')}}
 const result=await readNotifications(device,'phone',{package_name:'com.example.app',text_contains:'[A.*]'},signal());assert.equal(result.items.length,1);assert.equal(result.scope_total,1);assert.equal(result.scanned_count,1);assert.equal(calls.filter(args=>args[2]?.includes("'get'")).length,1);assert(!calls.some(args=>args[2]?.includes(other)));assert.equal(result.items[0].text,'完成 [a.*]')
})
test('unavailable notification interface and an actually empty active list are distinct',async()=>{
 const device={async runShell(_s,args){return args[0]==='am'?'0':'usage: cmd notification unsupported'}};assert.equal((await readNotifications(device,'phone',{},signal())).status,'unavailable');device.runShell=async(_s,args)=>args[0]==='am'?'0':'';const empty=await readNotifications(device,'phone',{},signal());assert.equal(empty.status,'listed');assert.equal(empty.scope_total,0);assert.equal(empty.exhaustive,true)
})
test('notification reads discard data after a user switch; withdrawn details remain partial instead of absent',async()=>{
 let users=0;const device={async runShell(_s,args){if(args[0]==='am')return ++users===1?'0':'10';return args[2].includes("'list'")?key+'\n':record()}};const changed=await readNotifications(device,'phone',{},signal());assert.equal(changed.status,'unavailable');assert.equal(changed.items.length,0)
 device.runShell=async(_s,args)=>args[0]==='am'?'0':args[2].includes("'list'")?key+'\n':'error: no active notification matching key';const withdrawn=await readNotifications(device,'phone',{},signal());assert.equal(withdrawn.status,'partial');assert.equal(withdrawn.items.length,0);assert.equal(withdrawn.unavailable.length,1)
})
test('notification error-looking body lines are data, while CLI permission errors are unavailable',async()=>{
 const device={async runDiagnostic(_s,args){return args[0]==='am'?'0':args[2].includes("'list'")?key+'\n':record(key,'处理失败','Error: 这是应用的通知正文')},runShell(){assert.fail('must not apply generic shell error heuristics to notification text')}};const value=await readNotifications(device,'phone',{},signal());assert.equal(value.items[0].text,'Error: 这是应用的通知正文');device.runDiagnostic=async()=>{throw Object.assign(new Error('Command failed'),{stdout:'Permission Denial: denied'})};assert.equal((await readNotifications(device,'phone',{},signal())).status,'unavailable')
})
test('notification scans expose offsets so nonmatching pages are not mistaken for an exhaustive search',async()=>{
 const second='0|com.example.app|8|other|10123',device={async runShell(_s,args){if(args[0]==='am')return'0';return args[2].includes("'list'")?key+'\n'+second+'\n':record()}};const result=await readNotifications(device,'phone',{limit:1,text_contains:'not there'},signal());assert.equal(result.items.length,0);assert.equal(result.next_offset,1);assert.equal(result.exhaustive,false)
})
test('hidden text remains partial even after keyword filtering removes all matched items',async()=>{
 const device={async runShell(_s,args){if(args[0]==='am')return'0';return args[2].includes("'list'")?key+'\n':record(key,'[redacted]','[redacted]')}};const result=await readNotifications(device,'phone',{text_contains:'完成'},signal());assert.equal(result.items.length,0);assert.equal(result.status,'partial');assert.equal(result.unreadable_text_count,1)
})
test('notification waits exclude unchanged baseline and accept a same-key update without claiming business completion',async()=>{
 let count=0;const result=await waitNotification(async()=>page([item(++count<3?'old':'new')]),{package_name:'com.example.app',timeout_ms:3000,poll_ms:500},signal());assert.equal(result.status,'matched');assert.equal(result.notification.fingerprint,'new');assert.equal(result.completion_confirmed,false);assert.equal(result.baseline_count,1);assert(result.attempts>=3)
 assert.equal((await waitNotification(async()=>page(),{package_name:'com.example.app',new_only:false},signal())).status,'matched')
})
test('keyword waits baseline all scoped records before matching a later update',async()=>{
 let count=0;const result=await waitNotification(async query=>{assert.equal(query.text_contains,undefined);const notification={...item(++count===1?'old':'updated'),title:'export',text:count===1?'working':'done'};return page([notification])},{package_name:'com.example.app',text_contains:'DONE',poll_ms:500,timeout_ms:2000},signal());assert.equal(result.status,'matched');assert.equal(result.baseline_count,1);assert.equal(result.notification.text,'done')
})
test('incomplete baseline returns unavailable and existing unchanged notices time out',async()=>{
 const incomplete=await waitNotification(async()=>page([],{unavailable:[{key,reason:'not readable'}]}),{package_name:'com.example.app'},signal());assert.equal(incomplete.status,'unavailable')
 const timeout=await waitNotification(async()=>page(),{package_name:'com.example.app',timeout_ms:500,poll_ms:500},signal());assert.equal(timeout.status,'timed_out');assert.equal(timeout.baseline_count,1)
})
test('a provided pre-action baseline detects a fast update already present when the wait begins',async()=>{
 const old='a'.repeat(64),updated='b'.repeat(64);const result=await waitNotification(async()=>page([item(updated)]),{package_name:'com.example.app',baseline_user_id:0,baseline_fingerprints:[old],timeout_ms:1000},signal());assert.equal(result.status,'matched');assert.equal(result.baseline_source,'provided');assert.equal(result.attempts,1);assert.equal(result.baseline_captured_at,null)
})
test('provided baseline values must be actual-shaped fingerprints and cannot be silently ignored',async()=>{
 const read=()=>assert.fail('must validate first');await assert.rejects(waitNotification(read,{package_name:'com.example.app',baseline_user_id:0,baseline_fingerprints:['made up']},signal()),/baseline/);await assert.rejects(waitNotification(read,{package_name:'com.example.app',baseline_user_id:0,baseline_fingerprints:[],new_only:false},signal()),/baseline/)
 const changed=await waitNotification(async()=>page([item()],{user_id:10}),{package_name:'com.example.app',baseline_user_id:0,baseline_fingerprints:['a'.repeat(64)]},signal());assert.equal(changed.status,'unavailable');assert.equal(changed.last_query,null)
})
test('notification waits propagate cancellation and transport failures, and stop on a user change',async()=>{
 const abort=new AbortController(),pending=waitNotification(async()=>page(),{package_name:'com.example.app'},abort.signal),failure=assert.rejects(pending,/user stop/);abort.abort(new Error('user stop'));await failure
 await assert.rejects(waitNotification(async()=>{throw Error('device offline')},{package_name:'com.example.app'},signal()),/offline/);let n=0;assert.equal((await waitNotification(async()=>page([],{user_id:++n===1?0:10}),{package_name:'com.example.app',timeout_ms:2000,poll_ms:500},signal())).status,'unavailable')
})
test('foreground parsing prefers current-user top resumed activity and treats ambiguous displays or another focus as unknown',()=>{
 const text='mResumedActivity: ActivityRecord{x u0 com.old.app/.Main t1}\n topResumedActivity=ActivityRecord{x u0 com.example.app/.Main t2}',window='mCurrentFocus=Window{x u0 com.example.app/.Main}'
 const value=parseForeground(text,window,0);assert.equal(value.foreground.activity,'com.example.app.Main');assert.equal(value.focused_window.package_name,'com.example.app');assert.equal(parseForeground(text+'\n topResumedActivity=ActivityRecord{x u0 com.other.app/.Main t3}',window,0).foreground,null);assert.equal(parseForeground(text,window,10).foreground,null)
 assert.equal(normalizedActivity('com.example.app','com.example.app/.Main'),'com.example.app.Main');assert.throws(()=>normalizedActivity('com.example.app','com.other.app/.Main'));assert.throws(()=>normalizedActivity('com.example.app','Main;cmd'))
})
test('app waits reset stability when activity changes, require focus, and never claim content ready',async()=>{
 let n=0;const result=await waitApp(async()=>front(++n===1?'com.example.app.Splash':'com.example.app.Main'),{package_name:'com.example.app',stable_ms:500,timeout_ms:3000,poll_ms:500},signal());assert.equal(result.status,'matched');assert(result.attempts>=3);assert.equal(result.content_ready_confirmed,false)
 const blocked=await waitApp(async()=>front('com.example.app.Main','com.other.dialog'),{package_name:'com.example.app',timeout_ms:500,poll_ms:500,stable_ms:0},signal());assert.equal(blocked.status,'timed_out');assert.equal((await waitApp(async()=>front('com.example.app.Main',null),{package_name:'com.example.app',require_focus:false,stable_ms:0},signal())).status,'matched')
})
test('app waits match exact normalized activity, reject keyguard, and expose unknown last state on timeout',async()=>{
 const exact=await waitApp(async()=>front(),{package_name:'com.example.app',activity:'.Main',stable_ms:0},signal());assert.equal(exact.status,'matched')
 const locked=await waitApp(async()=>({...front(),keyguard_showing:true}),{package_name:'com.example.app',timeout_ms:500,stable_ms:0},signal());assert.equal(locked.status,'timed_out');const unknown=await waitApp(async()=>({...front(),foreground:null,status:'unconfirmed'}),{package_name:'com.example.app',timeout_ms:500,stable_ms:0},signal());assert.equal(unknown.last_state.foreground,null)
})
test('new event waits use no video transport and session end/disconnect immediately cancel their polling',async()=>{
 const backend={async list(){return[{serial:'phone',state:'device'}]},async open(){assert.fail('read-only event waits must not open video')},async foregroundState(){return{...front(),foreground:null,status:'unconfirmed'}},async notifications(){return page([])}},runtime=new AndroidRuntime(backend)
 try{const first=runtime.waitApp('one',{package_name:'com.example.app'},signal()),rejected=assert.rejects(first,/任务已结束/);await delay(10);await runtime.endSession('one');await rejected;const second=runtime.waitNotification('two',{package_name:'com.example.app'},signal()),stopped=assert.rejects(second,/断开/);await delay(10);await runtime.disconnect();await stopped;assert.equal(runtime.state.owner,null)}finally{await runtime.close()}
})
test('invalid wait inputs fail before reading a backend',async()=>{
 const read=()=>assert.fail('must validate before read');await assert.rejects(waitApp(read,{package_name:'bad;cmd'},signal()));await assert.rejects(waitApp(read,{package_name:'com.example.app',stable_ms:2000,timeout_ms:1000},signal()));await assert.rejects(waitNotification(read,{},signal()));await assert.rejects(waitNotification(read,{package_name:'com.example.app',poll_ms:5},signal()))
})
test('app timeout bounds a backend read that never settles after abort', {timeout:2000},async()=>{
 const start=performance.now(),result=await waitApp(async()=>new Promise(()=>{}),{package_name:'com.example.app',timeout_ms:500},signal());assert.equal(result.status,'timed_out');assert(result.elapsed_ms>=450&&performance.now()-start<1500);assert.equal(result.last_state,null)
})
test('notification timeout bounds a backend read that never settles after abort', {timeout:2000},async()=>{
 const start=performance.now(),result=await waitNotification(async()=>new Promise(()=>{}),{package_name:'com.example.app',timeout_ms:500},signal());assert.equal(result.status,'timed_out');assert(result.elapsed_ms>=450&&performance.now()-start<1500);assert.equal(result.last_query,null)
})
test('notification search text and opaque keys are omitted from persisted task inputs',async()=>{
 const ledger=new TaskLedger();try{ledger.begin('privacy','call','android_notifications',{package_name:'com.example.app',text_contains:'private keyword',notification_key:key});const input=ledger.recent()[0].operations[0].input;assert.equal(input.text_contains_length,15);assert.equal(input.notification_key_length,key.length);assert(!JSON.stringify(input).includes('private keyword'));assert(!JSON.stringify(input).includes(key))}finally{await ledger.close()}
})
