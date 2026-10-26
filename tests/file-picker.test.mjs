import{test}from'node:test'
import assert from'node:assert/strict'
import{pickFile,pickerActive,parsePicker}from'../dist/file-picker.js'
import{AndroidRuntime}from'../dist/runtime.js'
const pkg='com.google.android.documentsui',active={foreground:{package_name:pkg,activity:'com.android.documentsui.picker.PickActivity'},focused_window:{package_name:pkg}},caller={foreground:{package_name:'com.android.chrome',activity:'Main'},focused_window:{package_name:'com.android.chrome'}}
const attr=value=>value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;')
function xml(names=['fixture.png'],options={}){return`<hierarchy><node package="${pkg}" resource-id="${pkg}:id/dir_list" scrollable="${options.scrollable===true}" bounds="[0,200][1000,2000]">${names.map((name,index)=>`<node package="${pkg}" selected="${options.selected===true}"><node package="${pkg}" text="${attr(name)}" enabled="${options.enabled!==false}" resource-id="android:id/title" bounds="[100,${300+index*150}][800,${400+index*150}]"/></node>`).join('')}</node>${options.search?`<node package="${pkg}" resource-id="${pkg}:id/option_menu_search" clickable="true" bounds="[800,80][940,200]"/>`:''}${options.input?`<node package="${pkg}" resource-id="android:id/search_src_text" class="android.widget.EditText" focused="true" bounds="[100,80][700,200]"/>`:''}${options.confirm?`<node package="${pkg}" resource-id="${pkg}:id/action_menu_select" bounds="[800,80][940,200]"/>`:''}</hierarchy>`}
function fixture(views=[xml(),xml([])],states=[active,caller]){let index=-1;const pressed=[],typed=[];return{pressed,typed,signal:AbortSignal.timeout(10000),async capture(){index++;return{xml:views[Math.min(index,views.length-1)],png:Buffer.alloc(0),observation:{observation_id:String(index),width:1080,height:2400,tree_error:null,tree_truncated:false}}},async state(){return states[Math.min(index,states.length-1)]},async press(capture,target){pressed.push({capture,target})},async type(_c,text){typed.push(text)}}}
test('file-manager lookalikes and another focused window are not treated as a file picker',async()=>{
 assert.equal(pickerActive({...active,foreground:{...active.foreground,activity:'com.android.documentsui.files.FilesActivity'}}),false);const driver=fixture([xml()],[{...active,focused_window:{package_name:'com.other.overlay'}}]);const result=await pickFile(driver,{action:'select',file_name:'fixture.png'});assert.equal(result.status,'not_picker');assert.equal(driver.pressed.length,0)
})
test('inspect returns visible names and never taps or claims attachment confirmation',async()=>{
 const driver=fixture([xml(['照片.png'])],[active]),result=await pickFile(driver,{});assert.equal(result.status,'inspected');assert.equal(result.entries[0].name,'照片.png');assert.equal(result.attachment_confirmed,false);assert.equal(driver.pressed.length,0)
})
test('a unique exact Unicode/literal name is clicked once; caller return does not prove upload or attachment',async()=>{
 const name="图片 ' $ & #%20.png",driver=fixture([xml([name]),xml([])]),result=await pickFile(driver,{action:'select',file_name:name,expected_caller_package:'com.android.chrome'});assert.equal(result.status,'selection_requested');assert.equal(result.picker_closed,true);assert.equal(result.expected_caller_matched,true);assert.equal(result.attachment_confirmed,false);assert.equal(result.upload_performed,false);assert.equal(driver.pressed.length,1)
})
test('duplicate names, pre-existing selections, disabled rows and scrollable hidden results prevent a selection',async()=>{
 for(const[view,status]of [[xml(['fixture.png','fixture.png']),'ambiguous'],[xml(['fixture.png'],{selected:true}),'existing_selection'],[xml(['fixture.png'],{enabled:false}),'not_selectable'],[xml(['fixture.png'],{scrollable:true}),'needs_navigation'],[xml(['fixture.png.extra']),'not_found']]){const driver=fixture([view],[active]);assert.equal((await pickFile(driver,{action:'select',file_name:'fixture.png'})).status,status);assert.equal(driver.pressed.length,0)}
})
test('single tap in multi-select mode never auto-confirms or adds another file',async()=>{
 const driver=fixture([xml(),xml(['fixture.png'],{selected:true,confirm:true})],[active,active]),result=await pickFile(driver,{action:'select',file_name:'fixture.png'});assert.equal(result.awaiting_confirmation,true);assert.equal(result.picker_closed,false);assert.equal(driver.pressed.length,1)
})
test('search uses only a recognized focused search field and stops after context changes',async()=>{
 const driver=fixture([xml([],{search:true}),xml([],{input:true}),xml(),xml([])],[active,active,active,caller]),result=await pickFile(driver,{action:'select',file_name:'fixture.png',search:true});assert.equal(result.status,'selection_requested');assert.deepEqual(driver.typed,['fixture.png']);assert.equal(driver.pressed.length,2)
 const changed=fixture([xml([],{search:true}),xml([])],[active,caller]);assert.equal((await pickFile(changed,{action:'select',file_name:'fixture.png',search:true})).status,'context_changed');assert.equal(changed.typed.length,0)
})
test('invalid names fail before capture; unsafe XML fails closed rather than using entity text',async()=>{
 await assert.rejects(pickFile({capture(){assert.fail('capture must not run')}},{action:'select',file_name:'/sdcard/a.png'}),/file_name/);assert.throws(()=>parsePicker('<!DOCTYPE x><hierarchy/>',1080,2400,pkg),/结构无效/)
})
test('a selected row checkbox or action-mode toolbar blocks adding a file even when its title is not marked selected',async()=>{
 for(const view of [xml().replace('</hierarchy>',`<node package="${pkg}" resource-id="android:id/action_mode_close_button" bounds="[0,80][100,200]"/></hierarchy>`),xml().replace('</node></node>',`<node package="${pkg}" checked="true" bounds="[0,300][100,400]"/></node></node>`)]){const driver=fixture([view],[active]);assert.equal((await pickFile(driver,{action:'select',file_name:'fixture.png'})).status,'existing_selection');assert.equal(driver.pressed.length,0)}
})
test('runtime picker maps fresh screenshot coordinates, consumes the observation and keeps raw XML internal',async()=>{
 const commands=[],png=Buffer.alloc(24);Buffer.from('89504e470d0a1a0a','hex').copy(png);png.writeUInt32BE(1080,16);png.writeUInt32BE(2400,20);let finish,clicked=false
 const video={input:{geometry:{width:540,height:1200,epoch:1},async send(value){commands.push(value);if(value.phase==='up')clicked=true}},async read(){return new Promise(resolve=>finish=()=>resolve({done:true}))},async close(){finish?.()}},backend={async list(){return[{serial:'phone',state:'device'}]},async open(){return video},async dumpUi(){return clicked?xml([]):xml()},async screenshot(){return png},async deviceState(){return clicked?caller:active}},runtime=new AndroidRuntime(backend)
 try{const before=await runtime.observe('session',AbortSignal.timeout(10000));assert(!('xml'in before));const result=await runtime.pickFile('session',{action:'select',file_name:'fixture.png'},AbortSignal.timeout(10000));assert.equal(result.picker_closed,true);assert.equal(commands.find(c=>c.phase==='down').x,225);assert.equal(commands.find(c=>c.phase==='down').y,175);await assert.rejects(runtime.tap('session',before.observation.observation_id,{x:1,y:1},AbortSignal.timeout(10000)),/失效/)}finally{await runtime.close()}
})
