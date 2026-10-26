import {setTimeout as delay} from 'node:timers/promises'
import {createHash} from 'node:crypto'
import {containerFor,inside,integer,scrollSettings,screenFingerprint,type Capture,type NavigationDriver,type ScrollOptions,type ListItem} from './navigation.js'
import {matchTargets,validateTarget,type TargetQuery} from './targets.js'
import type {ScreenElement} from './observation.js'

export interface PageReadOptions extends ScrollOptions {max_chars?:number;max_paragraphs?:number;expected_title?:string;end_text?:string;mode?:'text'|'screenshots'}
export interface PageCheckpoint {pages:Capture[];items:ListItem[];scrolls:number;requested_count:number;characters:number;kind:'page';reading_mode?:'screenshots'}
interface Fragment {text:string;element:ScreenElement;truncated:boolean}
const normalize=(text:string)=>text.normalize('NFKC').replace(/\s+/g,' ').trim()
function fragments(elements:ScreenElement[]):Fragment[]{
 const seen=new Set<string>(),values:Fragment[]=[]
 for(const element of elements){const raw=element.text||element.description;if(!raw.trim())continue
  // Preserve repeated paragraphs at different positions; suppress only duplicate accessibility nodes.
  const key=JSON.stringify([raw,element.bounds]);if(seen.has(key))continue;seen.add(key)
  for(const text of raw.split(/\r?\n/).map(value=>value.trim()).filter(Boolean))values.push({text,element,truncated:!!(element.text?element.text_truncated:element.description_truncated)})
 }
 return values
}
function moving(a:Fragment,b:Fragment){return Math.abs((a.element.bounds[1]+a.element.bounds[3])-(b.element.bounds[1]+b.element.bounds[3]))>=16}
/** Match only the adjacent suffix/prefix. A global set would erase legitimate repetitions later in an article. */
export function paragraphOverlap(previous:Fragment[],current:Fragment[]){
 for(let count=Math.min(previous.length,current.length);count>0;count--){const tail=previous.slice(-count),head=current.slice(0,count)
  if(tail.every((fragment,index)=>normalize(fragment.text)===normalize(head[index]!.text))&&tail.reduce((sum,fragment)=>sum+normalize(fragment.text).length,0)>=12&&tail.some((fragment,index)=>moving(fragment,head[index]!)))return{count,characters:0}
 }
 const a=previous.at(-1),b=current[0]
 if(a&&b&&moving(a,b))for(let count=Math.min(a.text.length,b.text.length);count>=24;count--)if(a.text.slice(-count)===b.text.slice(0,count))return{count:0,characters:count}
 return null
}
/** Read a bounded range from the current viewport; only a caller-observed end marker can prove that marker was reached. */
export async function readPage(driver:NavigationDriver,query:TargetQuery,options:PageReadOptions,checkpoint?:(value:PageCheckpoint)=>Promise<void>){
 validateTarget(query)
 if(options.mode!==undefined&&!['text','screenshots'].includes(options.mode))throw new Error('正文阅读模式无效')
 if(options.mode!=='screenshots'&&options.direction==='up')throw new Error('正文文字模式按向下顺序合并段落，请先明确定位阅读起点；向上截图请使用截图模式')
 if(options.mode!=='screenshots'&&query.text===undefined&&query.resource_id===undefined&&query.class_name===undefined)throw new Error('正文读取须提供文字、资源 ID 或类名作为内容选择条件')
 for(const [label,value] of [['预期标题',options.expected_title],['结束文字',options.end_text]] as const)if(value!==undefined&&(!value.trim()||value.length>500))throw new Error(`${label}须为 1–500 字`)
 const settings=scrollSettings(options),maxChars=integer(options.max_chars,12000,100,24000,'正文字符上限'),maxParagraphs=integer(options.max_paragraphs,60,1,100,'正文段落上限')
 if(options.mode==='screenshots')return readScreenshots(driver,query,options,checkpoint)
 const pages:Capture[]=[],items:ListItem[]=[],seen=new Set<string>()
 let current!:Capture,previous:Fragment[]=[],previousIndices:number[]=[],characters=0,scrolls=0,status='',context='',candidates:ScreenElement[]=[],clipped=false
 for(;;){
  driver.signal.throwIfAborted();current=await driver.capture();pages.push(current)
  const observation=current.observation
  if(observation.tree_error||observation.tree_truncated){status='tree_unavailable';break}
  if(pages.length===1&&options.expected_title&&!observation.elements.some(element=>normalize(element.text||element.description).includes(normalize(options.expected_title!)))){status='context_mismatch';break}
  const selection=containerFor(observation,options,query.package_name),container=selection.container;candidates=selection.candidates
  if(candidates.length>1){status='ambiguous_container';break}
  const region:ScreenElement=container??{element_id:'',text:'',description:'',resource_id:'',package_name:query.package_name??'',class_name:'',clickable:false,editable:false,focused:false,bounds:[0,0,observation.width,observation.height]}
  const identity=JSON.stringify([region.package_name,region.resource_id,region.class_name,observation.width,observation.height,observation.rotation])
  if(context&&context!==identity){status='context_changed';break}context=identity
  const selected=matchTargets(observation.elements,query).filter(element=>element!==container&&!element.scrollable&&!element.editable&&!/Button|CheckBox|Switch/.test(element.class_name)&&inside(element,region)&&(!container?.node_path||!element.node_path||element.node_path.startsWith(container.node_path+'.'))).sort((a,b)=>a.bounds[1]-b.bounds[1]||a.bounds[0]-b.bounds[0])
  const currentFragments=fragments(selected)
  if(!currentFragments.length){status='content_unavailable';break}
  const fingerprint=screenFingerprint({...observation,elements:selected})
  if(seen.has(fingerprint)){status='unchanged';break}seen.add(fingerprint)
  const overlap=previous.length?paragraphOverlap(previous,currentFragments):{count:0,characters:0}
  if(!overlap){status='continuity_lost';break}
  const indices:number[]=[],page=pages.length
  for(let index=0;index<overlap.count;index++){const savedIndex=previousIndices[previous.length-overlap.count+index]!,item=items[savedIndex]!;if(!item.pages.includes(page))item.pages.push(page);indices.push(savedIndex)}
  if(overlap.characters){const oldIndex=previousIndices.at(-1)!;if(!items[oldIndex]!.pages.includes(page))items[oldIndex]!.pages.push(page)}
  for(let index=overlap.count;index<currentFragments.length;index++){
   const fragment=currentFragments[index]!,raw=index===0&&overlap.characters?fragment.text.slice(overlap.characters):fragment.text
   if(!raw){indices.push(previousIndices.at(-1)!);continue}
   if(items.length>=maxParagraphs){status='paragraph_limit';break}
   const text=raw.slice(0,maxChars-characters);if(!text){status='character_limit';break}
   items.push({title:text.slice(0,80),texts:[text],description:'',resource_id:fragment.element.resource_id,package_name:fragment.element.package_name,first_page:page,pages:[page]});indices.push(items.length-1);characters+=text.length;clipped||=!!fragment.element.text_clipped
   if(text.length<raw.length||characters>=maxChars){status='character_limit';break}
  }
  previous=currentFragments;previousIndices=indices
  if(checkpoint)await checkpoint({pages:[...pages],items:structuredClone(items),scrolls,requested_count:maxParagraphs,characters,kind:'page'})
  driver.signal.throwIfAborted()
  if(status)break
  if(currentFragments.some(fragment=>fragment.truncated)){status='text_truncated';break}
  if(options.end_text&&selected.some(element=>normalize(element.text||element.description).includes(normalize(options.end_text!)))){status='end_marker';break}
  if(!container){status='scroll_unavailable';break}
  if(items.length>=maxParagraphs){status='paragraph_limit';break}
  if(scrolls>=settings.max){status='scroll_limit';break}
  await driver.scroll(current,container,settings.direction);scrolls++;await delay(settings.interval,undefined,{signal:driver.signal})
 }
 return{...current,pages,items,characters,kind:'page' as const,status,scrolls,page_count:pages.length,candidates,clipped_text:clipped,coverage:'from_current_view',guidance:'Raw exposed UI text, not an article summary or guaranteed full visible OCR. items[].texts contain ordered paragraph fragments; repeated later paragraphs are retained. Only adjacent overlapping moving text is merged. Clipped/truncated text, image-only content, login/paywall and an unchanged screen cannot prove complete reading. end_marker proves only that the specified marker was observed in the chosen content. Keep screenshot evidence; save any organized summary with android_save_result. After Back, freshly locate the saved list title/selectors; never replay old element IDs or coordinates.'}
}

