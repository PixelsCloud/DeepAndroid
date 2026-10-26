$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskProfile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$taskManifestPath = Join-Path $taskProfile 'package.json'
$taskManifest = Get-Content -Raw -LiteralPath $taskManifestPath | ConvertFrom-Json -AsHashtable
$taskBackup = Join-Path $taskRoot ('.build\installation\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $taskBackup -Force | Out-Null
foreach ($taskFile in @('package.json', 'pnpm-lock.yaml', 'cordis.patch.yml')) {
    $taskOriginal = Join-Path $taskProfile $taskFile
    if (Test-Path -LiteralPath $taskOriginal) { Copy-Item -LiteralPath $taskOriginal -Destination (Join-Path $taskBackup $taskFile) }
}
$taskLink = Join-Path $taskProfile 'node_modules\dsh-android'
if (Test-Path -LiteralPath $taskLink) {
    $taskItem = Get-Item -Force -LiteralPath $taskLink
    if ($taskItem.LinkType -ne 'Junction' -or [IO.Path]::GetFullPath($taskItem.Target) -ne $taskRoot) { throw "Existing plugin path requires review: $taskLink" }
} else {
    New-Item -ItemType Junction -Path $taskLink -Target $taskRoot | Out-Null
}
if (!$taskManifest.ContainsKey('dependencies')) { $taskManifest.dependencies = @{} }
$taskManifest.dependencies['dsh-android'] = 'link:' + $taskRoot
if ($taskManifest.dsh.profile.bundles -notcontains 'dsh-android') { $taskManifest.dsh.profile.bundles += 'dsh-android' }
$taskJson = ($taskManifest | ConvertTo-Json -Depth 30) + "`n"
$taskTemporary = Join-Path $taskProfile 'package.json.android-install.tmp'
[IO.File]::WriteAllText($taskTemporary, $taskJson, [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $taskTemporary -Destination $taskManifestPath -Force
Write-Output "Installed local Android bundle: $taskRoot"
Write-Output "Profile backup: $taskBackup"
