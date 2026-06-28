@echo off
echo ====================================
echo   视频特效助手 - 一键打包
echo ====================================
echo.

echo [1/2] 安装依赖...
call npm install

echo [2/2] 打包Windows版本...
call npx electron-builder --win

echo.
echo 打包完成! 安装包在 dist/ 目录
echo.
pause
