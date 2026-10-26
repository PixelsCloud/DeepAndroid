export interface PanelState { version:1; panel:'phone'|'files'|'tasks'|'results'|'debug'; serial:string|null; connection:'auto'|'connected'|'disconnected'; autoOpen:boolean }
export const DEFAULT_PANEL_STATE:PanelState={version:1,panel:'phone',serial:null,connection:'auto',autoOpen:true}
export function panelPatch(input:unknown):Partial<PanelState>{
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('面板状态格式无效')
  const value=input as Record<string,unknown>,patch:Partial<PanelState>={}
  if(Object.keys(value).some(key=>!['version','panel','serial','connection','autoOpen'].includes(key)))throw new Error('面板状态包含未知字段')
  if(value.version!==undefined&&value.version!==1)throw new Error('面板状态版本无效')
  if(value.panel!==undefined){if(typeof value.panel!=='string'||!['phone','files','tasks','results','debug'].includes(value.panel))throw new Error('面板页面无效');patch.panel=value.panel as PanelState['panel']}
  if(value.serial!==undefined){if(value.serial!==null&&(typeof value.serial!=='string'||!value.serial.trim()||value.serial.length>128||/[\r\n\0]/.test(value.serial)))throw new Error('设备序列号无效');patch.serial=value.serial as string|null}
  if(value.connection!==undefined){if(typeof value.connection!=='string'||!['auto','connected','disconnected'].includes(value.connection))throw new Error('连接选择无效');patch.connection=value.connection as PanelState['connection']}
  if(value.autoOpen!==undefined){if(typeof value.autoOpen!=='boolean')throw new Error('启动恢复选项无效');patch.autoOpen=value.autoOpen}
  return patch
}
