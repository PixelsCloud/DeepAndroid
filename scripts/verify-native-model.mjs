import { readFile, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const lines=(await readFile(process.argv[2]??'.build/evidence/native-model-task.jsonl','utf8')).split('\n').filter(Boolean)
const events=lines.filter(line=>line.startsWith('{')).map(JSON.parse)
const calls=events.filter(event=>event.type==='tool_call'), results=events.filter(event=>event.type==='tool_result')
assert(calls.length>=10);assert(calls.every(call=>call.tool.startsWith('android_')))
assert.equal(calls.length,results.length);assert(results.every(result=>result.status==='completed'))
let latest='',used=new Set()
for(const event of events){
  if(event.type==='tool_result') {const id=event.result?.match?.(/^\{"observation_id":"([a-f0-9]+)"/);if(id)latest=id[1]}
  if(event.type==='tool_call'&&['android_tap','android_swipe','android_input_text'].includes(event.tool)) {assert.equal(event.input.observation_id,latest);assert(!used.has(latest));used.add(latest)}
}
assert(calls.some(c=>c.tool==='android_key'&&c.input.key==='home'))
assert.equal(calls.at(-1).tool,'android_release')
assert(results.some(r=>r.result.includes('Android 版本')&&r.result.includes('14 | Android')))
assert(results.some(r=>r.result.includes('com.miui.home')))
assert(results.some(r=>r.result.includes('"image_supported":true')&&r.result.includes('"screenshot":')))
assert(events.some(e=>e.type==='final'&&e.text.includes('14')))
const summary={pass:true,source:'Harness headless Agent + real DeepSeek model + real USB phone',sessionId:events.find(e=>e.type==='session')?.sessionId,calls:calls.length,tools:calls.map(c=>c.tool),allCallsCompleted:true,freshObservationForEveryGesture:true,imageAttachmentObserved:true,androidVersion:'14',homeObserved:true,released:true,sessionStreamResultPreviewLimit:'Harness headless truncates long result previews; original durable session retains complete content'}
await writeFile('.build/evidence/native-model-summary.json',JSON.stringify(summary,null,2));console.log(summary)
