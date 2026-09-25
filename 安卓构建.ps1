# 安卓端「免提权」出包脚本（2026-09/19 建）
#
# 为什么需要这个脚本：
#   Windows 上 `pnpm tauri android build` 会把 target 里的 lib*.so **符号链接**进
#   `gen/android/app/src/main/jniLibs/<abi>/`，而在 Windows 建符号链接需要「开发人员模式」
#   或管理员权限。本机两者都没有 → 那条路会停在：
#     Failed to create a symbolic link from "...\target\x86_64-linux-android\release\lib*.so"
#     Creation symbolic link is not allowed for this system. ... use developer mode.
#   本脚本用**真实文件拷贝**代替符号链接，并跳过 Gradle 里调用 tauri CLI 的那个任务
#   （`:app:assemble<Flavor>Release -x rustBuild<Flavor>Release`），于是**不需要任何提权**也能出包。
#
# 步骤（每一步都与 tauri CLI 做的事一一对应，只是把符号链接换成拷贝）：
#   1) `pnpm build:vite` —— 刷 dist。⚠️ release 构建把 dist **编进 Rust 二进制**，
#      所以这一步不能省（debug 构建走的是 devUrl=http://localhost:1420，编不出静态前端）。
#   2) `cargo build --release --lib --target <triple>` —— 先把 NDK 的 clang 接进环境，
#      否则卡在 ring 的 C 编译。
#   3) 把 target 里的 .so **拷**进 jniLibs/<abi>/
#   4) `gradlew :app:assemble<Flavor>Release -x rustBuild<Flavor>Release`
#   5) apksigner 用调试密钥签名（Android 可直接安装）
#
# ⚠️ 与 `打包.ps1` 的分工：`打包.ps1` 是**正式出包**（桌面 exe + 安卓 APK，走提权那套、含 UAC）；
#    本脚本是**安卓开发期出包**，不需要提权、可只出一个 ABI（默认 x86_64 = 本机模拟器）。
#
# 用法：
#   powershell -File 安卓构建.ps1                    # x86_64（本机 tauri_avd 模拟器用）
#   powershell -File 安卓构建.ps1 -Abi arm64         # 真机 arm64 最小包
#   powershell -File 安卓构建.ps1 -Abi universal     # 全 ABI（模拟器/真机通用，体积大）
#   powershell -File 安卓构建.ps1 -SkipFrontend      # 前端没改时省掉 vite 构建
param(
  [ValidateSet('x86_64', 'arm64', 'arm', 'x86', 'universal')]
  [string]$Abi = 'x86_64',
  [switch]$SkipFrontend,
  [switch]$NoSign,
  [string]$OutDir = "$env:USERPROFILE\Desktop"
)

$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { "$env:LOCALAPPDATA\Android\Sdk" }
$ndkRoot = Join-Path $sdk 'ndk'
$ndk = (Get-ChildItem $ndkRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1).FullName
if (-not $ndk) { throw "找不到 NDK：$ndkRoot" }
$tc = Join-Path $ndk 'toolchains\llvm\prebuilt\windows-x86_64\bin'

# ABI → cargo target triple / Gradle flavor / jniLibs 目录名 / NDK clang 前缀
$map = @{
  'x86_64' = @{ Triple = 'x86_64-linux-android';      Flavor = 'X86_64';    Jni = 'x86_64';      Clang = 'x86_64-linux-android24-clang.cmd' }
  'arm64'  = @{ Triple = 'aarch64-linux-android';     Flavor = 'Arm64';     Jni = 'arm64-v8a';   Clang = 'aarch64-linux-android24-clang.cmd' }
  'arm'    = @{ Triple = 'armv7-linux-androideabi';   Flavor = 'Arm';       Jni = 'armeabi-v7a'; Clang = 'armv7a-linux-androideabi24-clang.cmd' }
  'x86'    = @{ Triple = 'i686-linux-android';        Flavor = 'X86';       Jni = 'x86';         Clang = 'i686-linux-android24-clang.cmd' }
}

