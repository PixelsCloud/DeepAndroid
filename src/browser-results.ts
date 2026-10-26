import { resultCsv, sourceNumbers, type SavedResult } from './result-format.js'
type ResultDetail = SavedResult & {task_state?:{status:string;reason:string|null}|null}
type Summary = Omit<SavedResult,'rows'|'sources'|'summary'|'columns'|'observation_ids'> & {row_count:number;source_count:number}
const headers={'x-android-client':'1'}
type ResultPage={results:Summary[];warning:string|null;total:number;total_all:number;deleted_count:number;offset:number;limit:number;has_more:boolean}
export function mountResults(root: HTMLElement) {
  root.innerHTML=`<style>
  .android-results{font:12px/1.6 system-ui;min-width:0}.android-results a{color:#6cad94}.android-results h2{font-size:17px;margin:12px 0 4px}.android-results p{white-space:pre-wrap;overflow-wrap:anywhere}.android-results .result-list{display:flex;flex-direction:column;gap:6px;max-height:180px;overflow:auto;margin:10px 0}.android-results .result-list button{text-align:left}.android-results [aria-pressed=true]{border-color:#168468}.android-results .result-actions{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}.android-results .result-note{color:#929b9a}.android-results .result-error{color:#e68f8f}.android-results .result-table{max-width:100%;overflow:auto;border:1px solid #8883;border-radius:8px}.android-results table{border-collapse:collapse;min-width:100%;text-align:left}.android-results th,.android-results td{padding:8px 10px;border-bottom:1px solid #8883;min-width:100px;max-width:320px;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere}.android-results th{background:#8881}.android-results .result-wide-column{min-width:260px;max-width:440px}.android-results .result-short-column{min-width:60px;max-width:120px}.android-results td button{padding:3px 6px;margin:2px;font-size:11px}.android-results .result-evidence{width:min(620px,calc(100vw - 32px));max-height:85vh;overflow:auto;color:inherit;background:#15191e;border:1px solid #8886;border-radius:12px;padding:14px}.android-results .result-evidence::backdrop{background:#0009}.android-results .result-evidence img{max-width:100%;max-height:min(62vh,600px);display:block;margin:10px auto}.android-results .result-summary{border-left:2px solid #168468;padding-left:10px}
  .android-results .result-toolbar,.android-results .result-paging{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.android-results .result-filters{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:10px 0}.android-results .result-filters label{display:flex;flex-direction:column;gap:4px;min-width:0}.android-results .result-query{grid-column:1/-1}.android-results input{font:inherit;border:1px solid #8885;border-radius:7px;padding:7px 8px;background:transparent;color:inherit;min-width:0;width:100%;color-scheme:dark}.android-results .result-notice{padding:8px 10px;border:1px solid #16846866;border-radius:7px;margin:10px 0}.android-results .result-notice button{margin-left:8px}.android-results .result-rename{width:min(420px,calc(100vw - 32px));color:inherit;background:#15191e;border:1px solid #8886;border-radius:12px;padding:18px}.android-results .result-rename::backdrop{background:#0009}.android-results .result-rename label{display:flex;flex-direction:column;gap:8px}.android-results .result-rename footer{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
  </style><div class="android-results"><div class="result-toolbar"><button data-results-refresh>刷新结果</button><select data-results-scope aria-label="结果范围"><option value="active">全部结果</option><option value="deleted">最近删除</option></select><button data-results-clear>清空筛选</button></div><div class="result-filters"><label class="result-query">搜索<input type="search" data-results-query aria-label="搜索结果" placeholder="搜索标题、摘要或表格内容" maxlength="256"></label><label>开始日期<input type="date" data-results-from aria-label="开始日期"></label><label>结束日期<input type="date" data-results-to aria-label="结束日期"></label></div><p class="result-note" data-results-count></p><div class="result-notice" data-results-notice role="status" hidden><span></span><button data-results-undo hidden>撤销</button></div><p class="result-note" data-results-note>Agent 整理的表格与摘要保存在这里，可查看截图依据、复制和导出。</p><p class="result-error" role="note" data-results-error hidden></p><div class="result-list" aria-label="已保存结果"></div><div class="result-paging"><button data-results-prev>上一页</button><span data-results-page></span><button data-results-next>下一页</button></div><div class="result-detail"></div><dialog class="result-rename" aria-label="重命名结果"><form data-result-rename-form><label>结果标题<input data-result-rename-title aria-label="结果标题" maxlength="100" required></label><p class="result-error" data-result-rename-error hidden></p><footer><button type="button" data-result-rename-cancel>取消</button><button type="submit" data-result-rename-save>保存名称</button></footer></form></dialog></div>`
  const list=root.querySelector<HTMLElement>('.result-list')!,detail=root.querySelector<HTMLElement>('.result-detail')!,error=root.querySelector<HTMLElement>('[data-results-error]')!,abort=new AbortController()
  let visible=false,disposed=false,selected='',revision='',generation=0,requestVersion=0,followLatest=true,refreshing=false,refreshAgain=false,filterVersion=0,offset=0,total=0,renameId='',openTarget=''
  let searchTimer:ReturnType<typeof setTimeout>|undefined
  const scope=root.querySelector<HTMLSelectElement>('[data-results-scope]')!,query=root.querySelector<HTMLInputElement>('[data-results-query]')!,from=root.querySelector<HTMLInputElement>('[data-results-from]')!,to=root.querySelector<HTMLInputElement>('[data-results-to]')!,count=root.querySelector<HTMLElement>('[data-results-count]')!,previous=root.querySelector<HTMLButtonElement>('[data-results-prev]')!,next=root.querySelector<HTMLButtonElement>('[data-results-next]')!,pageLabel=root.querySelector<HTMLElement>('[data-results-page]')!,notice=root.querySelector<HTMLElement>('[data-results-notice]')!,undo=root.querySelector<HTMLButtonElement>('[data-results-undo]')!,renameDialog=root.querySelector<HTMLDialogElement>('.result-rename')!,renameTitle=root.querySelector<HTMLInputElement>('[data-result-rename-title]')!,renameError=root.querySelector<HTMLElement>('[data-result-rename-error]')!
  const urls=new Set<string>()
  function text(parent:Element,value:string,tag='p',className=''){const node=document.createElement(tag);node.textContent=value;node.className=className;parent.appendChild(node);return node}
  function report(value:unknown){if(!disposed){error.hidden=false;error.textContent=value instanceof Error?value.message:String(value)}}
  const run=(work:()=>Promise<void>)=>{error.hidden=true;void work().catch(value=>{if(!abort.signal.aborted)report(value)})}
  async function request(path:string,input?:object){const response=await fetch('/x-android'+path,{method:input?'POST':'GET',headers:input?{...headers,'content-type':'application/json'}:headers,body:input?JSON.stringify(input):undefined,signal:AbortSignal.any([abort.signal,AbortSignal.timeout(30000)])});if(!response.ok){let message='请求失败';try{const value=await response.json();message=[value.error,value.recovery].filter(Boolean).join('。')}catch{}throw new Error(message)}return response}
  function clearImages(){for(const dialog of root.querySelectorAll<HTMLDialogElement>('dialog.result-evidence'))if(dialog.open)dialog.close();for(const url of urls)URL.revokeObjectURL(url);urls.clear()}
  async function download(result:SavedResult,format:'markdown'|'csv'|'bundle'){
    const response=await request(`/results/${result.id}/export?format=${format}`),url=URL.createObjectURL(await response.blob())
    if(disposed){URL.revokeObjectURL(url);return}
    const anchor=document.createElement('a');anchor.href=url;anchor.download=`android-result-${result.id}.${format==='markdown'?'md':format==='csv'?'csv':'zip'}`;document.body.appendChild(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)
  }
  async function showSource(result:SavedResult,index:number,area:HTMLDialogElement,own:number){
    const response=await request(`/results/${result.id}/source/${index+1}`),blob=await response.blob()
    if(disposed||own!==generation||selected!==result.id)return
    clearImages();area.replaceChildren();const source=result.sources[index]!
    const close=document.createElement('button');close.textContent='关闭截图';close.style.float='right';close.onclick=()=>area.close();area.appendChild(close)
    text(area,`截图 ${index+1} · ${new Date(source.captured_at).toLocaleString()}`,'p','result-note')
    const url=URL.createObjectURL(blob);urls.add(url);const image=document.createElement('img');image.src=url;image.alt=`${result.title}的截图依据 ${index+1}`;area.appendChild(image)
    const link=document.createElement('a');link.href=url;link.download=`evidence-${index+1}.png`;link.textContent='下载此截图';area.appendChild(link)
    area.showModal()
  }
  async function render(id:string){
    const own=++requestVersion,response=await request('/results/'+id+(scope.value==='deleted'?'?deleted=1':'')),result=await response.json() as ResultDetail
    if(disposed||selected!==id||own!==requestVersion)return
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
    button(actions,'删除',async()=>{openTarget='';await request(`/results/${id}/delete`,{});showNotice(`已删除“${result.title}”。`,()=>restore(id,result.title));revision='';await refresh()})
    button(actions,result.rows.length?'复制表格':'复制内容',async()=>{
      const value=resultCsv(result,'\t')
      try{await navigator.clipboard.writeText(value)}catch{
        const input=document.createElement('textarea');input.value=value;input.style.position='fixed';input.style.opacity='0';root.appendChild(input);input.select();const ok=document.execCommand('copy');input.remove();if(!ok)throw new Error('无法复制，请导出文件')
      }
      if(!disposed&&selected===id)text(actions,'已复制，可粘贴到表格或文档。','span','result-note')
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
  function showNotice(message:string,undoWork?:()=>Promise<void>){notice.hidden=false;notice.querySelector('span')!.textContent=message;undo.hidden=!undoWork;undo.onclick=undoWork?()=>run(undoWork):null}
  async function restore(id:string,title:string){await request(`/results/${id}/restore`,{});showNotice(`已恢复“${title}”。${scope.value==='deleted'?'可切回全部结果查看。':''}`);revision='';await refresh()}
  function time(value:string,nextDay=false){const [year,month,day]=value.split('-').map(Number),date=new Date(0);date.setFullYear(year!,month!-1,day!);date.setHours(0,0,0,0);if(nextDay)date.setDate(date.getDate()+1);return date.toISOString()}
  function parameters(){const params=new URLSearchParams({query:query.value,offset:String(offset),limit:'20'});if(scope.value==='deleted')params.set('deleted','1');if(from.value)params.set('from',time(from.value));if(to.value)params.set('before',time(to.value,true));return params}
  function changeFilters(){openTarget='';clearTimeout(searchTimer);offset=0;followLatest=true;filterVersion++;selected='';revision='';generation++;requestVersion++;clearImages();detail.replaceChildren();list.replaceChildren();text(list,'正在筛选…','p','result-note');count.textContent='';previous.disabled=true;next.disabled=true;run(refresh)}
  async function refresh(){
    if(disposed)return
    if(refreshing){refreshAgain=true;return}
    refreshing=true
    const own=filterVersion
    try{
      const response=await request('/results?'+parameters()),value=await response.json() as ResultPage
      if(disposed||own!==filterVersion)return
      if(value.warning)report(value.warning)
      total=value.total
      if(total&&offset>=total){offset=Math.floor((total-1)/20)*20;filterVersion++;refreshAgain=true;return}
      count.textContent=`${scope.value==='deleted'?'最近删除':'全部结果'} ${scope.value==='deleted'?value.deleted_count:value.total_all} 份 · 符合条件 ${total} 份`
      scope.querySelector('option[value=deleted]')!.textContent=`最近删除（${value.deleted_count}）`
      previous.disabled=offset===0;next.disabled=!value.has_more;pageLabel.textContent=total?`${offset+1}–${Math.min(offset+20,total)} / ${total}`:'0 / 0'
      list.replaceChildren()
      if(!value.results.length){openTarget='';selected='';revision='';generation++;clearImages();detail.replaceChildren();text(list,query.value||from.value||to.value?'没有符合条件的结果，请调整搜索、日期或清空筛选。':scope.value==='deleted'?'最近删除为空。':'暂无结果。让 Agent 读取内容并保存结果后，会显示在这里。','p','result-note');return}
      if((followLatest&&offset===0)||(!openTarget&&!value.results.some(result=>result.id===selected))){if(selected!==value.results[0]!.id){selected=value.results[0]!.id;revision=''}}
      for(const result of value.results){const button=document.createElement('button');button.textContent=`${result.title} · ${result.origin==='agent'?'Agent 整理':'原始采集'} · ${result.row_count?`${result.row_count} 条`:`${result.source_count} 张依据`} · ${new Date(result.created_at).toLocaleString()}`;button.setAttribute('aria-pressed',String(result.id===selected));button.onclick=()=>{openTarget='';followLatest=false;selected=result.id;revision='';for(const item of list.querySelectorAll('button'))item.setAttribute('aria-pressed',String(item===button));run(()=>render(selected))};list.appendChild(button)}
      await render(selected)
    }catch(value){if(disposed||own!==filterVersion)return;if(own===filterVersion){list.replaceChildren();text(list,'无法获取结果，请检查筛选条件或重试。','p','result-note');count.textContent='筛选未完成';detail.replaceChildren()}throw value}finally{refreshing=false;if(refreshAgain&&!disposed){refreshAgain=false;run(refresh)}}
  }
  query.oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(changeFilters,250)}
  scope.onchange=changeFilters;from.onchange=changeFilters;to.onchange=changeFilters
  root.querySelector<HTMLButtonElement>('[data-results-clear]')!.onclick=()=>{clearTimeout(searchTimer);query.value='';from.value='';to.value='';changeFilters()}
  previous.onclick=()=>{openTarget='';offset=Math.max(0,offset-20);followLatest=false;filterVersion++;run(refresh)}
  next.onclick=()=>{openTarget='';if(offset+20<total){offset+=20;followLatest=false;filterVersion++;run(refresh)}}
  root.querySelector<HTMLButtonElement>('[data-result-rename-cancel]')!.onclick=()=>renameDialog.close()
  root.querySelector<HTMLFormElement>('[data-result-rename-form]')!.onsubmit=event=>{
    event.preventDefault();const id=renameId,title=renameTitle.value,button=root.querySelector<HTMLButtonElement>('[data-result-rename-save]')!;button.disabled=true;renameError.hidden=true
    void request(`/results/${id}/rename`,{title}).then(async()=>{if(disposed)return;renameDialog.close();showNotice('已重命名结果。');revision='';await refresh()}).catch(value=>{if(!disposed){renameError.hidden=false;renameError.textContent=value instanceof Error?value.message:String(value)}}).finally(()=>button.disabled=false)
  }
  root.querySelector<HTMLButtonElement>('[data-results-refresh]')!.onclick=()=>run(refresh)
  const timer=setInterval(()=>{if(visible)void refresh().catch(value=>{if(!abort.signal.aborted)report(value)})},3000)
  return {async open(id:string){const response=await request('/results/'+encodeURIComponent(id)),result=await response.json() as ResultDetail&{page_offset?:number};if(disposed)return;clearTimeout(searchTimer);scope.value='active';query.value='';from.value='';to.value='';offset=result.page_offset??0;selected=id;openTarget=id;followLatest=false;revision='';filterVersion++;generation++;requestVersion++;clearImages();error.hidden=true;await render(id);await refresh()},show(value:boolean){visible=value;if(value)run(refresh)},dispose(){disposed=true;abort.abort();clearInterval(timer);clearTimeout(searchTimer);clearImages();if(renameDialog.open)renameDialog.close();root.replaceChildren()}}
}
