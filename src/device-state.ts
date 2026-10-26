import {PACKAGE_NAME} from './apps.js'

export function packageName(value:unknown):string{
  if(typeof value!=='string'||value.length>255||!PACKAGE_NAME.test(value))throw new Error('应用包名无效，请使用实际应用列表中的 package_name')
  return value
}
function field(text:string,expression:RegExp){return text.match(expression)?.[1]??null}
function number(text:string,expression:RegExp){const value=field(text,expression);return value!==null&&Number.isFinite(Number(value))?Number(value):null}
function boolean(text:string,expression:RegExp){const value=field(text,expression);return value==='true'?true:value==='false'?false:null}
const component=/\b([a-zA-Z][\w]*(?:\.[\w]+)+)\/([.\w$]+)/
export function parseDeviceState(parts:Partial<Record<'activity'|'window'|'input'|'power'|'display'|'battery'|'connectivity',string>>){
  const activity=parts.activity??'',window=parts.window??'',input=parts.input??'',power=parts.power??'',display=parts.display??'',battery=parts.battery??'',network=parts.connectivity??''
  const resumed=activity.split('\n').filter(line=>/topResumedActivity=|mResumedActivity:|mResumedActivity=/.test(line)).map(line=>line.match(component)).filter(match=>match!==null)
  const focused=window.split('\n').filter(line=>/mCurrentFocus=/.test(line)).map(line=>line.match(component)).filter(match=>match!==null)
  const foreground=resumed[0],focus=focused[0],wakefulness=field(power,/\bmWakefulness=(\w+)/)
  const keyguardBlock=window.match(/(?:mKeyguardDelegate|KeyguardServiceDelegate)[\s\S]*?(?=\n\S|$)/)?.[0]??''
  const showing=boolean(window,/\bmKeyguardShowing=(true|false)/)??boolean(window,/\bisStatusBarKeyguard=(true|false)/)??boolean(keyguardBlock,/\bshowing=(true|false)/)
  // mIsInputViewShown is often stale on vendor ROMs; mInputShown describes whether the IME is currently shown.
  const keyboard=boolean(input,/\bmInputShown=(true|false)/)??boolean(input,/\bisInputShown=(true|false)/)
  const rotation=number(display,/\bmCurrentOrientation=([0-3])\b/)
  const level=number(battery,/^\s*level:\s*(\d+)/m),scale=number(battery,/^\s*scale:\s*(\d+)/m),status=number(battery,/^\s*status:\s*(\d+)/m)
  const active=field(network,/Active default network:\s*(\d+|none)/i)??field(network,/\bmActiveDefaultNetwork=(\d+|none)/)
  const sections=network.split(/(?=\bNetworkAgentInfo[\s{])/),activeSection=active&&active!=='none'?sections.find(section=>new RegExp(`^(?:NetworkAgentInfo)[\\s{].*?network\\{${active}\\}`).test(section))??'':''
  const transports=field(activeSection,/Transports:\s*([A-Z_| ]+?)\s+Capabilities:/)?.trim().split(/[|\s]+/).filter(Boolean)??[]
  const capabilities=field(activeSection,/Capabilities:\s*([^\]]+?)(?:\s+LinkUpBandwidth|\s+LinkDnBandwidth|\]|$)/)
  return{
    foreground:foreground?{package_name:foreground[1]!,activity:foreground[2]!}:null,
    focused_window:focus?{package_name:focus[1]!,component:focus[2]!}:null,
    keyboard:{shown:keyboard},
    screen:{wakefulness,interactive:wakefulness&&['Awake','Dreaming'].includes(wakefulness)?true:wakefulness&&['Asleep','Dozing'].includes(wakefulness)?false:null,keyguard_showing:showing,rotation,orientation:rotation===null?null:rotation%2?'landscape':'portrait',physical_power:null},
    battery:{level,scale,percent:level!==null&&scale!==null&&scale>0?Math.round(level/scale*100):null,charging:status===null?null:status===2||status===5,status,temperature_celsius:number(battery,/^\s*temperature:\s*(-?\d+)/m)!==null?number(battery,/^\s*temperature:\s*(-?\d+)/m)!/10:null},
    network:{active_default_network:active,connected:active===null?null:active==='none'?false:activeSection?/\bCONNECTED\b/.test(activeSection):null,transports,validated:capabilities!==null?/(?:^|&)VALIDATED(?:&|\s|$)/.test(capabilities):null},
    guidance:'Snapshot fields come from Android diagnostics sampled over a short interval, not an atomic screen observation. null means unknown. interactive is Android wakefulness, NOT physical panel power: scrcpy may keep mirroring while the physical screen is off. Foreground and focused window may differ when a dialog or IME is present. Query android_observe before coordinate actions; do not assume unknown fields are false.'
  }
}

