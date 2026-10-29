@echo off
chcp 65001 >nul
title 安全智慧办公 - 控制台
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 找不到 node，请确认已安装 Node.js
  pause
  exit /b 1
)

echo 正在启动控制台...
echo 浏览器打开 http://127.0.0.1:7812
echo 使用期间请不要关闭本窗口。
echo.

node server.cjs

echo.
echo [服务已退出] 若提示端口被占用，请先关掉另一个控制台窗口。
pause
