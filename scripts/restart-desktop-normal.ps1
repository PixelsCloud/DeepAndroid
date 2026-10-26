$ErrorActionPreference = 'Stop'
$taskApp = Get-CimInstance Win32_Process -Filter "Name = 'DeepSeek Harness.exe'" | Where-Object { $_.CommandLine -notmatch '--type=|--expose-internals' }
if (@($taskApp).Count -ne 1) { throw 'Expected one Harness main process' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AndroidPanelRestartManager {
  [StructLayout(LayoutKind.Sequential)] public struct UniqueProcess { public int ProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME StartTime; }
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] public static extern int RmStartSession(out uint session, int flags, string key);
  [DllImport("rstrtmgr.dll")] public static extern int RmRegisterResources(uint session, uint files, IntPtr fileNames, uint processes, UniqueProcess[] apps, uint services, IntPtr serviceNames);
  [DllImport("rstrtmgr.dll")] public static extern int RmShutdown(uint session, uint flags, IntPtr callback);
  [DllImport("rstrtmgr.dll")] public static extern int RmEndSession(uint session);
}
'@
$taskProcess = Get-Process -Id $taskApp.ProcessId
$taskStart = $taskProcess.StartTime.ToFileTimeUtc()
$taskIdentity = [AndroidPanelRestartManager+UniqueProcess]::new()
$taskIdentity.ProcessId = $taskProcess.Id
$taskIdentity.StartTime.dwLowDateTime = [BitConverter]::ToInt32([BitConverter]::GetBytes([uint32]($taskStart -band 0xffffffffL)), 0)
$taskIdentity.StartTime.dwHighDateTime = [int]($taskStart -shr 32)
$taskSession = [uint32]0
$taskCode = [AndroidPanelRestartManager]::RmStartSession([ref]$taskSession, 0, [Guid]::NewGuid().ToString('N'))
if ($taskCode -ne 0) { throw "Restart Manager start failed: $taskCode" }
try {
  $taskCode = [AndroidPanelRestartManager]::RmRegisterResources($taskSession, 0, [IntPtr]::Zero, 1, @($taskIdentity), 0, [IntPtr]::Zero)
  if ($taskCode -ne 0) { throw "Restart Manager registration failed: $taskCode" }
  # Zero flags requests normal shutdown. Do not request force shutdown if the app refuses.
  $taskCode = [AndroidPanelRestartManager]::RmShutdown($taskSession, 0, [IntPtr]::Zero)
  if ($taskCode -ne 0) { throw "Application refused normal shutdown: $taskCode" }
} finally { [void][AndroidPanelRestartManager]::RmEndSession($taskSession) }
if (-not $taskProcess.WaitForExit(10000)) { throw 'Application did not exit normally' }
Start-Process -FilePath $taskApp.ExecutablePath -WindowStyle Normal
Write-Output 'Harness restarted normally without debugging flags'
