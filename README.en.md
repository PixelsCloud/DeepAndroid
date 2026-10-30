# DeepAndroid

**Let AI operate your Android phone through natural language.**

[简体中文](README.md) · **English**

DeepAndroid is an Android Agent plugin for **DeepSeek Harness**. It brings phone screens, device controls, file transfers, and task results into Harness. Describe a goal in chat, let the Agent execute it through native tools, and use the same workspace to watch progress, operate the phone manually, and review the outcome.

From opening apps and searching for information to reading multiple screens, building tables, and moving files, DeepAndroid makes your phone a device that AI can observe and operate.

## What you can do

Ask for tasks directly in your Harness conversation:

> Open Settings on my phone, search for “battery,” read the search results, then return to the home screen.

> Read the first 10 items in the current list, organize them into a table, and keep screenshots as evidence. Explain if fewer than 10 items are available.

> Download `/sdcard/Download/report.pdf` from my phone to this computer, and report the actual saved path and SHA-256.

> Install `D:\Downloads\demo.apk` from my computer on the phone and report the actual installation result.

> Start recording, open Settings, return to the home screen, then stop recording and tell me where the video was saved.

For files on your computer, provide a path that actually exists. Results depend on the app interface, device permissions, and model capabilities. Use the operation history and screenshots to check the outcome.

## Core features

### Phone operations through conversation

DeepAndroid provides **44 native `android_*` Agent tools**, dispatched by the existing Harness Agent loop:

- **Observe and locate:** capture screenshots and UI elements, find targets by text or resource ID, and search or read across screens.
- **Apps and input:** launch apps by name or package, tap, long press, swipe, enter Chinese or English text, and use system keys and two-finger gestures.
- **Visual operations:** screenshot-only observation, cropping and zooming, image change and stability waits, and screenshots after actions for custom-rendered interfaces and similar tasks.
- **State and waits:** inspect devices, apps, and active notifications; wait for an app to enter the foreground, a matching notification, or a file change.
- **Files and media:** browse and manage files, transfer in either direction, install individual APKs, query media, and interact with an already-open system file picker.
- **System and recording:** clipboard, display power, rotation, notification shade, capture settings, and background screen recording.

Screenshot understanding requires a model configured in Harness that supports image input. The Agent can choose UI element inspection or visual observation to suit the task.

### A live phone workspace

Watch a live scrcpy-powered phone screen inside Harness and interact with mouse, keyboard, and touch controls. Manual input can interrupt an ongoing Agent gesture; the Agent must then observe the phone again before continuing.

The panel has five views. The current interface uses these Chinese labels:

| View | Purpose |
| --- | --- |
| Phone · 手机 | Live screen, manual input, system keys, and quick actions |
| Files · 文件 | Directory browsing, drag-and-drop uploads, downloads, batch operations, and image previews |
| Tasks · 任务 | Execution status, step history, captured text, and screenshot access |
| Results · 结果 | Report management, table exports, and screenshot evidence |
| Debug · 调试 | Connection diagnostics, capture and task settings, and task templates |

The `dsh-android/agent` entry also supports integrating the tools into Harness environments without a WebServer or panel.

### Phone file management

Use the Files view without first starting screen streaming. It supports directory navigation, sorting and filtering, multiple selection, context menus, folder creation, renaming, copying, moving, and deletion.

- Upload multiple files by dropping or selecting them, download individual files or batches, and verify SHA-256 after transfers.
- Preview JPEG, PNG, GIF, and WebP images with fit-to-window and original-size views. Animated GIFs are supported; the limit is 20 MiB per preview.
- Resolve conflicts by skipping, keeping a renamed copy, or explicitly overwriting a regular file. Deletion requires confirmation of the device, paths, and item count.
- Query or cancel background jobs. Switching views or refreshing does not stop accepted jobs.

The maximum individual file size is 2 GiB. File operations use normal ADB permissions and remain subject to Android storage and vendor restrictions.

### Reviewable tasks and results

Task history shows each call's status, duration, errors, and associated screenshots. By default, each Android task is limited to **100 tool calls and 10 minutes**, adjustable in settings.

Reading across screens can preserve the raw captured content. The Agent can then save tables, summaries, and references to screenshot evidence. Results support search, renaming, deletion, and restoration, with exports in:

- **Markdown:** for reading and further editing.
- **CSV:** for spreadsheets.
- **ZIP evidence packages:** reports, tables, evidence metadata, and original screenshots for offline review.

Records distinguish raw captures from Agent-prepared reports and retain partial completion, missing content, and failure reasons.

## Quick start

### 1. Prepare your environment

