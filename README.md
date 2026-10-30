# DeepAndroid

**用自然语言，让 AI 操作你的 Android 手机。**

**简体中文** · [English](README.en.md)

DeepAndroid 是面向 **DeepSeek Harness** 的 Android Agent 插件。它将手机画面、界面操作、文件传输和任务结果接入 Harness，让你在对话中描述目标，由 Agent 调用原生工具执行，并在同一个工作台中观看过程、手动操作和查看结果。

从打开应用、搜索信息，到读取多屏内容、整理表格、传输文件，DeepAndroid 把手机变成 AI 可以观察和操作的工作设备。

## 你可以用它做什么

直接在 Harness 对话中提出任务，例如：

> 打开手机设置，搜索“电池”，读取搜索结果，然后返回桌面。

> 读取当前页面的前 10 条列表内容，整理成表格，保留截图依据；不足 10 条就说明原因。

> 把手机 `/sdcard/Download/report.pdf` 下载到电脑，告诉我实际保存路径和 SHA-256。

> 把电脑上 `D:\Downloads\demo.apk` 安装到手机，并报告实际安装结果。

> 开始录屏，打开设置后返回桌面，停止录屏并告诉我录像保存在哪里。

涉及电脑文件时，需要提供真实存在的路径。任务完成情况取决于应用界面、手机授权和模型能力，可以通过操作记录与截图核对。

## 核心能力

### 对话驱动的手机操作

提供 **44 个 `android_*` 原生 Agent 工具**，由 Harness 自身的 Agent 循环调度：

- **观察与定位**：读取截图和界面元素，按文字或资源 ID 查找目标，跨屏查找与读取。
- **应用与输入**：按应用名或包名启动应用，点击、长按、滑动、输入中英文，使用系统按键与双指手势。
- **视觉操作**：纯截图观察、局部裁剪与放大、图像变化与稳定等待，以及操作后截图，适用于自绘界面等场景。
- **状态与等待**：查询设备、应用和活动通知，等待应用进入前台、通知匹配或文件变化。
- **文件与媒体**：浏览和管理文件、双向传输、安装单个 APK、查询媒体、操作已打开的系统文件选择器。
- **系统与录制**：剪贴板、屏幕电源、旋转、通知面板、画面参数与后台录屏。

截图理解需要 Harness 中配置支持图片输入的模型。文字与元素树读取、视觉观察各有适用场景，Agent 可按任务选择。

### 实时手机工作台

在 Harness 内观看基于 scrcpy 的实时手机画面，使用鼠标、键盘和触控方式直接操作。手动操作可以中断正在进行的 Agent 手势；之后 Agent 需要重新观察手机状态。

面板包含五个页面：

| 页面 | 用途 |
| --- | --- |
| 手机 | 实时投屏、手动输入、系统按键与快捷操作 |
| 文件 | 浏览目录、拖放上传、下载、多选管理与图片预览 |
| 任务 | 查看执行状态、逐步操作记录、读取文字与截图入口 |
| 结果 | 阅读和管理报告，导出表格与截图依据 |
| 调试 | 连接诊断、画面与任务设置、常用任务模板 |

Agent 工具也可通过 `dsh-android/agent` 入口集成到不带 WebServer 或面板的 Harness 环境中。

### 手机文件管理

文件页无需先连接投屏即可使用，支持目录导航、排序筛选、多选、右键菜单、新建文件夹、重命名、复制、移动和删除。

- 拖放或选择多个文件上传，单个或批量下载，传输完成后核对 SHA-256。
- 预览 JPEG、PNG、GIF 和 WebP，支持适应窗口、原始尺寸与 GIF 动画；单张上限 20 MiB。
- 文件冲突可跳过、改名保留或明确覆盖普通文件，删除前确认设备、路径和数量。
- 后台作业支持状态查询与取消，切换页面或刷新不会停止已接收的作业。

单文件上限为 2 GiB。文件操作使用正常 ADB 权限，受 Android 存储与厂商限制约束。

### 可回看的任务与结果

任务记录展示每步调用的状态、耗时、错误及关联截图，方便跟踪执行和定位问题。默认每轮手机任务最多 **100 次工具调用、10 分钟**，可在设置中调整。

跨屏读取可以保留原始采集内容；Agent 可进一步保存表格、摘要和对应截图依据。结果支持搜索、重命名、删除与恢复，并可导出：

- **Markdown**：便于阅读和继续编辑。
- **CSV**：便于导入电子表格。
- **ZIP 依据包**：包含报告、表格、依据元数据和截图原件，便于离线核对。

记录会区分原始采集与 Agent 整理，保留部分完成、缺失内容和失败原因。

## 快速开始

### 1. 准备环境

| 项目 | 要求 |
| --- | --- |
| 宿主 | DeepSeek Harness；当前对接 `0.2.1-rc.2` 的工具 API，声明的宿主范围为 `>=0.2.1-rc.2 <0.3.0` |
| Node.js | 从源码构建或独立运行工具时需 Node.js 22 或更高版本 |
| 手机 | Android 手机、可传输数据的 USB 线，开启 USB 调试并授权这台电脑 |
| 画面显示 | 支持 WebCodecs 的浏览器或 Harness 桌面环境，已在 Chrome 验证 |
| 模型 | 在 Harness 中配置；截图理解与纯视觉操作需要图片输入能力 |

