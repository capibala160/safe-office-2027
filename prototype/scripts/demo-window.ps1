# 录屏用启动器：开一个可见窗口跑「多幕演示连跑」，结束后停住等回车。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/demo-window.ps1 -Port COM11
param(
  [string]$Port = 'COM11',
  [string]$Device = 'ws63-A'
)
$Host.UI.RawUI.WindowTitle = 'SFO-DEMO'
Set-Location (Split-Path -Parent $PSScriptRoot)
Write-Host '安全智慧办公 · 多幕演示连跑（录屏窗口）' -ForegroundColor Cyan
Write-Host '提示：幕4 短按 KEY2 批准；幕5 长按 KEY2 ≥600ms 取消；幕6 不要按键。' -ForegroundColor Yellow
Write-Host '窗口就绪，6 秒后开始演示…' -ForegroundColor Yellow
Write-Host ''
Start-Sleep -Seconds 6
node scripts/demo-runthrough.cjs --port $Port --device $Device --out-dir out/demo-runthrough/recording
Write-Host ''
Write-Host '演示结束，按回车关闭窗口' -ForegroundColor Cyan
[void][System.Console]::ReadLine()