| Component | Requirement |
| --- | --- |
| Host | DeepSeek Harness; currently integrated with the `0.2.1-rc.2` tool API, with a declared host range of `>=0.2.1-rc.2 <0.3.0` |
| Node.js | Node.js 22 or later for source builds or standalone tool execution |
| Phone | An Android phone, a USB data cable, USB debugging enabled, and authorization for this computer |
| Screen display | A browser or Harness desktop environment with WebCodecs support; verified in Chrome |
| Model | Configured in Harness; screenshot understanding and visual-only operations require image input support |

Physical-device testing has been completed on Windows x64. The package bundles Windows ADB, macOS Universal ADB, and the scrcpy server. **Native macOS startup, system security prompts, and USB streaming still require testing on a Mac.** Other platforms require an external ADB installation and have not been validated to the same extent.

With the bundled runtime, no separate Android SDK, desktop Java, scrcpy client, or FFmpeg installation is required. Some phones may still need a vendor USB driver on Windows.

### 2. Get the package

Use an existing `dsh-android-1.9.1.tgz` package, or build it from source:

```sh
git clone https://github.com/PixelsCloud/DeepAndroid.git
cd DeepAndroid
npm ci
npm pack
```

`npm pack` builds the project automatically and creates `dsh-android-1.9.1.tgz` in the current directory.

### 3. Install in Harness

Use the `dsh` CLI supplied with your Harness installation to add the package to the target profile. This example uses `desktop`; run it from the directory containing the package:

```sh
dsh --version
dsh plugin --profile desktop add ./dsh-android-1.9.1.tgz
```

On Windows, you can invoke the desktop installation's CLI directly. For the default installation path:

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add .\dsh-android-1.9.1.tgz
```

The repository's [Windows installation script](bin/install-profile.ps1) also accepts a package path, profile, and CLI path, and backs up profile configuration before making changes.

### 4. Connect and start

1. Restart the target Harness profile and confirm that `dsh-android` is enabled on the Plugins page.
2. Connect your phone by USB, enable USB debugging, and approve the authorization prompt on the phone.
3. Open the Android panel, select a device, and connect. A single authorized phone can be selected automatically.
4. Describe a phone task in Harness chat and watch its progress in the panel.

For connection problems, check the diagnostics in the Debug view. After building from source, you can also run this from the repository directory:

```sh
node bin/doctor.mjs --json
```

This checks ADB, runtime assets, and USB authorization without interacting with the phone interface.

## Configuration and data

Default capture settings are a **1280-pixel** maximum edge, up to **30 FPS**, and **4 Mbps**, with audio disabled. ADB paths, capture settings, task call limits, and timeouts are configurable.

| Setting | Purpose |
| --- | --- |
| `adbPath` | Defaults to `auto`, using bundled ADB on supported platforms; accepts an explicit executable path |
| `DSH_ANDROID_ADB_PATH` | Overrides automatic ADB discovery through an environment variable |
| `dataDir` / `DSH_ANDROID_DATA_DIR` | Sets the plugin data directory |
| `maxCalls` / `taskTimeoutMs` | Sets the call limit and timeout for each Android task |

Tasks, settings, results, files, and recordings are stored in the local plugin data directory: `$DSH_HOME/android`, or `.dsh/android` under your user directory when `DSH_HOME` is unset. Original screenshots are managed by the Harness attachment service. Include attachment data when migrating, or export ZIP evidence packages first.

Phone content is supplied to the current Harness conversation as tool results or images. Your Harness configuration determines the model service and how conversation data is handled.

## Usage notes

- DeepAndroid uses normal ADB authorization and respects the phone's lock screen, storage permissions, and USB installation restrictions.
- A sent action, stable screen, or matching notification still needs to be checked against the actual page or output to confirm the task's result.
- Individual APK installation is supported. Split APKs / XAPK, folder uploads, and downloading folders as archives are not currently supported.
- Cancelled background transfers may leave files already created. Unfinished jobs found after a restart are marked as interrupted and require verification before continuing.

## Development and verification

```sh
npm ci
npm run typecheck
npm run build
npm test
```

Select browser or physical-device checks according to the changes:

```sh
npm run test:design
npm run test:file-manager-browser
npm run test:native
npm run test:visual-device
npm run test:runtime-package
```

Browser checks use a locally installed Chrome. Physical-device scripts require a connected, authorized phone, and some scripts interact with the device. See [package.json](package.json) for more commands.

## Documentation and third-party resources

- [Feature and acceptance records](docs/): implementation scope, verification steps, and known limitations by version, currently mostly in Chinese.
- [Bundled runtime notes](vendor/README.md): ADB and scrcpy sources, integrity checks, and update procedures.
- [macOS validation status](docs/1.9.0-macOS与ADB启动验收.md): completed checks and pending Mac device testing.

DeepAndroid builds on DeepSeek Harness, Tango ADB, and scrcpy. Third-party runtime files, licenses, and notices are in [vendor](vendor/). Versions and SHA-256 hashes are recorded in [runtime-manifest.json](vendor/runtime-manifest.json).
