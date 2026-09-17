# ============================================================
#  API余额通 打包脚本
#  用法：
#    pwsh -File 打包.ps1              # 仅桌面便携版 exe
#    pwsh -File 打包.ps1 -Android     # 桌面 exe + 安卓 APK（需在 UAC 弹窗点“是”）
#  产物自动命名带时间戳（yyMMdd.HHmm），复制到桌面：
#    API余额通_<时间戳>.exe / API余额通-安卓_<时间戳>.apk
# ============================================================
param([switch]$Android)
$ErrorActionPreference = 'Stop'
$proj = 'D:\DeepSeek\api-quota-monitor-tauri'
$desktop = [Environment]::GetFolderPath('Desktop')
$stamp = Get-Date -Format 'yyMMdd.HHmm'

Write-Host "== 打包开始（时间戳 $stamp）=="
Set-Location $proj

# ---------- 0) 生成内嵌 runtime.zip（方案 A：node.exe + playwright 打进 exe） ----------
# ⚠️ 必须剔除 web_state/（登录态含站点 cookie，属用户隐私，绝不能随 exe 分发）：
# 先复制 minmax 到临时干净目录再压缩
Write-Host '== 生成内嵌运行时 runtime.zip（剔除登录态）=='
Add-Type -AssemblyName System.IO.Compression.FileSystem
$runtimeZip = "$proj\src-tauri\runtime.zip"
$tmpMin = Join-Path $env:TEMP 'aqm_runtime_src'
if (Test-Path $tmpMin) { Remove-Item $tmpMin -Recurse -Force }
New-Item -ItemType Directory -Path $tmpMin -Force | Out-Null
Copy-Item "$proj\minmax\*" $tmpMin -Recurse -Force
$tmpState = Join-Path $tmpMin 'web_state'
if (Test-Path $tmpState) { Remove-Item $tmpState -Recurse -Force }
if (Test-Path $runtimeZip) { Remove-Item $runtimeZip -Force }
[System.IO.Compression.ZipFile]::CreateFromDirectory($tmpMin, $runtimeZip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
Remove-Item $tmpMin -Recurse -Force
if (-not (Test-Path $runtimeZip)) { throw 'runtime.zip 生成失败' }
Write-Host "✅ 内嵌运行时: $runtimeZip ($([math]::Round((Get-Item $runtimeZip).Length/1MB,1)) MB，构建时将嵌入 exe；不含登录态"

# ---------- 1) 桌面便携版 exe ----------
Write-Host '== 构建桌面 exe =='
pnpm tauri build --no-bundle
if ($LASTEXITCODE -ne 0) { throw '桌面构建失败' }
$exe = "$proj\src-tauri\target\release\api-quota-monitor-tauri.exe"
$exeDst = Join-Path $desktop "API余额通_$stamp.exe"
Copy-Item $exe $exeDst -Force
Write-Host "✅ 桌面: $exeDst（单文件，内含 node.exe + playwright 运行时，目标机仅需系统 Edge）"

# ---------- 2) 安卓 APK（可选，需管理员） ----------
if ($Android) {
  Write-Host '== 触发安卓构建（请在 UAC 弹窗点“是”）=='
  $log = 'D:\android-arm64-build.log'
  Remove-Item $log -ErrorAction SilentlyContinue
  $bat = Join-Path $env:TEMP 'build_android_arm64.bat'
  @"
@echo off
cd /d $proj
set PATH=%USERPROFILE%\.cargo\bin;%PATH%
set ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk
set JAVA_HOME=C:\Users\chao\AppData\Local\Programs\Eclipse Adoptium\jdk-17.0.20+8
echo [%date% %time%] started > $log
call pnpm tauri android build --apk --target aarch64 >> $log 2>&1
echo [%date% %time%] BUILD_EXIT=%ERRORLEVEL% >> $log
"@ | Set-Content -Path $bat -Encoding UTF8
  Start-Process -FilePath $bat -Verb RunAs

  # 等待构建完成（最长 50 分钟）
  $deadline = (Get-Date).AddMinutes(50)
  while (-not (Test-Path $log)) { Start-Sleep -Seconds 5 }
  $done = $false
  while ((Get-Date) -lt $deadline) {
    if ((Get-Content $log -Raw -ErrorAction SilentlyContinue) -match 'BUILD_EXIT=') { $done = $true; break }
    Start-Sleep -Seconds 20
  }
  if (-not $done) { throw '安卓构建超时（50 分钟），见 D:\android-arm64-build.log' }
  if ((Get-Content $log -Raw) -notmatch 'BUILD_EXIT=0') { throw '安卓构建失败，见 D:\android-arm64-build.log' }

  # ---------- 3) 签名 + 复制 ----------
  $env:JAVA_HOME = 'C:\Users\chao\AppData\Local\Programs\Eclipse Adoptium\jdk-17.0.20+8'
  $env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
  $apksigner = 'C:\Users\chao\AppData\Local\Android\Sdk\build-tools\35.0.0\apksigner.bat'
  $apkSrc = "$proj\src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release-unsigned.apk"
  $apkDst = Join-Path $desktop "API余额通-安卓_$stamp.apk"
  $ks = "$env:USERPROFILE\.android\debug.keystore"
  & $apksigner sign --ks $ks --ks-pass pass:android --ks-key-alias androiddebugkey --key-pass pass:android --out $apkDst $apkSrc
  if (-not (Test-Path $apkDst)) { throw 'APK 签名失败' }
  Write-Host "✅ 安卓: $apkDst"
  # 清理桌面旧 APK（连带 .idsig 签名验证文件）：只保留本次产物（用户要求每次构建后删除旧包）
  Get-ChildItem $desktop -Filter "API余额通-安卓_*.apk" -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -ne $apkDst } |
    ForEach-Object {
      Remove-Item $_.FullName -Force
      Remove-Item "$($_.FullName).idsig" -Force -ErrorAction SilentlyContinue
      Write-Host "已删除旧 APK: $($_.Name)"
    }
  # 本次产物的 .idsig 也一并清理（签名验证文件无分发价值）
  Remove-Item "$apkDst.idsig" -Force -ErrorAction SilentlyContinue
}

Write-Host '== 打包完成 =='
