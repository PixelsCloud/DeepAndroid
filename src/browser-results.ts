import { resultCsv, sourceNumbers, type SavedResult } from './result-format.js'
import { notify, resetNotice } from './browser-toast.js'
import {createDialogs} from './browser-file-dialogs.js'
type ResultDetail = SavedResult & {task_state?:{status:string;reason:string|null}|null}
type Summary = Omit<SavedResult,'rows'|'sources'|'summary'|'columns'|'observation_ids'> & {row_count:number;source_count:number}
const headers={'x-android-client':'1'}
type ResultPage={results:Summary[];warning:string|null;total:number;total_all:number;deleted_count:number;offset:number;limit:number;has_more:boolean}
export function mountResults(root: HTMLElement) {
  root.innerHTML=`<style>
  .android-panel .android-results-root{display:flex;flex-direction:column;overflow:hidden}
  .android-panel .android-results-root .android-results{display:flex;flex-direction:column;align-items:stretch;flex:1;min-height:0;height:100%;width:100%;gap:10px}
  .android-panel .android-results-root .result-toolbar{flex:none;flex-wrap:nowrap;width:100%;gap:8px}
  .android-panel .android-results-root .result-toolbar input{flex:1 1 auto;min-width:80px;width:auto}
  .android-panel .android-results-root .result-toolbar button{flex:none;white-space:nowrap}
  .android-panel .android-results-root .result-list{flex:1;min-height:0;max-height:none;width:100%;align-items:stretch;margin:0;overflow:auto}
  .android-panel .android-results-root .result-list button{width:100%;box-shadow:none}
  .android-panel .result-row{display:flex;align-items:center;flex:none;width:100%;min-width:0;border:1px solid #ffffff20;border-radius:10px;background:#161d27;padding-right:8px}
  .android-panel .result-row:has([aria-pressed=true]){background:#203932;border-color:#65dfbd77}
  .android-panel .android-results-root .result-row>[data-result-id]{flex:1;min-width:0;width:0;border:0;background:transparent;border-radius:9px}
  .android-panel .android-results-root .result-row>.result-row-delete{width:34px;height:34px;min-height:34px;flex:none;align-items:center;justify-content:center;padding:7px;border:0;background:transparent;color:#9aabba}
  .android-panel .android-results-root .result-row>.result-row-delete:hover{background:#ff77771a;color:#ffadad}
  .android-panel .android-results-root .result-paging{flex:none;margin:0;padding:4px 0}
  .android-panel .result-detail-dialog{width:min(960px,calc(100vw - 32px));height:min(820px,calc(100dvh - 48px));max-height:calc(100dvh - 48px);overflow:hidden;padding:18px}
  .android-panel .result-detail-dialog[open]{display:flex;flex-direction:column;gap:12px}
  .android-panel .result-dialog-header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex:none;border-bottom:1px solid #ffffff15;padding-bottom:12px}
  .android-panel .result-detail-dialog .result-detail{overflow:auto;flex:1;min-height:0;margin:0;padding:0;border:0;background:transparent;position:static}
  .android-results{font:12px/1.6 system-ui;min-width:0}.android-results a{color:#6cad94}.android-results h2{font-size:17px;margin:12px 0 4px}.android-results p{white-space:pre-wrap;overflow-wrap:anywhere}.android-results .result-list{display:flex;flex-direction:column;gap:6px;max-height:180px;overflow:auto;margin:10px 0}.android-results .result-list button{text-align:left}.android-results [aria-pressed=true]{border-color:#168468}.android-results .result-actions{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}.android-results .result-note{color:#929b9a}.android-results .result-error{color:#e68f8f}.android-results .result-table{max-width:100%;overflow:auto;border:1px solid #8883;border-radius:8px}.android-results table{border-collapse:collapse;min-width:100%;text-align:left}.android-results th,.android-results td{padding:8px 10px;border-bottom:1px solid #8883;min-width:100px;max-width:320px;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere}.android-results th{background:#8881}.android-results .result-wide-column{min-width:260px;max-width:440px}.android-results .result-short-column{min-width:60px;max-width:120px}.android-results td button{padding:3px 6px;margin:2px;font-size:11px}.android-results .result-evidence{width:min(620px,calc(100vw - 32px));max-height:85vh;overflow:auto;color:inherit;background:#15191e;border:1px solid #8886;border-radius:12px;padding:14px}.android-results .result-evidence::backdrop{background:#0009}.android-results .result-evidence img{max-width:100%;max-height:min(62vh,600px);display:block;margin:10px auto}.android-results .result-summary{border-left:2px solid #168468;padding-left:10px}
  .android-results .result-toolbar,.android-results .result-paging{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.android-results .result-filters{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:10px 0}.android-results .result-filters label{display:flex;flex-direction:column;gap:4px;min-width:0}.android-results .result-query{grid-column:1/-1}.android-results input{font:inherit;border:1px solid #8885;border-radius:7px;padding:7px 8px;background:transparent;color:inherit;min-width:0;width:100%;color-scheme:dark}.android-results .result-notice{padding:8px 10px;border:1px solid #16846866;border-radius:7px;margin:10px 0}.android-results .result-notice button{margin-left:8px}.android-results .result-rename{width:min(420px,calc(100vw - 32px));color:inherit;background:#15191e;border:1px solid #8886;border-radius:12px;padding:18px}.android-results .result-rename::backdrop{background:#0009}.android-results .result-rename label{display:flex;flex-direction:column;gap:8px}.android-results .result-rename footer{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
  </style><div class="android-results"><div class="result-toolbar"><input type="search" data-results-query aria-label="搜索结果" placeholder="搜索标题、摘要或表格内容" maxlength="256"><button data-results-refresh>刷新结果</button></div><div class="result-notice" data-results-notice role="status" hidden><span></span><button data-results-undo hidden>撤销</button></div><p class="result-error" role="note" data-results-error hidden></p><div class="result-list" aria-label="已保存结果"></div><div class="result-paging"><button data-results-prev>上一页</button><span data-results-page></span><button data-results-next>下一页</button></div><dialog class="result-detail-dialog" aria-label="结果详情"><header class="result-dialog-header"><strong>结果详情</strong><button data-result-close aria-label="关闭结果详情">关闭</button></header><div class="result-detail"></div></dialog><dialog class="result-rename" aria-label="重命名结果"><form data-result-rename-form><label>结果标题<input data-result-rename-title aria-label="结果标题" maxlength="100" required></label><p class="result-error" data-result-rename-error hidden></p><footer><button type="button" data-result-rename-cancel>取消</button><button type="submit" data-result-rename-save>保存名称</button></footer></form></dialog></div>`
  const list=root.querySelector<HTMLElement>('.result-list')!,detail=root.querySelector<HTMLElement>('.result-detail')!,error=root.querySelector<HTMLElement>('[data-results-error]')!,abort=new AbortController()
  let visible=false,disposed=false,selected='',revision='',generation=0,requestVersion=0,followLatest=true,refreshing=false,refreshAgain=false,filterVersion=0,offset=0,total=0,renameId='',openTarget=''
  let searchTimer:ReturnType<typeof setTimeout>|undefined,listRevision=''
  const query=root.querySelector<HTMLInputElement>('[data-results-query]')!,previous=root.querySelector<HTMLButtonElement>('[data-results-prev]')!,next=root.querySelector<HTMLButtonElement>('[data-results-next]')!,pageLabel=root.querySelector<HTMLElement>('[data-results-page]')!,notice=root.querySelector<HTMLElement>('[data-results-notice]')!,undo=root.querySelector<HTMLButtonElement>('[data-results-undo]')!,renameDialog=root.querySelector<HTMLDialogElement>('.result-rename')!,renameTitle=root.querySelector<HTMLInputElement>('[data-result-rename-title]')!,renameError=root.querySelector<HTMLElement>('[data-result-rename-error]')!
  const modal=root.querySelector<HTMLDialogElement>('.result-detail-dialog')!
  root.querySelector<HTMLButtonElement>('[data-result-close]')!.onclick=()=>modal.close()
  modal.addEventListener('close',()=>{if(modal.open)return;requestVersion++;generation++;revision='';clearImages();if(renameDialog.open)renameDialog.close();if(visible&&!disposed)list.querySelector<HTMLButtonElement>(`[data-result-id="${selected}"]`)?.focus({preventScroll:true})})
  async function openDetail(id:string){
    selected=id;openTarget=id;followLatest=false;revision='';detail.replaceChildren();text(detail,'正在读取…','p','result-note')
    if(!modal.open)modal.showModal()
    try{await render(id)}catch(error){if(modal.open&&selected===id){detail.replaceChildren();text(detail,'详情读取失败，请关闭后重试。','p','result-error')}throw error}
  }
  const urls=new Set<string>()
  const dialogs=createDialogs(root)
  function text(parent:Element,value:string,tag='p',className=''){const node=document.createElement(tag);node.textContent=value;node.className=className;parent.appendChild(node);return node}
  function report(value:unknown){if(!disposed)notify(root,value,'error','results')}
  const run=(work:()=>Promise<void>)=>{resetNotice(root,'results');void work().catch(value=>{if(!abort.signal.aborted)report(value)})}
  async function deleteResult(id:string,title:string){
    if(!await dialogs.confirm('删除结果',`确定删除“${title}”吗？删除后可以撤销。`,'确认删除',true)||disposed)return
    await request('/results/'+id+'/delete',{})
    if(disposed)return
    openTarget='';if(modal.open&&selected===id)modal.close()
    showNotice('已删除“'+title+'”。',()=>restore(id,title));revision='';await refresh()
  }
  async function request(path:string,input?:object){const response=await fetch('/x-android'+path,{method:input?'POST':'GET',headers:input?{...headers,'content-type':'application/json'}:headers,body:input?JSON.stringify(input):undefined,signal:AbortSignal.any([abort.signal,AbortSignal.timeout(30000)])});if(!response.ok){let message='请求失败';try{const value=await response.json();message=[value.error,value.recovery].filter(Boolean).join('。')}catch{}throw new Error(message)}return response}
  function clearImages(){for(const dialog of root.querySelectorAll<HTMLDialogElement>('dialog.result-evidence'))if(dialog.open)dialog.close();for(const url of urls)URL.revokeObjectURL(url);urls.clear()}
  async function download(result:SavedResult,format:'markdown'|'csv'|'bundle'){
    const response=await request(`/results/${result.id}/export?format=${format}`),url=URL.createObjectURL(await response.blob())
    if(disposed){URL.revokeObjectURL(url);return}
    const anchor=document.createElement('a');anchor.href=url;anchor.download=`android-result-${result.id}.${format==='markdown'?'md':format==='csv'?'csv':'zip'}`;document.body.appendChild(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)
  }
  async function showSource(result:SavedResult,index:number,area:HTMLDialogElement,own:number){
    const response=await request(`/results/${result.id}/source/${index+1}`),blob=await response.blob()
    if(disposed||!modal.open||own!==generation||selected!==result.id)return
    clearImages();area.replaceChildren();const source=result.sources[index]!
    const close=document.createElement('button');close.textContent='关闭截图';close.style.float='right';close.onclick=()=>area.close();area.appendChild(close)
    text(area,`截图 ${index+1} · ${new Date(source.captured_at).toLocaleString()}`,'p','result-note')
    const url=URL.createObjectURL(blob);urls.add(url);const image=document.createElement('img');image.src=url;image.alt=`${result.title}的截图依据 ${index+1}`;area.appendChild(image)
    const link=document.createElement('a');link.href=url;link.download=`evidence-${index+1}.${blob.type==='image/webp'?'webp':'png'}`;link.textContent='下载此截图';area.appendChild(link)
    area.showModal()
  }
  async function render(id:string){
    const own=++requestVersion,response=await request('/results/'+id),result=await response.json() as ResultDetail
    if(disposed||!modal.open||selected!==id||own!==requestVersion)return
    const key=JSON.stringify(result)
    if(revision===key)return
    revision=key;generation++;clearImages();detail.replaceChildren()
    text(detail,result.title,'h2')
    const status={complete:'已整理',partial:'部分完成',failed:'未完成'}[result.status]
    text(detail,`${status} · ${result.origin==='agent'?'Agent 整理':'原始采集'} · ${result.rows.length?`${result.rows.length} 条`:`摘要 · ${result.sources.length} 张依据`} · ${new Date(result.created_at).toLocaleString()}`,'p','result-note')
    text(detail,result.origin==='agent'?'整理内容请结合截图核对。':'以下是直接读取的原始内容，尚未由 Agent 整理。','p','result-note')
    if(result.reason)text(detail,result.reason,'p','result-error')
    if(result.task_state && ['limited','cancelled','interrupted','unknown'].includes(result.task_state.status))text(detail,`关联任务${result.task_state.status==='limited'?'达到限额':result.task_state.status==='unknown'?'结果待确认':'已中断'}：${result.task_state.reason??'以下为此前保存的内容'}`,'p','result-error')
    if(result.summary)text(detail,result.summary,'p','result-summary')
    const actions=document.createElement('div');actions.className='result-actions';detail.appendChild(actions)
    const button=(parent:Element,label:string,work:()=>Promise<void>)=>{const node=document.createElement('button');node.textContent=label;node.onclick=()=>run(async()=>{node.disabled=true;try{await work()}finally{node.disabled=false}});parent.appendChild(node);return node}
    if(result.deleted_at){text(detail,`已于 ${new Date(result.deleted_at).toLocaleString()} 移到最近删除，恢复后可继续查看和导出。`,'p','result-note');button(actions,'恢复结果',()=>restore(id,result.title));return}
    button(actions,'重命名',async()=>{renameId=id;renameTitle.value=result.title;renameError.hidden=true;renameDialog.showModal();renameTitle.focus();renameTitle.select()})
    button(actions,'删除',()=>deleteResult(id,result.title))
    button(actions,result.rows.length?'复制表格':'复制内容',async()=>{
      const value=resultCsv(result,'\t')
      try{await navigator.clipboard.writeText(value)}catch{
        const input=document.createElement('textarea');input.value=value;input.style.position='fixed';input.style.opacity='0';detail.appendChild(input);input.select();const ok=document.execCommand('copy');input.remove();if(!ok)throw new Error('无法复制，请导出文件')
      }
      if(!disposed&&selected===id)notify(root,'已复制，可粘贴到表格或文档。')
    })
    button(actions,'导出 Markdown',()=>download(result,'markdown'));button(actions,'导出 CSV',()=>download(result,'csv'));button(actions,'导出依据包',()=>download(result,'bundle'))
    const evidence=document.createElement('dialog');evidence.className='result-evidence';evidence.setAttribute('aria-label','截图依据')
    function sourceButtons(parent:Element,ids:string[]){for(const number of sourceNumbers(result,ids))button(parent,`截图 ${number}`,()=>showSource(result,number-1,evidence,generation))}
    if(result.rows.length){
      const wrapper=document.createElement('div');wrapper.className='result-table';detail.appendChild(wrapper)
      const table=document.createElement('table');wrapper.appendChild(table);const thead=document.createElement('thead'),tr=document.createElement('tr');thead.appendChild(tr);table.appendChild(thead)
      const columnClass=(index:number)=>{const length=Math.max(...result.rows.map(row=>row.cells[index]?.length??0));return length>32?'result-wide-column':length<=8?'result-short-column':''}
      for(const [index,column] of [...result.columns,'依据','说明'].entries())text(tr,column,'th',index<result.columns.length?columnClass(index):'')
      const body=document.createElement('tbody');table.appendChild(body)
      for(const row of result.rows){const tr=document.createElement('tr');body.appendChild(tr);for(const [index,cell] of row.cells.entries())text(tr,cell??'未读到','td',columnClass(index)+(cell===null?' result-note':''));const refs=document.createElement('td');tr.appendChild(refs);sourceButtons(refs,row.observation_ids);text(tr,row.note,'td')}
    }
    if(result.observation_ids.length){const summarySources=document.createElement('div');detail.appendChild(summarySources);text(summarySources,'摘要依据','p','result-note');sourceButtons(summarySources,result.observation_ids)}
    detail.appendChild(evidence)
  }
  function showNotice(message:string,undoWork?:()=>Promise<void>){notify(root,message);notice.hidden=!undoWork;notice.querySelector('span')!.textContent=undoWork?'可撤销最近一次操作。':'';undo.hidden=!undoWork;undo.onclick=undoWork?()=>run(undoWork):null}
  async function restore(id:string,title:string){await request(`/results/${id}/restore`,{});showNotice(`已恢复“${title}”。`);revision='';await refresh()}
  function parameters(){return new URLSearchParams({query:query.value,offset:String(offset),limit:'20'})}
  function changeFilters(){listRevision='';openTarget='';clearTimeout(searchTimer);offset=0;followLatest=true;filterVersion++;selected='';revision='';generation++;requestVersion++;clearImages();detail.replaceChildren();list.replaceChildren();text(list,'正在筛选…','p','result-note');previous.disabled=true;next.disabled=true;run(refresh)}
  async function refresh(){
    if(disposed)return
    if(refreshing){refreshAgain=true;return}
    refreshing=true
    const own=filterVersion
    try{
      const response=await request('/results?'+parameters()),value=await response.json() as ResultPage
      if(disposed||own!==filterVersion)return
      if(value.warning)notify(root,value.warning,'error','results-warning');else resetNotice(root,'results-warning')
      total=value.total
      if(total&&offset>=total){offset=Math.floor((total-1)/20)*20;filterVersion++;refreshAgain=true;return}
      previous.disabled=offset===0;next.disabled=!value.has_more;pageLabel.textContent=total?`${offset+1}–${Math.min(offset+20,total)} / ${total}`:'0 / 0'
      const nextListRevision=JSON.stringify(value.results)
      if(nextListRevision===listRevision){for(const button of list.querySelectorAll<HTMLButtonElement>('[data-result-id]'))button.setAttribute('aria-pressed',String(button.dataset.resultId===selected));if(modal.open&&selected)await render(selected);return}
      listRevision=nextListRevision
      list.replaceChildren()
      if(!value.results.length){openTarget='';selected='';revision='';generation++;clearImages();detail.replaceChildren();if(modal.open)modal.close();text(list,query.value?'没有匹配的结果，请修改或清空搜索。':'暂无结果。让 Agent 读取内容并保存结果后，会显示在这里。','p','result-note');return}
      if((followLatest&&offset===0)||(!openTarget&&!value.results.some(result=>result.id===selected))){if(selected!==value.results[0]!.id){selected=value.results[0]!.id;revision=''}}
      for(const result of value.results){const button=document.createElement('button');button.dataset.resultId=result.id;text(button,result.title,'strong');text(button,`${result.origin==='agent'?'Agent 整理':'原始采集'} · ${result.row_count?`${result.row_count} 条`:`${result.source_count} 张依据`} · ${new Date(result.created_at).toLocaleDateString()}`,'small');button.title='双击查看详情 · '+new Date(result.created_at).toLocaleString();button.setAttribute('aria-pressed',String(result.id===selected));button.onclick=()=>{openTarget='';followLatest=false;selected=result.id;revision='';for(const item of list.querySelectorAll('[data-result-id]'))item.setAttribute('aria-pressed',String(item===button));};button.ondblclick=()=>run(()=>openDetail(result.id));button.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();run(()=>openDetail(result.id))}};const row=document.createElement('div');row.className='result-row';const remove=document.createElement('button');remove.className='result-row-delete';remove.type='button';remove.title='删除此结果';remove.setAttribute('aria-label','删除结果：'+result.title);remove.innerHTML='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/></svg>';remove.onclick=event=>{event.stopPropagation();remove.disabled=true;run(async()=>{try{await deleteResult(result.id,result.title)}finally{remove.disabled=false}})};row.append(button,remove);list.append(row)}
      if(modal.open&&selected)await render(selected)
    }catch(value){if(disposed||own!==filterVersion)return;if(own===filterVersion){listRevision='';list.replaceChildren();text(list,'无法获取结果，请检查筛选条件或重试。','p','result-note');detail.replaceChildren()}throw value}finally{refreshing=false;if(refreshAgain&&!disposed){refreshAgain=false;run(refresh)}}
  }
  query.oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(changeFilters,250)}
  previous.onclick=()=>{openTarget='';offset=Math.max(0,offset-20);followLatest=false;filterVersion++;run(refresh)}
  next.onclick=()=>{openTarget='';if(offset+20<total){offset+=20;followLatest=false;filterVersion++;run(refresh)}}
  root.querySelector<HTMLButtonElement>('[data-result-rename-cancel]')!.onclick=()=>renameDialog.close()
  root.querySelector<HTMLFormElement>('[data-result-rename-form]')!.onsubmit=event=>{
    event.preventDefault();const id=renameId,title=renameTitle.value,button=root.querySelector<HTMLButtonElement>('[data-result-rename-save]')!;button.disabled=true;renameError.hidden=true
    void request(`/results/${id}/rename`,{title}).then(async()=>{if(disposed)return;renameDialog.close();showNotice('已重命名结果。');revision='';await refresh()}).catch(value=>{if(!disposed)notify(root,value,'error')}).finally(()=>button.disabled=false)
  }
  root.querySelector<HTMLButtonElement>('[data-results-refresh]')!.onclick=()=>run(refresh)
  const timer=setInterval(()=>{if(visible)void refresh().then(()=>resetNotice(root,'results')).catch(value=>{if(!abort.signal.aborted)report(value)})},3000)
  return {async open(id:string){const response=await request('/results/'+encodeURIComponent(id)),result=await response.json() as ResultDetail&{page_offset?:number};if(disposed)return;clearTimeout(searchTimer);query.value='';offset=result.page_offset??0;selected=id;openTarget=id;followLatest=false;revision='';filterVersion++;generation++;requestVersion++;clearImages();error.hidden=true;await openDetail(id);await refresh()},show(value:boolean){visible=value;if(value)run(refresh);else{dialogs.dispose();if(modal.open)modal.close()}},dispose(){disposed=true;dialogs.dispose();if(modal.open)modal.close();abort.abort();clearInterval(timer);clearTimeout(searchTimer);clearImages();if(renameDialog.open)renameDialog.close();root.replaceChildren()}}
}