export function parseAppInfo(text:string,name:string,userId:number){
  packageName(name)
  const marker=`Package [${name}]`,start=text.indexOf(marker)
  if(start<0)return{status:/Unable to find package|No packages? found/i.test(text)?'not_installed' as const:'unconfirmed' as const,package_name:name,user_id:userId}
  const rest=text.slice(start),next=rest.slice(marker.length).search(/\n\s*(?:Package \[|Hidden system packages:|Dexopt state:|Compiler stats:)/),block=next<0?rest:rest.slice(0,next+marker.length)
  const user=block.match(new RegExp(`^\\s*User ${userId}:([^\\n]*)`,'m'))?.[1]??''
  const installed=boolean(user,/\binstalled=(true|false)/),enabled=number(user,/\benabled=(\d+)/)
  const flags=field(block,/\b(?:pkgFlags|flags)=\[([^\]]*)\]/),appId=number(block,/\b(?:userId|appId)=(\d+)/)
  const userStart=block.search(new RegExp(`^\\s*User ${userId}:`,'m')),userRest=userStart<0?'':block.slice(userStart),nextUser=userRest.slice(1).search(/\n\s*User \d+:/),userBlock=nextUser<0?userRest:userRest.slice(0,nextUser+1)
  const installer=field(block,/\binstallerPackageName=([^\s]+)/)
  return{status:installed===false?'not_installed' as const:installed===true?'installed' as const:'unconfirmed' as const,package_name:name,user_id:userId,installed_for_user:installed,version_name:field(block,/\bversionName=([^\r\n]+)/),version_code:field(block,/\bversionCode=(\d+)/),min_sdk:number(block,/\bminSdk=(\d+)/),target_sdk:number(block,/\btargetSdk=(\d+)/),app_id:appId,uid:appId!==null?userId*100000+appId:null,system:flags!==null?/\bSYSTEM\b/.test(flags):null,enabled:enabled===null?null:enabled===0||enabled===1,enabled_setting:enabled,stopped:boolean(user,/\bstopped=(true|false)/),hidden:boolean(user,/\bhidden=(true|false)/),suspended:boolean(user,/\bsuspended=(true|false)/),installer:installer==='null'?null:installer,first_install_time:field(userBlock,/\bfirstInstallTime=([^\r\n]+)/)??field(block,/\bfirstInstallTime=([^\r\n]+)/),last_update_time:field(block,/\blastUpdateTime=([^\r\n]+)/),code_path:field(block,/\bcodePath=([^\r\n]+)/),settings_uri:'package:'+name}
}

export function viewUri(value:unknown){
  if(typeof value!=='string'||value.length>8192||/[\x00-\x20\x7f]/.test(value))throw new Error('链接须为完整 URI，最长 8192 字，空格须编码')
  let uri:URL;try{uri=new URL(value)}catch{throw new Error('链接 URI 无效')}
  if(['javascript:','data:','file:','content:','intent:','about:','blob:'].includes(uri.protocol))throw new Error('不支持该 URI 类型；请提供网页、应用深链或 package:应用包名')
  if(uri.username||uri.password)throw new Error('链接不能包含用户名或密码')
  if(uri.protocol==='package:'){packageName(value.slice('package:'.length));return{uri:value,action:'android.settings.APPLICATION_DETAILS_SETTINGS'}}
  if(['http:','https:'].includes(uri.protocol)&&!uri.hostname)throw new Error('网页链接缺少主机名')
  return{uri:value,action:'android.intent.action.VIEW'}
}

export function parseActivityStart(text:string){
  const failure=text.match(/(?:^|\n)\s*(?:Error(?:\s+type\s+\d+)?\s*:|Exception|SecurityException|Permission Denial)[^\r\n]*/i)?.[0]?.trim()
  if(failure||/unable to resolve Intent|does not exist/i.test(text))return{status:'failed' as const,error:(failure??'没有可处理该链接的应用或目标页面不存在').slice(0,500)}
  if(!/^Status:\s*ok\s*$/im.test(text))return{status:'unconfirmed' as const,error:'系统未返回 Status: ok，请查询设备状态并观察实际界面，不要立即重复打开'}
  const target=field(text,/^Activity:\s*([^\r\n]+)/m)
  return{status:'sent' as const,activity:target,total_time_ms:number(text,/^TotalTime:\s*(\d+)/m),wait_time_ms:number(text,/^WaitTime:\s*(\d+)/m),guidance:'Android accepted the launch. A resolver, browser, login page or app redirect may still be in front; verify with android_device_state and android_observe.'}
}
