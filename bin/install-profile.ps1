param(
  [Parameter(Mandatory=$true)][string]$PackagePath,
  [string]$Profile = 'desktop',
  [string]$DshPath = ''
)
$ErrorActionPreference = 'Stop'
if ($Profile -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$') { throw 'Profile 名称无效' }
$taskPackage = Get-Item -LiteralPath $PackagePath
if ($taskPackage.PSIsContainer -or $taskPackage.Extension -ne '.tgz') { throw '请提供 dsh-android 的 .tgz 安装包' }
if (-not $DshPath) {
  $taskDesktopCli = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
  if (Test-Path -LiteralPath $taskDesktopCli -PathType Leaf) { $DshPath = $taskDesktopCli }
  else { $taskCommand = Get-Command dsh.cmd -ErrorAction SilentlyContinue; if ($taskCommand) { $DshPath = $taskCommand.Source } }
}
if (-not (Test-Path -LiteralPath $DshPath -PathType Leaf)) { throw '未找到 Harness CLI，请用 -DshPath 指定 dsh.cmd' }
$taskCliVersion = (& $DshPath --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw '无法读取 Harness CLI 版本，请检查 -DshPath' }
$taskPluginManifest = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '..\package.json') | ConvertFrom-Json
$taskRequiredVersion = $taskPluginManifest.peerDependencies.'@deepseek-ai/dsh-tools'
if ($taskCliVersion -ne $taskRequiredVersion) { throw "[HARNESS_VERSION_MISMATCH] 此包需要匹配 $taskRequiredVersion 的 Harness CLI，当前为 $taskCliVersion。目标 profile 尚未修改。" }
Write-Output "使用 Harness CLI：$DshPath（$taskCliVersion）"
$taskHarnessHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$taskProfileDir = Join-Path $taskHarnessHome "profiles\$Profile"
if (-not (Test-Path -LiteralPath (Join-Path $taskProfileDir 'package.json'))) {
  if ((Test-Path -LiteralPath $taskProfileDir) -and @(Get-ChildItem -LiteralPath $taskProfileDir -Force).Count -gt 0) { throw '目标 profile 尚未完整初始化，请先检查其中的已有文件' }
  & $DshPath --profile $Profile --from-default-profile web --help
  if ($LASTEXITCODE -ne 0) { throw '初始化 profile 失败' }
}
$taskBackup = Join-Path $taskHarnessHome ('android\install-backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskBackup -Force | Out-Null
foreach ($taskName in @('package.json','pnpm-lock.yaml','cordis.patch.yml')) {
  $taskOriginal = Join-Path $taskProfileDir $taskName
  if (Test-Path -LiteralPath $taskOriginal) { Copy-Item -LiteralPath $taskOriginal -Destination (Join-Path $taskBackup $taskName) }
}
& $DshPath plugin --profile $Profile add --save-exact $taskPackage.FullName
if ($LASTEXITCODE -ne 0) { throw '安装未完成。若提示 pnpm store 版本不同，请使用干净 profile，保留原 profile 与已有插件。' }
Write-Output "已安装到 profile：$Profile。重新启动该 profile 后，在 Android 面板查看连接诊断。"
Write-Output "原 profile 配置备份：$taskBackup"
