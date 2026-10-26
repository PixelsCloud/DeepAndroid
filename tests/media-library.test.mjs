import{test}from'node:test'
import assert from'node:assert/strict'
import{parseMediaRows,parseMediaStrings,queryMedia,validateMediaQuery}from'../dist/media-library.js'
const signal=()=>AbortSignal.timeout(10000),row=(id,date=100)=>`Row: 0 _id=${id}, _size=123, date_modified=${date}, date_added=90, media_type=1, width=20, height=30, duration=NULL\n`
function strings(ids,name="图片 ', _data=wrong &%_.png"){return ids.flatMap(id=>['_display_name','_data','mime_type'].map(field=>id+':'+field+':'+Buffer.from('Row: 0 '+field+'='+({_display_name:name,_data:'/storage/emulated/0/Download/'+name,mime_type:'image/png'}[field])+'\n').toString('base64'))).join('\n')+'\n'}
test('media query rejects malformed bounds, cursors and controls before running any phone command',async()=>{
 for(const input of [{limit:0},{limit:21},{kind:'files'},{cursor:'1:2 OR 1=1'},{cursor:'9999999999999999999:1'},{directory:'/sdcard/../private'},{name_contains:'a\ncmd'},{modified_after:'not-a-date'}])assert.throws(()=>validateMediaQuery(input))
 await assert.rejects(queryMedia({runShell(){assert.fail('must validate first')}},'phone',{limit:100},signal()),/limit/)
})
test('numeric MediaStore output preserves large sizes and rejects errors instead of inventing an empty library',()=>{
 assert.equal(parseMediaRows(row('9007199254740993'),2)[0]._id,'9007199254740993');assert.deepEqual(parseMediaRows('No result found.\n',2),[])
 for(const text of ['', 'Error while accessing provider:media\nSecurityException',row('1').replace('_size=123','_size=bad'),row('1').replace('Row: 0','Row: 1')])assert.throws(()=>parseMediaRows(text,2))
})
test('base64 framed string columns cannot be spoofed by names containing column delimiters or newlines',()=>{
 const name="a, _data=/fake\nRow: 0 mime_type=bad.png",value=parseMediaStrings(strings(['12'],name),['12']).get('12');assert.equal(value._display_name,name);assert.equal(value._data,'/storage/emulated/0/Download/'+name);assert.equal(value.mime_type,'image/png')
 assert.throws(()=>parseMediaStrings(strings(['12']).replace('12:_data:','99:_data:'),['12']));assert.throws(()=>parseMediaStrings('12:_display_name:'+Buffer.from('Error accessing provider\n').toString('base64'),['12']))
})
test('query uses literal filters, phone-side bounded numeric output and an actual lookahead cursor',async()=>{
 const calls=[];let q=0;const device={async runShell(_serial,args){calls.push(args);if(args[0]==='am')return'0\n';if(args[0]==='readlink')return'/storage/emulated/0/Download\n';if(args[2].includes('head -n'))return row('20',200)+row('19',199).replace('Row: 0','Row: 1');q++;return strings(['20'])}}
 const result=await queryMedia(device,'phone',{kind:'image',name_contains:"a'%_\\",directory:'/sdcard/Download',limit:1,cursor:'201:22'},signal());assert.equal(result.next_cursor,'200:20');assert.equal(result.has_more,true);assert.equal(result.count,1);assert.equal(result.items[0].duration_ms,null);assert.equal(result.snapshot,false);assert.equal(q,1);const command=calls.find(args=>args[2]?.includes('head -n'))[2];assert(command.endsWith('head -n 2'));assert(command.includes('media_type=1'));assert(command.includes('date_modified < 201'));assert(command.includes('\\%\\_\\\\'));assert(!calls.some(args=>args.includes('broadcast')))
})
test('current Android user changes discard the whole query rather than returning mixed user data',async()=>{
 let users=0;const device={async runShell(_s,args){if(args[0]==='am')return ++users===1?'0':'10';return'No result found.\n'}};await assert.rejects(queryMedia(device,'phone',{},signal()),/用户在媒体查询期间变化/)
})
test('cross-user directories are rejected and content CLI failures are not returned as zero matches',async()=>{
 const device={async runShell(_s,args){if(args[0]==='am')return'0';if(args[0]==='readlink')return'/storage/emulated/10/Pictures';return'Error while accessing provider:media\nPermission Denial'}};await assert.rejects(queryMedia(device,'phone',{directory:'/storage/emulated/10/Pictures'},signal()),/当前用户/);await assert.rejects(queryMedia(device,'phone',{},signal()),/查询失败/)
})
