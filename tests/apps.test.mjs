import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseApps, resolveApp, appMatches } from '../dist/apps.js'
import { matchTargets, validateTarget } from '../dist/targets.js'
const row=(flag,name,pkg)=>` ${flag} ${name.length<30?name.padEnd(30)+' '+pkg:name+'\n'+' '.repeat(34)+pkg}`
test('scrcpy inventory preserves localized names, wrapped labels, system flags and package identity',()=>{
  const long='A'.repeat(32)+'中文应用😀'
  const apps=parseApps('[server] INFO: List of apps:\n'+[row('*','设置','com.android.settings'),row('-','Chrome','com.android.chrome'),row('-',long,'com.example.long')].join('\r\n'))
  assert.equal(apps.length,3);assert.deepEqual(apps.find(a=>a.name==='设置'),{name:'设置',package_name:'com.android.settings',system:true})
  assert.equal(apps.find(a=>a.package_name==='com.example.long').name,long)
  assert.throws(()=>parseApps('permission denied'),/有效/)
})
test('names resolve only with one exact match; ambiguous and substring matches never launch by default',()=>{
  const apps=[{name:'设置',package_name:'com.android.settings',system:true},{name:'设置助手',package_name:'com.example.helper',system:false},{name:'Chrome',package_name:'com.android.chrome',system:false}]
  assert.equal(resolveApp(apps,' 设置 ').app.package_name,'com.android.settings')
  assert.equal(resolveApp(apps,'ＣＨＲＯＭＥ').status,'resolved')
  const missing=resolveApp(apps,'助手');assert.equal(missing.status,'not_found');assert.equal(missing.candidates.length,1)
  const duplicate=resolveApp([...apps,{name:'设置',package_name:'com.example.settings',system:false}],'设置')
  assert.equal(duplicate.status,'ambiguous');assert.equal(duplicate.candidates.length,2)
  assert.throws(()=>resolveApp(apps,'  '),/长度/)
  assert(appMatches(apps[0],'ANDROID.SETTINGS'))
})
test('visible target filters use literal text, conjunctive identity fields, and optional editable state',()=>{
  const elements=[{text:'省电与电池',description:'',resource_id:'id/a',class_name:'TextView',package_name:'settings',editable:false},{text:'电池',description:'输入',resource_id:'id/b',class_name:'EditText',package_name:'settings',editable:true}]
  assert.equal(matchTargets(elements,{text:'电池'}).length,2)
  assert.deepEqual(matchTargets(elements,{text:'电池',editable:false,package_name:'settings'}),[elements[0]])
  assert.deepEqual(matchTargets(elements,{text:'电池',exact:true}),[elements[1]])
  assert.deepEqual(matchTargets(elements,{text:'.*'}),[])
  assert.deepEqual(matchTargets(elements,{resource_id:'id/b',class_name:'TextView'}),[])
  assert.throws(()=>validateTarget({}),/提供/);assert.throws(()=>validateTarget({text:' '}),/提供|长度/)
})
