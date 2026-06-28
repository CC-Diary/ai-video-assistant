#!/bin/bash
echo "===================================="
echo "  AI视频加特效 - 打包Mac版本"
echo "===================================="
echo ""

echo "[1/2] 安装依赖..."
npm install

echo "[2/2] 打包Mac版本..."
npx electron-builder --mac

echo ""
echo "打包完成! 安装包在 dist/ 目录"
echo ""
