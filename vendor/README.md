# Bundled Android runtime

The package includes Windows ADB and companion DLLs from Google Android SDK
Platform-Tools 37.0.1 (ADB 37.0.1-15733141), macOS Universal ADB 37.0.1 and its
upstream lib64/libc++.dylib, plus the scrcpy 5.0.1 server.
No first-run download is performed.

Sources:
- https://developer.android.com/tools/releases/platform-tools
- https://dl.google.com/android/repository/platform-tools-latest-windows.zip
- https://dl.google.com/android/repository/platform-tools-latest-darwin.zip
- https://github.com/Genymobile/scrcpy/releases/tag/v5.0.1

`runtime-manifest.json` records the downloaded archive SHA-256, version and exact
SHA-256 of every required shipped file. The Google download URL is mutable;
the checked-in files and hashes are pinned, not automatically refreshed during
build or install. Keep `adb/windows/NOTICE.txt`, `source.properties` and
`SCRCPY-LICENSE` with the binaries. `NOTICE.txt` is Google's full upstream notice.

To update ADB, download the official archive into a staging directory, verify its
version and origin, copy adb.exe, AdbWinApi.dll, AdbWinUsbApi.dll,
libwinpthread-1.dll, NOTICE.txt and source.properties, then update the manifest
hashes and version. Review the new archive for additional DLL dependencies.
For macOS also copy adb, lib64/libc++.dylib, NOTICE.txt and source.properties
without modifying binary contents, and update the adbMac manifest entry.
Run typecheck, build, tests and `npm run test:runtime-package` on each target OS.
Do not update only adb.exe independently of its DLLs.

The Windows ADB executable is an x86 PE binary, usable on Windows x86 and x64.
Only Windows x64 is device-tested here. The macOS ADB and dylib are Universal
Mach-O binaries with x86_64 and arm64 slices, verified structurally on Windows;
native Mac launch, Gatekeeper behavior and USB remain pending Mac acceptance.
Other OS/architectures retain external ADB discovery.

Runtime initialization verifies the macOS assets before restoring executable
mode if a Windows-built npm tarball lost it. Installation must be in a writable
user plugin directory if this repair is needed. No postinstall hook, sudo,
quarantine removal or ad-hoc signing is performed. Keep third-party binary
contents intact. macOS security behavior: https://support.apple.com/en-us/102445

The server is Android bytecode executed by Android's app_process, so desktop
Java is unnecessary. Video decoding uses WebCodecs, and recording writes MKV
directly; neither scrcpy.exe nor a desktop FFmpeg installation is needed.