/** Screenshot collection leaves OCR, title checks and summary to the current Harness image-capable model. */
async function readScreenshots(driver:NavigationDriver,query:TargetQuery,options:PageReadOptions,checkpoint?:(value:PageCheckpoint)=>Promise<void>){
 if(options.end_text!==undefined)throw new Error('截图模式不使用文字结束标记；请由当前视觉模型核对范围')
 const settings=scrollSettings(options),pages:Capture[]=[],regions:{page:number;bounds:number[]}[]=[],seen=new Set<string>()
 let current!:Capture,scrolls=0,status='',identity='',candidates:ScreenElement[]=[]
 for(;;){
  driver.signal.throwIfAborted();current=await driver.capture();pages.push(current)
  const observation=current.observation,selection=containerFor(observation,options,query.package_name),container=selection.container;candidates=selection.candidates
  if(pages.length===1&&options.expected_title&&!observation.elements.some(element=>normalize(element.text||element.description).includes(normalize(options.expected_title!)))){status='context_mismatch';break}
  if(observation.tree_error||observation.tree_truncated){status='tree_unavailable';break}
  if(!container){status=candidates.length?'ambiguous_container':'scroll_unavailable';break}
  const key=JSON.stringify([container.package_name,container.resource_id,container.class_name,observation.width,observation.height,observation.rotation])
  if(identity&&key!==identity){status='context_changed';break}identity=key
  regions.push({page:pages.length,bounds:[...container.bounds]})
  const fingerprint=createHash('sha256').update(current.png).digest('hex')
  if(seen.has(fingerprint)){status='unchanged_image';break}seen.add(fingerprint)
  if(checkpoint)await checkpoint({pages:[...pages],items:[],scrolls,requested_count:settings.max+1,characters:0,kind:'page',reading_mode:'screenshots'})
  driver.signal.throwIfAborted()
  if(scrolls>=settings.max){status='screen_limit';break}
  await driver.scroll(current,container,settings.direction);scrolls++;await delay(settings.interval,undefined,{signal:driver.signal})
 }
 return{...current,pages,items:[] as ListItem[],kind:'page' as const,reading_mode:'screenshots' as const,status,characters:0,scrolls,page_count:pages.length,candidates,regions,coverage:'screenshots_from_current_view',continuity_verified:false,guidance:'These are full original phone screenshots, not OCR text or a summary. The CURRENT Harness image-capable model must verify the title, focus on regions[].bounds, read the screenshots, reconcile overlaps and explicitly report gaps or access limits. No independent model was run. An unchanged image or screen_limit does not prove end-of-article. Do not claim full reading from collection alone. Save a sourced partial/complete report only after inspecting the images. After Back freshly locate the retained list title; never reuse old IDs or coordinates.'}
}