Windows x64 已完成真机验证。安装包内置 Windows ADB、macOS Universal ADB 和 scrcpy 服务端；**macOS 原生启动、系统安全提示与 USB 投屏仍待 Mac 真机验收**。其他平台需自行提供 ADB，尚未声明完成同等验收。

使用内置运行文件时，无需额外安装 Android SDK、桌面 Java、scrcpy 客户端或 FFmpeg。部分 Windows 手机仍需厂商 USB 驱动。

### 2. 获取安装包

使用已有的 `dsh-android-1.9.1.tgz`，或从源码构建：

```sh
git clone https://github.com/PixelsCloud/DeepAndroid.git
cd DeepAndroid
npm ci
npm pack
```

`npm pack` 会自动构建，并在当前目录生成 `dsh-android-1.9.1.tgz`。

### 3. 安装到 Harness

使用与当前 Harness 配套的 `dsh` CLI，将包安装到目标 profile。以下以 `desktop` 为例，在安装包所在目录执行：

```sh
dsh --version
dsh plugin --profile desktop add ./dsh-android-1.9.1.tgz
```

Windows 桌面版可直接使用安装目录中的 CLI；默认安装路径示例：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add .\dsh-android-1.9.1.tgz
```

仓库中的 [Windows 安装脚本](bin/install-profile.ps1) 也支持指定安装包、profile 和 CLI 路径，并在修改前备份 profile 配置。

### 4. 连接并开始使用

1. 重启目标 Harness profile，在 Plugins 页面确认 `dsh-android` 已启用。
2. 用 USB 连接手机，开启 USB 调试，并在手机上确认授权。
3. 打开 Android 面板，选择设备并连接；只有一台已授权手机时可自动选择。
4. 在 Harness 对话中描述手机任务，同时在面板查看执行过程。

连接遇到问题时，先查看“调试”页的连接诊断。从源码构建后，也可在仓库目录执行：

```sh
node bin/doctor.mjs --json
```

该命令检查 ADB、运行文件和 USB 授权状态，不操作手机界面。

## 配置与数据

默认画面设置为最长边 **1280**、最高 **30 FPS**、**4 Mbps**，音频默认关闭。可调整 ADB 路径、画面参数、任务调用次数与时限。

| 配置 | 说明 |
| --- | --- |
| `adbPath` | 默认 `auto`，在支持的平台使用内置 ADB；可指定可执行文件路径 |
| `DSH_ANDROID_ADB_PATH` | 通过环境变量覆盖自动发现的 ADB 路径 |
| `dataDir` / `DSH_ANDROID_DATA_DIR` | 指定插件数据目录 |
| `maxCalls` / `taskTimeoutMs` | 设置每轮 Android 任务的调用次数和时限 |

任务、设置、结果、文件与录像保存在本机插件数据目录，默认位于 `$DSH_HOME/android`，未设置 `DSH_HOME` 时使用用户目录下的 `.dsh/android`。截图原件由 Harness 附件服务管理；迁移时需一并迁移附件数据，或先导出 ZIP 依据包。

手机内容会作为工具结果或图片提供给当前 Harness 会话。模型服务与对话数据处理方式由你的 Harness 配置决定。

## 使用说明

- DeepAndroid 使用常规 ADB 授权，不绕过手机锁屏、存储权限或 USB 安装限制。
- 操作已发送、画面已稳定或通知已出现，都需要结合实际页面或产物核对任务结果。
- 目前支持单个 APK 安装；拆分 APK / XAPK、文件夹上传和文件夹打包下载暂不支持。
- 后台传输取消后可能保留已产生的文件，重启后的未完成作业会标记为中断，需要核对后再继续。

## 开发与验证

```sh
npm ci
npm run typecheck
npm run build
npm test
```

按改动范围选择浏览器或真机验收：

```sh
npm run test:design
npm run test:file-manager-browser
npm run test:native
npm run test:visual-device
npm run test:runtime-package
```

浏览器验收使用本机 Chrome；真机脚本需要已连接并授权的手机，部分脚本会实际操作设备。更多命令见 [package.json](package.json)。

## 文档与第三方资源

- [功能与验收记录](docs/)：各版本的实现范围、验收步骤与已知限制，目前以中文为主。
- [内置运行文件说明](vendor/README.md)：ADB、scrcpy 的来源、校验与升级流程。
- [macOS 验收状态](docs/1.9.0-macOS与ADB启动验收.md)：已验证内容和待完成的 Mac 真机检查。

DeepAndroid 基于 DeepSeek Harness、Tango ADB 和 scrcpy 构建。第三方运行文件、许可证与声明保存在 [vendor](vendor/) 目录，文件版本及 SHA-256 记录于 [runtime-manifest.json](vendor/runtime-manifest.json)。
