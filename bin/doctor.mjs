#!/usr/bin/env node
import { DeviceService } from '../dist/device.js'
const input=process.argv.slice(2)
if(input.includes('--help')) {
  console.log('dsh-android-doctor [--json] [--adb <path>]\n检查本机 ADB 与 USB 授权状态，不操作手机界面。')
} else {
  const index=input.indexOf('--adb')
  if(index>=0&&!input[index+1])throw new Error('--adb 需要提供可执行文件路径')
  const service=new DeviceService(index>=0?{adbPath:input[index+1]}:{})
  const result=await service.diagnose()
  console.log(input.includes('--json')?JSON.stringify(result,null,2):`${result.diagnostic.message}\n${result.diagnostic.recovery}${result.adb?'\n'+result.adb.version+'\n'+result.adb.path:''}`)
  process.exitCode=result.ok?0:1
}
