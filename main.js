const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');

let mainWindow;

function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
  } catch { return {}; }
}

function writeConfig(data) {
  const config = { ...readConfig(), ...data };
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf-8');
}

function getDebugLogPath() {
  return path.join(app.getPath('temp'), 'vfx-debug.log');
}

function debugLog(msg) {
  try { fs.appendFileSync(getDebugLogPath(), `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 800,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
    title: '视频特效助手', resizable: true
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// 查找ffmpeg - 按优先级搜索
function findFfmpeg() {
  const candidates = [
    // 1. 打包后内置
    app.isPackaged ? path.join(process.resourcesPath, 'bin', 'ffmpeg') : null,
    // 2. 开发环境内置
    path.join(__dirname, 'bin', 'ffmpeg'),
    // 3. 系统路径
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'ffmpeg'; // 最后fallback到系统PATH
}

function runFfmpeg(args, timeout) {
  return new Promise(resolve => {
    const ffmpegPath = findFfmpeg();
    execFile(ffmpegPath, args, { timeout: timeout || 30000 }, (err, stdout, stderr) => {
      resolve({ stdout: stdout || '', stderr: stderr || '', err });
    });
  });
}

// 获取视频信息
ipcMain.handle('get-video-info', async (e, fp) => {
  const { stderr, err } = await runFfmpeg(['-i', fp], 10000);
  const out = stderr;
  const durMatch = out.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  const vidMatch = out.match(/Video:\s*\w+.*?,\s*(\d+)x(\d+)/);
  const codecMatch = out.match(/Video:\s*(\w+)/);
  if (!durMatch) return { error: err ? err.message : '无法识别视频格式' };
  return {
    width: vidMatch ? parseInt(vidMatch[1]) : 0,
    height: vidMatch ? parseInt(vidMatch[2]) : 0,
    duration: parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseFloat(durMatch[3]),
    codec: codecMatch ? codecMatch[1] : 'unknown',
    size: 0
  };
});

// 提取音频
ipcMain.handle('extract-audio', async (e, video, out) => {
  debugLog(`extract-audio: ${video} -> ${out}`);
  const { err } = await runFfmpeg(['-y', '-i', video, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', out]);
  const success = !err;
  debugLog(`extract-audio result: ${success}`);
  return err ? { error: err.message } : { success: true };
});

// 转码H.264
ipcMain.handle('transcode-to-h264', async (e, input, out) => {
  const { err } = await runFfmpeg(['-y', '-i', input, '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'aac', '-r', '30', '-g', '30', '-keyint_min', '30', '-movflags', '+faststart', out]);
  return err ? { error: err.message } : { success: true };
});

// 写文件
ipcMain.handle('write-html', async (e, fp, content) => {
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, 'utf-8');
    debugLog(`write-html: ${fp} (${content.length} bytes)`);
    return { success: true };
  } catch (err) {
    debugLog(`write-html ERROR: ${err.message}`);
    return { error: err.message };
  }
});

// Whisper转录
ipcMain.handle('whisper-transcribe', async (e, audioPath) => {
  debugLog(`whisper: ${audioPath} exists=${fs.existsSync(audioPath)}`);
  if (!fs.existsSync(audioPath)) {
    return { error: '音频文件不存在: ' + audioPath };
  }
  return new Promise(resolve => {
    // 把音频路径和ffmpeg路径都写死进Python脚本
    const escapedPath = audioPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const ffmpegBin = app.isPackaged
      ? path.join(process.resourcesPath, 'bin')
      : path.join(__dirname, 'bin');
    const script = `
import sys, os
sys.path.insert(0, '/opt/homebrew/lib/python3.14/site-packages')
sys.path.insert(0, '/opt/homebrew/opt/python@3.14/Frameworks/Python.framework/Versions/3.14/lib/python3.14/site-packages')
os.environ['PATH'] = '${ffmpegBin.replace(/\\/g, '/').replace(/'/g, "")}' + os.pathsep + os.environ.get('PATH', '')
import whisper, json, opencc
converter = opencc.OpenCC('t2s')
model = whisper.load_model('base')
result = model.transcribe('${escapedPath}', language='zh')
segments = [{'start': s['start'], 'end': s['end'], 'text': converter.convert(s['text'])} for s in result['segments']]
print(json.dumps(segments, ensure_ascii=False))
`;
    const scriptPath = path.join(app.getPath('temp'), 'whisper_run.py');
    fs.writeFileSync(scriptPath, script, 'utf-8');
    // 打包后用完整路径找python3
    const pythonCandidates = [
      '/opt/homebrew/bin/python3',
      '/usr/local/bin/python3',
      '/usr/bin/python3',
      'python3'
    ];
    let python = 'python3';
    for (const p of pythonCandidates) {
      if (fs.existsSync(p)) { python = p; break; }
    }
    debugLog(`whisper exec: ${python} ${scriptPath}`);
    execFile(python, [scriptPath], { timeout: 120000 }, (err, stdout, stderr) => {
      debugLog(`whisper err=${err?.message}`);
      debugLog(`whisper stderr=${stderr}`);
      debugLog(`whisper stdout=${stdout?.substring(0,200)}`);
      if (err) return resolve({ error: (stderr || err.message) });
      try {
        const segments = JSON.parse(stdout.trim());
        resolve({ success: true, segments });
      } catch (e) { resolve({ error: '解析转录结果失败: ' + e.message + '\nstdout: ' + stdout?.substring(0,200) }); }
    });
  });
});

// 选择保存位置
ipcMain.handle('select-save-path', async (e, defaultName) => {
  const r = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: [{ name: 'MP4', extensions: ['mp4'] }]
  });
  return r.canceled ? null : r.filePath;
});

// 清理临时文件
ipcMain.handle('cleanup-project', async (e, projectDir) => {
  try {
    const files = ['audio.wav', 'preview.mp4'];
    files.forEach(f => {
      const fp = path.join(projectDir, f);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    });
    // 删除snapshots目录
    const snapDir = path.join(projectDir, 'snapshots');
    if (fs.existsSync(snapDir)) fs.rmSync(snapDir, { recursive: true });
    return { success: true };
  } catch (err) { return { error: err.message }; }
});

function findNode() {
  const candidates = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];
  for (const p of candidates) { if (fs.existsSync(p)) return p; }
  return 'node';
}

function findNpx() {
  const candidates = ['/opt/homebrew/bin/npx', '/usr/local/bin/npx', '/usr/bin/npx'];
  for (const p of candidates) { if (fs.existsSync(p)) return p; }
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function getSpawnOpts(cwd) {
  const nodeModulesPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
    : path.join(__dirname, 'node_modules');
  const hfCli = path.join(nodeModulesPath, 'hyperframes', 'dist', 'cli.js');
  return { cwd, nodeModulesPath, hfCli };
}

// HyperFrames渲染（支持preview模式+画质+帧率）
ipcMain.handle('hyperframes-render', async (e, dir, out, preview, quality, fps) => {
  debugLog(`render: out=${out} preview=${preview} quality=${quality} fps=${fps}`);
  return new Promise(resolve => {
    const { nodeModulesPath, hfCli } = getSpawnOpts(dir);
    const nodeCmd = findNode();
    const q = preview ? 'draft' : (quality || 'standard');
    const f = preview ? 15 : (fps || 30);
    const args = [hfCli, 'render', '-o', out, '--quality', q, '-f', String(f)];
    debugLog(`render exec: ${nodeCmd} ${args.join(' ')}`);
    const child = spawn(nodeCmd, args, {
      cwd: dir, shell: true,
      env: { ...process.env, NODE_PATH: nodeModulesPath }
    });
    let log = '';
    child.stdout.on('data', d => { log += d.toString(); });
    child.stderr.on('data', d => { log += d.toString(); });
    child.on('close', code => {
      debugLog(`render result: code=${code}`);
      resolve(code === 0 ? { success: true } : { error: log });
    });
  });
});

// HyperFrames快照
ipcMain.handle('hyperframes-snapshot', async (e, dir, time) => {
  debugLog(`snapshot: dir=${dir} time=${time}`);
  return new Promise(resolve => {
    const { nodeModulesPath, hfCli } = getSpawnOpts(dir);
    const nodeCmd = findNode();
    const args = [hfCli, 'snapshot', '--at', String(time), '--timeout', '10000'];
    debugLog(`snapshot exec: ${nodeCmd} ${args.join(' ')}`);
    const child = spawn(nodeCmd, args, {
      cwd: dir, shell: true,
      env: { ...process.env, NODE_PATH: nodeModulesPath }
    });
    let log = '';
    child.stdout.on('data', d => { log += d.toString(); });
    child.stderr.on('data', d => { log += d.toString(); });
    child.on('close', code => {
      debugLog(`snapshot result: code=${code}`);
      if (code === 0) {
        const snapDir = path.join(dir, 'snapshots');
        const files = fs.existsSync(snapDir) ? fs.readdirSync(snapDir).filter(f => f.endsWith('.png')) : [];
        resolve({ success: true, image: files.length > 0 ? path.join(snapDir, files[0]) : null });
      } else { resolve({ error: log }); }
    });
  });
});

ipcMain.handle('read-file-base64', async (e, fp) => {
  try { return { data: fs.readFileSync(fp).toString('base64') }; }
  catch (err) { return { error: err.message }; }
});

// 复制字体
ipcMain.handle('copy-fonts', async (e, projectDir) => {
  const fontsDir = path.join(projectDir, 'fonts');
  fs.mkdirSync(fontsDir, { recursive: true });
  const srcFonts = app.isPackaged ? path.join(process.resourcesPath, 'fonts') : path.join(__dirname, 'fonts');
  try {
    for (const f of ['NotoSansSC-Regular.ttf', 'NotoSansSC-Bold.ttf', 'NotoSansSC-Black.ttf']) {
      const src = path.join(srcFonts, f);
      const dst = path.join(fontsDir, f);
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
    }
    return { success: true };
  } catch (err) { return { error: err.message }; }
});

// 检查Ollama
ipcMain.handle('check-ollama', async () => {
  return new Promise(resolve => {
    const req = require('http').get('http://127.0.0.1:11434/api/tags', res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { const models = JSON.parse(data).models || []; resolve({ available: true, models: models.map(m => m.name) }); }
        catch { resolve({ available: false, models: [] }); }
      });
    });
    req.on('error', () => resolve({ available: false, models: [] }));
    req.setTimeout(3000, () => { req.destroy(); resolve({ available: false, models: [] }); });
  });
});

// 调用Ollama
ipcMain.handle('call-ollama', async (e, model, prompt) => {
  debugLog(`ollama: model=${model} prompt_len=${prompt.length}`);
  return new Promise(resolve => {
    const postData = JSON.stringify({ model, prompt, stream: false });
    const req = require('http').request({
      hostname: '127.0.0.1', port: 11434, path: '/api/generate',
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          debugLog(`ollama response: ${parsed.response?.substring(0,100)}`);
          resolve({ success: true, response: parsed.response });
        }
        catch { resolve({ error: '解析失败' }); }
      });
    });
    req.on('error', err => resolve({ error: err.message }));
    req.setTimeout(300000, () => { req.destroy(); resolve({ error: '超时（5分钟），模型可能还在加载' }); });
    req.write(postData);
    req.end();
  });
});

// 检查ffmpeg
ipcMain.handle('check-ffmpeg', async () => {
  const { err } = await runFfmpeg(['-version'], 5000);
  return !err;
});

// 保存/读取配置（API Key等）
ipcMain.handle('save-config', async (e, data) => {
  try { writeConfig(data); return { success: true }; }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle('load-config', async () => {
  return readConfig();
});

// 选择文件
ipcMain.handle('select-video', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm'] }]
  });
  return r.canceled ? null : r.filePaths[0];
});
