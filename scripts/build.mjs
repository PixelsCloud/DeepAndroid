import { build } from 'esbuild'
import { mkdir, copyFile } from 'node:fs/promises'
await mkdir('dist', { recursive: true })
await build({ entryPoints: ['src/runtime-assets.ts', 'src/adb-server.ts'], outdir: 'dist', bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', sourcemap: true })
const { verifyRuntimeAssets } = await import('../dist/runtime-assets.js')
await verifyRuntimeAssets('adb')
await verifyRuntimeAssets('adbMac')
await verifyRuntimeAssets('scrcpy')
await build({ entryPoints: ['src/host.ts', 'src/device.ts', 'src/wire.ts', 'src/input.ts', 'src/runtime.ts', 'src/observation.ts', 'src/tools.ts', 'src/agent.ts', 'src/apps.ts', 'src/targets.ts', 'src/templates.ts', 'src/adb.ts', 'src/config.ts', 'src/diagnostics.ts', 'src/navigation.ts', 'src/results.ts', 'src/result-format.ts', 'src/result-archive.ts', 'src/panel-state.ts', 'src/panel-state-format.ts','src/file-manager.ts','src/file-manager-model.ts','src/notifications.ts','src/event-waits.ts','src/event-tools.ts','src/media-library.ts','src/file-picker.ts','src/library-tools.ts','src/file-tools.ts','src/remote-files.ts','src/remote-path.ts','src/device-state.ts','src/gestures.ts','src/agent-controls.ts','src/android-shell.ts','src/files.ts','src/media-settings.ts','src/recording.ts','src/extended-tools.ts','src/history-tools.ts','src/page-reading.ts','src/task-feed.ts','src/tasks.ts'], outdir: 'dist', bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', sourcemap: true })
await build({ entryPoints: ['src/ui.ts'], outfile: 'dist/ui.js', bundle: true, platform: 'browser', format: 'esm', target: 'chrome130', legalComments: 'inline', sourcemap: true })
await copyFile('src/client.js', 'dist/client.js')
console.log('Built dsh-android Host, browser loader and video panel')