function Build-One([string]$key) {
  $m = $map[$key]
  $triple = $m.Triple
  $envVarTriple = $triple -replace '-', '_'
  $linkerVar = 'CARGO_TARGET_' + ($triple -replace '-', '_').ToUpper() + '_LINKER'
  $clang = Join-Path $tc $m.Clang
  if (-not (Test-Path $clang)) { throw "找不到 NDK clang：$clang" }
  Set-Item -Path "env:CC_$envVarTriple"  -Value $clang
  Set-Item -Path "env:CXX_$envVarTriple" -Value (Join-Path $tc ($m.Clang -replace 'clang\.cmd$', 'clang++.cmd'))
  Set-Item -Path "env:AR_$envVarTriple"  -Value (Join-Path $tc 'llvm-ar.exe')
  Set-Item -Path "env:$linkerVar"        -Value $clang

  Write-Host "[cargo] $triple (release + custom-protocol)" -ForegroundColor Cyan
  Push-Location (Join-Path $root 'src-tauri')
  # ⚠️ `--features tauri/custom-protocol` **不能省**：Tauri 的 dev/prod 判定就靠它 ——
  #    `tauri/build.rs`：`dev = !has_feature("custom-protocol")`，而 `tauri-codegen` 在 dev 下
  #    会把前端资源换成 `build.devUrl`。缺这个 feature 时 release 包**照样编得出来、也能装**，
  #    但打开只有一行 `Failed to request http://localhost:1420/`（本轮实际踩到）。
  #    CLI 路径（`tauri build` / `tauri android build`）会自动带上它，手写 cargo 命令不会。
  cargo build --release --lib --target $triple --features tauri/custom-protocol 2>&1 | Select-Object -Last 8 | ForEach-Object { "  $_" }
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) { throw "cargo 构建失败（$triple），退出码 $code" }

  $so = Join-Path $root "src-tauri\target\$triple\release\libapi_quota_monitor_tauri_lib.so"
  if (-not (Test-Path $so)) { throw "找不到产物：$so" }
  $dst = Join-Path $root "src-tauri\gen\android\app\src\main\jniLibs\$($m.Jni)"
  New-Item -ItemType Directory -Force -Path $dst | Out-Null
  # ⚠️ 先删旧的（可能是上一次提权构建留下的**符号链接**，Copy-Item 会顺着它写进 target 目录）
  Remove-Item (Join-Path $dst 'libapi_quota_monitor_tauri_lib.so') -Force -ErrorAction SilentlyContinue
  Copy-Item $so $dst -Force
  $info = Get-Item (Join-Path $dst 'libapi_quota_monitor_tauri_lib.so')
  Write-Host ("[copy] {0} -> jniLibs/{1} ({2:N1} MB, 真实文件={3})" -f $triple, $m.Jni, ($info.Length / 1MB), ($info.LinkType -ne 'SymbolicLink')) -ForegroundColor Cyan
  return $m
}

Write-Host "NDK: $ndk" -ForegroundColor DarkGray

if (-not $SkipFrontend) {
  Write-Host "[1/4] vite 构建前端（dist 会被编进 Rust 二进制）" -ForegroundColor Cyan
  Push-Location $root
  pnpm build:vite 2>&1 | Select-Object -Last 3 | ForEach-Object { "  $_" }
  if ($LASTEXITCODE -ne 0) { Pop-Location; throw "vite 构建失败" }
  Pop-Location
} else {
  Write-Host "[1/4] 跳过前端构建（-SkipFrontend）" -ForegroundColor DarkGray
}

Write-Host "[2/4] cargo 构建安卓目标" -ForegroundColor Cyan
$env:PATH = "$tc;$env:PATH"
$excludes = @()
if ($Abi -eq 'universal') {
  foreach ($k in @('x86_64', 'arm64', 'arm', 'x86')) {
    Build-One $k | Out-Null
    $excludes += "-x"; $excludes += "rustBuild$($map[$k].Flavor)Release"
  }
  $flavor = 'Universal'
} else {
  Build-One $Abi | Out-Null
  $excludes = @('-x', "rustBuild$($map[$Abi].Flavor)Release")
  $flavor = $map[$Abi].Flavor
}

