# AI视频助手

AI自动识别关键词生成特效的桌面视频应用。

## 功能

- 🎙️ **双模式**：口播加特效 / 配字幕特效
- 🤖 **多AI模型**：DeepSeek（推荐）、OpenAI、Anthropic、通义千问、Ollama本地
- 🎬 **6种特效**：标签、大数字、对比卡片、柱状图、金句、CTA
- 🗣️ **Whisper转录**：本地语音识别 + 繁简转换
- 🎨 **GSAP动画**：流畅的入场/退场动画效果
- 📦 **跨平台**：Windows + macOS

## 技术栈

- Electron 33
- Node.js + 原生 HTML/CSS/JS
- HyperFrames (HTML-to-Video)
- GSAP 动画引擎
- OpenAI Whisper (Python)
- ffmpeg 视频处理

## 快速开始

### macOS

```bash
# 下载 Release 中的 DMG 安装包
# 或者从源码运行
npm install
npm start
```

### Windows

```bash
# 双击 setup.bat 安装依赖
# 双击 start.bat 启动
```

## 使用流程

1. 选择模式（口播加特效 / 配字幕特效）
2. 导入视频
3. 粘贴口播文案 → AI分析生成特效
4. 预览确认
5. 导出视频

## License

MIT
