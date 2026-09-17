# 一键量测：先开屏幕捕获，再触发探针轮次，最后等落盘。
# 用法：pwsh -File probe/run-test.ps1 -Run 1 -DeltaY 100 [-DurationMs 4000] [-X 150 -Y 380 -W 1000 -H 760]
param(
  [Parameter(Mandatory = $true)][int]$Run,
  [int]$Notches = 6,
  [int]$DeltaY = 100,
  [int]$GapMs = 70,
  [double]$AnchorFx = 0.4,
  [double]$AnchorFy = 0.45,
  [bool]$Paint = $true,
  [int]$DurationMs = 4000,
  [int]$LeadMs = 900,
  [int]$PosX = 600,
  [int]$PosY = 300,
  [int]$X = 580,
  [int]$Y = 270,
  [int]$W = 720,
  [int]$H = 680,
  [string]$Tag = "manual"
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$traceDir = Join-Path $root "probe\traces"
if (-not (Test-Path $traceDir)) { New-Item -ItemType Directory -Path $traceDir -Force | Out-Null }

$capOut = Join-Path $traceDir "cap-$Tag-$Run.csv"
$cap = Start-Job -ScriptBlock {
  param($script, $x, $y, $w, $h, $dur, $out)
  & $script -X $x -Y $y -W $w -H $h -DurationMs $dur -Out $out
} -ArgumentList (Join-Path $PSScriptRoot "capture.ps1"), $X, $Y, $W, $H, $DurationMs, $capOut

Start-Sleep -Milliseconds $LeadMs

$plan = [ordered]@{
  run      = $Run
  notches  = $Notches
  deltaY   = $DeltaY
  gapMs    = $GapMs
  anchorFx = $AnchorFx
  anchorFy = $AnchorFy
  paint    = $Paint
  settleMs = 1600
  posX     = $PosX
  posY     = $PosY
}
$json = ($plan | ConvertTo-Json -Compress)
[IO.File]::WriteAllText((Join-Path $root "probe\trigger.json"), $json, (New-Object Text.UTF8Encoding($false)))
Write-Output "已触发 run=$Run（plan=$json）"

Wait-Job $cap | Out-Null
$out = Receive-Job $cap
Remove-Job $cap
$out | ForEach-Object { Write-Output $_ }
Write-Output "capture -> $capOut"
