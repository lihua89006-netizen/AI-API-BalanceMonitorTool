@echo off
chcp 65001 >nul
title MiniMax 余额查询
cd /d "%~dp0"

echo 正在启动 MiniMax 余额查询服务...
echo 启动后请用浏览器打开: http://127.0.0.1:18080
echo 关闭本窗口即停止服务
echo.

set "NODE=C:\Users\Administrator\.astrbot_launcher\components\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"

"%NODE%" server.js
pause
