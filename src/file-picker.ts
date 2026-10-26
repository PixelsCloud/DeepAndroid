import {XMLParser} from 'fast-xml-parser'
import {setTimeout as delay} from 'node:timers/promises'
import type {Capture} from './navigation.js'

export interface PickFileOptions{action?:'inspect'|'select';file_name?:string;search?:boolean;expected_caller_package?:string}
type PickerCapture=Capture&{xml:string}
interface Point{bounds:[number,number,number,number]}
export interface PickerDriver{signal:AbortSignal;capture:()=>Promise<PickerCapture>;state:()=>Promise<{foreground:{package_name:string;activity:string}|null;focused_window:{package_name:string}|null}>;press:(capture:PickerCapture,target:Point)=>Promise<void>;type:(capture:PickerCapture,text:string)=>Promise<void>}
const packages=new Set(['com.android.documentsui','com.google.android.documentsui'])
export function pickerActive(state:Awaited<ReturnType<PickerDriver['state']>>){return !!state.foreground&&packages.has(state.foreground.package_name)&&/(?:^|\.)picker\.PickActivity$/.test(state.foreground.activity)&&state.focused_window?.package_name===state.foreground.package_name}
export function validatePickFile(options:PickFileOptions){if(!['inspect','select'].includes(options.action??'inspect'))throw new Error('action 须为 inspect 或 select');if(options.action==='select'&&(typeof options.file_name!=='string'||!options.file_name.length||options.file_name.length>255||/[\/\\\x00-\x1f\x7f]/.test(options.file_name)))throw new Error('选择需要确切 file_name（不能包含路径或控制字符）');if(options.action!=='select'&&(options.search||options.file_name!==undefined))throw new Error('搜索和文件名仅用于 select')}
export function parsePicker(xml:string,width:number,height:number,pkg:string){
 if(xml.length>2*1024**2||/<!DOCTYPE|<!ENTITY/i.test(xml))throw new Error('选择器结构无效')
 const document=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'',parseAttributeValue:false}).parse(xml),entries:{name:string;bounds:Point['bounds'];enabled:boolean;selected:boolean;folder:boolean}[]=[],search:Point[]=[],inputs:Point[]=[],confirm:Point[]=[];let visited=0,truncated=false,scrollable=false,hasSelection=false
 function walk(value:unknown,depth:number,inList=false,enabled=true,selected=false,folder=false){if(Array.isArray(value)){for(const node of value)walk(node,depth,inList,enabled,selected,folder);return}if(!value||typeof value!=='object')return;if(++visited>3000||depth>100){truncated=true;return}const node=value as Record<string,unknown>;if(node['visible-to-user']==='false')return;const own=node.package===pkg,id=String(node['resource-id']??''),list=inList||own&&id===pkg+':id/dir_list',active=enabled&&node.enabled!=='false',chosen=selected||node.selected==='true'||node.checked==='true',isFolder=folder||/^(?:文件夹|Folder)$/i.test(String(node['content-desc']??'')),match=String(node.bounds??'').match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/),point=match?{bounds:match.slice(1).map(Number)as Point['bounds']}:null
 if(own&&id===pkg+':id/dir_list')scrollable=node.scrollable==='true'
 if(list&&chosen||[pkg+':id/action_mode_close_button','android:id/action_mode_close_button'].includes(id))hasSelection=true
 if(point&&point.bounds[0]>=0&&point.bounds[1]>=0&&point.bounds[2]<=width&&point.bounds[3]<=height&&point.bounds[2]>point.bounds[0]&&point.bounds[3]>point.bounds[1]&&own){
  if(list&&(id==='android:id/title'||id===pkg+':id/title')&&typeof node.text==='string'&&node.text)entries.push({name:node.text,bounds:point.bounds,enabled:active,selected:chosen,folder:isFolder})
  if(active&&id===pkg+':id/option_menu_search'&&node.clickable==='true')search.push(point)
  if(active&&/(?:EditText|AutoCompleteTextView)$/.test(String(node.class))&&node.focused==='true'&&(id==='android:id/search_src_text'||id===pkg+':id/search_src_text'))inputs.push(point)
  if(active&&[pkg+':id/action_menu_select',pkg+':id/button_select','android:id/button1'].includes(id))confirm.push(point)
 }
 if('node'in node)walk(node.node,depth+1,list,active,chosen,isFolder)
 }
 if(!document?.hierarchy)throw new Error('选择器没有有效 hierarchy');walk(document.hierarchy.node,0);return{entries,search,inputs,confirm,truncated,scrollable,hasSelection}
}
export async function pickFile(driver:PickerDriver,options:PickFileOptions){
 validatePickFile(options);const action=options.action??'inspect',initial=await driver.capture();let capture=initial,state=await driver.state(),taps=0
 const result=(status:string,extra:Record<string,unknown>={})=>({status,capture,taps,attachment_confirmed:false,upload_performed:false,...extra})
 if(!pickerActive(state))return result('not_picker',{guidance:'当前不是已支持的系统 DocumentsUI PickActivity（或焦点不在选择器），未操作。先在调用应用中打开文件上传/附件入口；厂商自有相册或 Photo Picker 请使用普通观察与点击工具。'})
 if(capture.observation.tree_error||capture.observation.tree_truncated)return result('tree_unavailable',{guidance:'选择器元素不完整，未点击；请查看截图。'})
 const pkg=state.foreground!.package_name;let view=parsePicker(capture.xml,capture.observation.width,capture.observation.height,pkg)
 const usable=()=>!view.truncated&&!capture.observation.tree_error&&!capture.observation.tree_truncated
 const refresh=async()=>{driver.signal.throwIfAborted();capture=await driver.capture();state=await driver.state();if(pickerActive(state)&&state.foreground!.package_name===pkg&&!capture.observation.tree_error&&!capture.observation.tree_truncated)view=parsePicker(capture.xml,capture.observation.width,capture.observation.height,pkg)}
 if(!usable())return result('tree_unavailable',{guidance:'选择器元素不完整，未点击；请查看截图。'})
 if(action==='inspect')return result('inspected',{picker_package:pkg,entries:view.entries,scrollable:view.scrollable,search_available:view.search.length===1,scope:'visible_rows',guidance:'这里只列出当前可见行，不保证完整目录，也不推断真实路径。select 使用确切文件名；可先在选择器中导航到目标目录。'})
 if(options.search){
  if(view.hasSelection)return result('existing_selection',{guidance:'检测到已有选中行或选择模式，未改变选择；先核对并清理已有选择。'})
  if(view.inputs.length!==1){if(view.search.length!==1)return result('search_unavailable',{guidance:'未找到唯一的系统搜索入口，未操作；可先用原生界面工具导航到文件所在目录。'});await driver.press(capture,view.search[0]!);taps++;await delay(250,undefined,{signal:driver.signal});await refresh()}
  if(!pickerActive(state)||state.foreground!.package_name!==pkg)return result('context_changed')
  if(!usable()||view.inputs.length!==1)return result('search_unavailable',{guidance:'搜索输入框没有唯一聚焦，未输入文件名。'})
  await driver.type(capture,options.file_name!);await delay(600,undefined,{signal:driver.signal});await refresh()
 }
 if(!pickerActive(state)||state.foreground!.package_name!==pkg)return result('context_changed',{guidance:'选择器上下文变化，已停止；请重新观察。'})
 if(!usable())return result('tree_unavailable')
 if(view.hasSelection)return result('existing_selection',{entries:view.entries,guidance:'已有选中行或选择模式，未追加或提交文件，避免带入其他附件。'})
 const matches=view.entries.filter(entry=>entry.name===options.file_name),eligible=matches.filter(entry=>entry.enabled&&!entry.folder)
 if(matches.length>1)return result('ambiguous',{matches,guidance:'可见行存在同名项，未选择；请进入确切文件夹后再调用。'})
 if(!matches.length)return result('not_found',{entries:view.entries,scope:'visible_rows',guidance:'当前可见行没有完整匹配文件名，未选择；可能在其他目录、屏外、被 MIME 筛选或名称未完整暴露。'})
 if(!eligible.length)return result('not_selectable',{matches,guidance:'匹配项不可用或被识别为目录，未点击。'})
 if(view.scrollable)return result('needs_navigation',{matches,guidance:'列表仍可滚动，无法排除屏外同名项，未选择。可搜索精确名称或进入目标文件夹缩小范围。'})
 await driver.press(capture,eligible[0]!);taps++;await delay(400,undefined,{signal:driver.signal});await refresh()
 const stillPicker=pickerActive(state)&&state.foreground!.package_name===pkg,caller=state.foreground?.package_name??null
 return result('selection_requested',{file_name:options.file_name,picker_closed:!stillPicker,foreground_package:caller,expected_caller_matched:options.expected_caller_package?caller===options.expected_caller_package:null,awaiting_confirmation:stillPicker&&view.confirm.length>0,guidance:stillPicker?'已点击一次匹配行，选择器仍在前台；可能需要确认或发生目录导航。请核对截图，不自动点击确认或发送。':'已点击一次且选择器离开前台；不证明调用应用已收到正确附件或完成上传，请观察调用应用核对。未点击发布或发送。'})
}
