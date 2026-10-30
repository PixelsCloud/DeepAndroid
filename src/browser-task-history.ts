import type {TaskRecord} from './tasks.js'
import {taskOperationName, type TaskView} from './task-feed.js'

export function mountTaskHistory(root:HTMLElement,openImage:(id:string)=>void){
 const area=document.createElement('section');area.className='task-history';area.setAttribute('aria-label','任务操作记录');root.append(area)
 const pageSize=20
 let disposed=false,epoch=0,key='',taskId='',page=0,controller:AbortController|undefined
 const text=(parent:HTMLElement,tag:string,value:string)=>{const node=document.createElement(tag);node.textContent=value;parent.append(node);return node}
 function render(record:TaskRecord){
  const expanded=new Set([...area.querySelectorAll<HTMLDetailsElement>('details[open]')].map(node=>node.dataset.step))
  area.replaceChildren();text(area,'h3',`操作记录 · ${record.operations.length} 步`)
  if(!record.operations.length){text(area,'p','尚未执行手机操作，等待 Agent 发起调用。');return}
  const pages=Math.ceil(record.operations.length/pageSize)
  page=Math.min(page,pages-1)
  const start=page*pageSize,end=Math.min(start+pageSize,record.operations.length)
  const nav=document.createElement('nav');nav.className='task-history-paging';nav.setAttribute('aria-label','操作记录分页');area.append(nav)
  const changePage=(next:number,focus:string)=>{page=next;render(record);area.querySelector<HTMLElement>(`[aria-label="${focus}"]`)?.focus({preventScroll:true})}
  const previous=document.createElement('button');previous.textContent='上一页';previous.setAttribute('aria-label','操作记录上一页');previous.disabled=page===0;previous.onclick=()=>changePage(page-1,'操作记录上一页');nav.append(previous)
  text(nav,'span',`第 ${page+1} / ${pages} 页 · ${start+1}–${end} / ${record.operations.length} 步`).setAttribute('role','status')
  const next=document.createElement('button');next.textContent='下一页';next.setAttribute('aria-label','操作记录下一页');next.disabled=page===pages-1;next.onclick=()=>changePage(page+1,'操作记录下一页');nav.append(next)
  const jump=document.createElement('select');jump.setAttribute('aria-label','跳转操作记录页');for(let i=0;i<pages;i++){const option=document.createElement('option');option.value=String(i);option.textContent=`第 ${i+1} 页`;jump.append(option)}jump.value=String(page);jump.onchange=()=>changePage(Number(jump.value),'跳转操作记录页');nav.append(jump)
  const list=document.createElement('ol');list.start=start+1;area.append(list)
  for(const operation of record.operations.slice(start,end)){
   const row=document.createElement('li');list.append(row)
   const header=text(row,'div',taskOperationName(operation.tool));header.className='task-operation-title'
   const state=operation.status==='ok'?'已返回结果':operation.status==='error'?'失败':record.status==='running'?'执行中':'结果未确认'
   text(header,'span',state+(operation.durationMs!==undefined?` · ${(operation.durationMs/1000).toFixed(1)} 秒`:''))
   if(operation.outcome)text(row,'p','返回：'+({sent:'已发送',completed:'已完成',observed:'已取得界面',found:'已找到',not_found:'未找到',count_reached:'已达到读取数量',no_new_items:'没有新条目',unchanged:'页面没有变化'}[operation.outcome]??operation.outcome))
   if(operation.diagnostic)text(row,'p',operation.diagnostic.message+' '+operation.diagnostic.recovery).className='task-problem'
   const summary=operation.summary
   if(summary?.itemCount!==undefined)text(row,'p',`已读取 ${summary.itemCount} 条${summary.pageCount!==undefined?` · ${summary.pageCount} 屏`:''}`)
   if(summary?.saveError)text(row,'p',summary.saveError).className='task-problem'
   if(summary?.items?.length){
    const content=text(row,'div','');content.className='task-read-content'
    for(const value of summary.items){
     if(!value||typeof value!=='object')continue
     const item=value as {title?:unknown;texts?:unknown;description?:unknown}
     if(typeof item.title==='string')text(content,'strong',item.title)
     const lines=[...(Array.isArray(item.texts)?item.texts.filter((v):v is string=>typeof v==='string'&&v!==item.title):[]),...(typeof item.description==='string'&&item.description!==item.title?[item.description]:[])]
     if(lines.length)text(content,'p',[...new Set(lines)].join('\n'))
    }
   }else if(['android_read_list','android_read_page'].includes(operation.tool))text(row,'p','此步骤未保存可展示的文字内容，可查看截图依据。')
   const screenshots=[...(operation.screenshot?[{id:operation.id,label:'查看截图'}]:[]),...(operation.pages??[]).map(page=>({id:`${operation.id}~${page.page}`,label:`第 ${page.page} 屏截图`})),...(operation.beforeObservation?[{id:operation.beforeObservation,label:'操作前截图'}]:[]),...(operation.afterObservation?[{id:operation.afterObservation,label:'操作后截图'}]:[])]
   if(screenshots.length){const actions=text(row,'div','');actions.className='task-operation-images';for(const shot of screenshots){const button=document.createElement('button');button.textContent=shot.label;button.onclick=()=>openImage(shot.id);actions.append(button)}}
   const more=document.createElement('details');more.dataset.step=operation.id;more.open=expanded.has(operation.id);text(more,'summary','操作参数');text(more,'pre',JSON.stringify(operation.input,null,2));row.append(more)
  }
 }
 async function update(view:TaskView){
  const next=JSON.stringify([view.id,view.calls,view.returned,view.errors,view.phase,view.progress,view.lastStep])
  if(next===key||disposed)return
  key=next;controller?.abort();controller=new AbortController();const own=++epoch
  if(taskId!==view.id){taskId=view.id;page=0;area.replaceChildren();text(area,'p','正在读取任务操作记录…')}
  try{
   const response=await fetch('/x-android/records/'+encodeURIComponent(view.id),{headers:{'x-android-client':'1'},signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])})
   if(!response.ok)throw new Error('无法读取任务操作记录')
   const record=await response.json() as TaskRecord
   if(disposed||own!==epoch||record.id!==taskId)return
   render(record)
  }catch(error){if(disposed||own!==epoch||controller.signal.aborted)return;area.replaceChildren();text(area,'p',(error as Error).message);const retry=document.createElement('button');retry.textContent='重试读取记录';retry.onclick=()=>{key='';void update(view)};area.append(retry)}
 }
 return{update,dispose(){disposed=true;epoch++;controller?.abort();area.remove()}}
}
