@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 安全智慧办公 · 控制台
echo 正在启动……浏览器打开 http://127.0.0.1:7812
echo 关闭本窗口即停止服务。
echo.
node server.cjs
echo.
echo 服务已停止。按任意键关闭。
pause >nul