Write-Host "[3/4] Gradle 打包（跳过 rust 任务，jniLibs 已用真实拷贝就位）" -ForegroundColor Cyan
Push-Location (Join-Path $root 'src-tauri\gen\android')
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:NDK_HOME = $ndk
if (-not $env:JAVA_HOME) {
  $jdk = Get-ChildItem "$env:LOCALAPPDATA\Programs\Eclipse Adoptium" -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
  if ($jdk) { $env:JAVA_HOME = $jdk.FullName }
}
& .\gradlew.bat ":app:assemble$($flavor)Release" @excludes --console=plain 2>&1 |
  Select-Object -Last 12 | ForEach-Object { "  $_" }
$code = $LASTEXITCODE
# ⚠️ 首次调用偶发失败（本项目已知环境问题：Defender 实时扫描会锁住 build 目录下的文件，
#    §7.5 记过同类现象）→ 自动重试一次，避免把环境噪声当成代码错误
if ($code -ne 0) {
  Write-Host "  [重试] Gradle 首次失败（退出码 $code），重跑一次" -ForegroundColor Yellow
  & .\gradlew.bat ":app:assemble$($flavor)Release" @excludes --console=plain 2>&1 |
    Select-Object -Last 12 | ForEach-Object { "  $_" }
  $code = $LASTEXITCODE
}
Pop-Location
if ($code -ne 0) { throw "Gradle 打包失败，退出码 $code" }

$unsigned = Join-Path $root "src-tauri\gen\android\app\build\outputs\apk\$($Abi.ToLower())\release\app-$($Abi.ToLower())-release-unsigned.apk"
if ($Abi -eq 'universal') {
  $unsigned = Join-Path $root 'src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release-unsigned.apk'
}
if (-not (Test-Path $unsigned)) {
  # flavor 目录名与 -Abi 取值不完全一致（arm64 → arm64），兜底全局找最新
  $unsigned = (Get-ChildItem (Join-Path $root 'src-tauri\gen\android\app\build\outputs\apk') -Recurse -Filter '*release-unsigned.apk' |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
}
if (-not $unsigned) { throw '找不到 release 未签名 APK' }
Write-Host "[apk] $unsigned ($([math]::Round((Get-Item $unsigned).Length / 1MB, 1)) MB)" -ForegroundColor Green

if ($NoSign) { exit 0 }

Write-Host "[4/4] apksigner 签名（调试密钥，Android 可直接安装）" -ForegroundColor Cyan
$bt = (Get-ChildItem (Join-Path $sdk 'build-tools') -Directory | Sort-Object Name -Descending | Select-Object -First 1).FullName
$apksigner = Join-Path $bt 'apksigner.bat'
$ks = "$env:USERPROFILE\.android\debug.keystore"
if (-not (Test-Path $apksigner)) { throw "找不到 apksigner：$apksigner" }
if (-not (Test-Path $ks)) { throw "找不到调试密钥库：$ks（先跑一次任意 android 构建会自动生成）" }
$stamp = Get-Date -Format 'yyMMdd.HHmm'
$out = Join-Path $OutDir "API余额通-安卓_$stamp.apk"
& $apksigner sign --ks $ks --ks-pass pass:android --key-pass pass:android --out $out $unsigned 2>&1 |
  Select-Object -Last 4 | ForEach-Object { "  $_" }
if ($LASTEXITCODE -ne 0) { throw 'apksigner 签名失败' }
& $apksigner verify $out 2>&1 | Select-Object -First 3 | ForEach-Object { "  verify: $_" }
Write-Host "产物：$out（$([math]::Round((Get-Item $out).Length / 1MB, 1)) MB）" -ForegroundColor Green
