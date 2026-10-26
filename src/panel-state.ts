import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicJson } from './config.js'
import { DEFAULT_PANEL_STATE, panelPatch, type PanelState } from './panel-state-format.js'
export { DEFAULT_PANEL_STATE, panelPatch, type PanelState } from './panel-state-format.js'
export class PanelStateStore {
  value:PanelState={...DEFAULT_PANEL_STATE}
  warning:string|null=null
  private writes=Promise.resolve()
  constructor(readonly directory?:string){}
  async load(){if(!this.directory)return;try{const raw=await readFile(join(this.directory,'panel-state.json'),'utf8');if(raw.length>4096)throw new Error('oversize');this.value={...DEFAULT_PANEL_STATE,...panelPatch(JSON.parse(raw))}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')this.warning='面板状态无法读取，已使用默认值，原文件保留'}}
  update(input:unknown){const patch=panelPatch(input);const work=this.writes.then(async()=>{const next={...this.value,...patch};if(this.directory)await atomicJson(join(this.directory,'panel-state.json'),next);this.value=next;this.warning=null;return structuredClone(next)});this.writes=work.then(()=>{},()=>{});return work}
  async flush(){await this.writes}
}
