import type { Context } from '@deepseek-ai/cordis'
import { AndroidRuntime } from './runtime.js'
import { DeviceService } from './device.js'
import { registerAndroidTools } from './tools.js'
import { PreferenceStore, dataDirectory, type PluginConfig } from './config.js'
import { TaskLedger } from './tasks.js'
import { ResultStore } from './results.js'
import { FileService } from './files.js'
import { MediaStore } from './media-settings.js'
import { RecordingService } from './recording.js'

/** UI-independent native tool entry for Harness headless/SDK compositions. */
export const name = 'android-native-agent'
export const inject = ['tools', 'attachments', 'llm']
export async function apply(ctx: Context, config: PluginConfig = {}) {
  const directory = dataDirectory(config.dataDir), preferences = new PreferenceStore(directory)
  await preferences.load(config)
  const tasks = new TaskLedger(directory, { maxCalls: preferences.value.maxCalls, timeoutMs: preferences.value.taskTimeoutMs }); await tasks.load()
  const results = new ResultStore(directory); await results.load()
  const device=new DeviceService({ ...config, adbPath: preferences.value.adbPath })
  const runtime = new AndroidRuntime(device, tasks, results)
  const media=new MediaStore(directory);await media.load(Object.fromEntries(['maxSize','maxFps','videoBitRate','audio','audioSource'].filter(key=>config[key as keyof PluginConfig]!==undefined).map(key=>[key,config[key as keyof PluginConfig]])))
  const files=new FileService(device,directory);await files.load();const recordings=new RecordingService(runtime,directory);await recordings.load()
  runtime.extensions={files,media,recordings,async reconnect(serial,signal){await recordings.stop('应用画面参数，已结束当前片段');await runtime.disconnect();signal.throwIfAborted();await runtime.ensure(serial)}}
  ctx.effect(() => async() => {await recordings.stop('插件关闭');await files.close();await runtime.close()})
  registerAndroidTools(ctx, runtime)
}
