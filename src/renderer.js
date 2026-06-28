const { ipcRenderer, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let state = {
  mode: null, // 'talk' or 'subtitle'
  videoPath: null, projectDir: null,
  keywords: [], title: '', subtitle: '',
  htmlCode: '', outputPath: null, confirmedPreview: false,
  segments: []
};
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

// ===== 模式选择 =====
window.selectMode = function(mode) {
  state.mode = mode;
  window._debugMode = mode;
  $('#modeA').style.borderColor = mode === 'talk' ? '#F59E0B' : '#333';
  $('#modeB').style.borderColor = mode === 'subtitle' ? '#F59E0B' : '#333';
  const modeText = mode === 'talk' ? '🎙️ 口播加特效' : '📝 配字幕特效';
  $('#modeIndicator').textContent = '当前模式: ' + modeText;
  setTimeout(() => goStep(1), 300);
};

// ===== 导航 =====
$$('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const step = parseInt(btn.dataset.step);
    if (step >= 1 && !state.mode) return alert('请先选择模式');
    if (step >= 2 && !state.videoPath) return alert('请先导入视频');
    if (step >= 3 && !state.htmlCode) return alert('请先AI分析');
    if (step >= 4 && !state.confirmedPreview) return alert('请先预览确认');
    $$('.step').forEach(s => s.classList.remove('active'));
    $$('.nav-btn').forEach(b => b.classList.remove('active'));
    $(`#step${step}`).classList.add('active');
    btn.classList.add('active');
  });
});

function goStep(n) {
  $$('.step').forEach(s => s.classList.remove('active'));
  $$('.nav-btn').forEach(b => b.classList.remove('active'));
  $(`#step${n}`).classList.add('active');
  $(`[data-step="${n}"]`).classList.add('active');
}

// ==================== Step 1: 导入 ====================
$('#btnSelectFile').addEventListener('click', async () => {
  const fp = await ipcRenderer.invoke('select-video');
  if (fp) loadVideo(fp);
});

const dropzone = $('#dropzone');
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.style.borderColor = '#F59E0B'; });
dropzone.addEventListener('dragleave', () => { dropzone.style.borderColor = ''; });
dropzone.addEventListener('drop', async (e) => {
  e.preventDefault(); dropzone.style.borderColor = '';
  if (e.dataTransfer.files.length && e.dataTransfer.files[0].path) loadVideo(e.dataTransfer.files[0].path);
});
dropzone.addEventListener('click', async (e) => {
  if (e.target.id === 'btnSelectFile' || e.target.closest('#btnSelectFile')) return;
  const fp = await ipcRenderer.invoke('select-video');
  if (fp) loadVideo(fp);
});

async function loadVideo(videoPath) {
  state.videoPath = videoPath;
  state.confirmedPreview = false;
  const info = await ipcRenderer.invoke('get-video-info', videoPath);
  if (info.error) return alert('无法读取: ' + info.error);
  $('#infoName').textContent = path.basename(videoPath);
  $('#infoRes').textContent = info.width + 'x' + info.height;
  $('#infoDuration').textContent = info.duration.toFixed(1) + 's';
  $('#infoCodec').textContent = info.codec;
  $('#videoInfo').hidden = false;

  state.projectDir = path.join(path.dirname(videoPath), 'hf-' + Date.now());
  fs.mkdirSync(state.projectDir, { recursive: true });
  $('#statusText').textContent = '⏳ 转码中...';
  const res = await ipcRenderer.invoke('transcode-to-h264', videoPath, path.join(state.projectDir, 'source.mp4'));
  if (res.error) { $('#statusText').textContent = '❌ ' + res.error; return; }
  await ipcRenderer.invoke('copy-fonts', state.projectDir);
  $('#statusText').textContent = '✅ 就绪';
  $('#btnGoStep2').disabled = false;
}

// ==================== Step 2: AI分析 ====================

// 确认文案后提取关键词+特效方案
$('#btnExtractKeywords').addEventListener('click', async () => {
  const provider = $('#apiProvider').value;
  const apiKey = $('#apiKey').value;
  const transcriptText = $('#manualTranscript').value.trim();
  if (!transcriptText) return alert('请先输入或识别文案');

  $('#btnExtractKeywords').disabled = true;
  $('#btnExtractKeywords').textContent = '分析中...';
  $('#analysisStatus').textContent = '⏳ 分析文案+设计特效...';

  try {
    // 云端STT转录
    let segments = [];
    const sttKey = (await ipcRenderer.invoke('load-config')).sttApiKey || '';
    console.log('[STT] sttKey:', sttKey ? sttKey.substring(0,8) + '...' : 'EMPTY');
    if (!sttKey) { alert('请先在左侧设置中填写提取文案的API Key'); return; }
    const audioPath = path.join(state.projectDir, 'audio.wav');
    if (!fs.existsSync(audioPath)) {
      await ipcRenderer.invoke('extract-audio', state.videoPath, audioPath);
    }
    console.log('[STT] calling stt-transcribe with:', audioPath);
    const transRes = await ipcRenderer.invoke('stt-transcribe', audioPath, sttKey);
    console.log('[STT] result:', JSON.stringify(transRes).substring(0, 200));
    if (transRes.success && transRes.text) {
      segments = [{ text: transRes.text, start: 0, end: 0 }];
    }

    // 用模型分析文案内容（不指定时间点）
    const prompt = `你是视频特效设计师，风格参考柱子哥。

文案：${transcriptText}

【特效规则】
1. 标签：左上角蓝色竖线 + 英文大写 + 中文
2. 大数字：金色180px，带发光阴影
3. 三层标题：英文小蓝24px + 主标题大白108px + 副标题灰28px
4. 对比卡片：BEFORE(红边框) vs NOW(绿边框)，必须用文案里的真实数据
5. 金句：左边框金色 + 深色底板 + 大字
6. 柱子图：效率/增长/百分比用chart，带GSAP width动画
7. 进度条：对比变化用progress，从旧值动画到新值
8. 颜色：蓝=概念、金=标准、红=警告、绿=正面
9. 所有特效放左侧，右侧留人脸
10. 特效不堆叠，时间错开
11. 从文案提取具体数字，禁止占位符
12. 数字用柱子图或进度条，不要用大字

【时间点不用你指定】系统会自动根据转录时间点对齐。

输出JSON（不要markdown代码块）：
{"title":"6字标题","subtitle":"10字副标题","effects":[
  {"type":"tag","keyword":"关键词","en":"英文","zh":"中文"},
  {"type":"bignum","keyword":"关键词","num":"具体数字"},
  {"type":"compare","keyword":"关键词","before":{"val":"旧数据"},"now":{"val":"新数据"}},
  {"type":"chart","keyword":"关键词","label":"标签","pct":85},
  {"type":"progress","keyword":"关键词","label":"标签","from":20,"to":85},
  {"type":"quote","keyword":"关键词","text":"文案原话"},
  {"type":"cta","keyword":"关键词","text":"行动号召"}
]}

每个effects必须带keyword字段（文案中的关键词），系统会自动匹配时间点。
直接输出JSON。`;

    const aiRes = await callAI(provider, apiKey, prompt);
    const parsed = parseJSON(aiRes);

    state.title = parsed.title || 'AI';
    state.subtitle = parsed.subtitle || '';
    state.keywords = [state.title, state.subtitle];
    // 匹配Whisper时间点
    const rawEffects = parsed.effects || [];
    state.effectsPlan = rawEffects.map(e => {
      const kw = e.keyword || '';
      let t = 0;
      if (kw && segments.length > 0) {
        const seg = segments.find(s => s.text.includes(kw));
        if (seg) t = seg.start;
      }
      return { ...e, time: t };
    });
    // 如果没匹配到时间点，均匀分配
    if (!state.effectsPlan.some(e => e.time > 0)) {
      const vi2 = await ipcRenderer.invoke('get-video-info', state.videoPath);
      const gap = vi2.duration / (state.effectsPlan.length + 1);
      state.effectsPlan.forEach((e, i) => { e.time = +(gap * (i + 1)).toFixed(1); });
    }
    state.effectsPlan.sort((a, b) => a.time - b.time);

    const vi = await ipcRenderer.invoke('get-video-info', state.videoPath);
    state.htmlCode = generateSmartHTML(state.effectsPlan, vi.duration, vi.width, vi.height);

    $('#keywordsInput').value = [state.title, state.subtitle].join(',');
    $('#designPlan').textContent = `特效方案 (${state.effectsPlan.length}个):\n` +
      state.effectsPlan.map(e => `${e.time}s: ${e.type} - ${e.en||e.zh||e.text||e.num||''}`).join('\n');
    $('#htmlCode').value = state.htmlCode;
    $('#analysisStatus').textContent = '✅ 特效方案已生成！可修改关键词后点「重新生成」';
    $('#btnConfirmDesign').disabled = false;
    $('#btnRegenerate').disabled = false;
  } catch (err) {
    $('#analysisStatus').textContent = '❌ ' + err.message;
  } finally {
    $('#btnExtractKeywords').disabled = false;
    $('#btnExtractKeywords').textContent = '确认文案，提取关键词 →';
  }
});

$('#btnAnalyze').addEventListener('click', async () => {
  const provider = $('#apiProvider').value;
  const apiKey = $('#apiKey').value;
  if (!apiKey) return alert('请填API Key');

  console.log('[DEBUG] mode:', state.mode, 'window._debugMode:', window._debugMode);
  if (state.mode !== 'subtitle' && window._debugMode === 'subtitle') {
    state.mode = 'subtitle'; // 修复：如果window有但state没有
  }
  $('#btnAnalyze').disabled = true;
  $('#btnAnalyze').textContent = '分析中...';
  $('#analysisStatus').textContent = '⏳ 分析中...';

  try {
    const vi = await ipcRenderer.invoke('get-video-info', state.videoPath);
    let keywords, title, subtitle;

    // 两个模式都先转录/提取文案
    let transcriptText = '';
    const manualText = $('#manualTranscript').value.trim();

    if (manualText) {
      transcriptText = manualText;
    } else {
      const sttKey = (await ipcRenderer.invoke('load-config')).sttApiKey || '';
      if (!sttKey) throw new Error('请先在左侧设置中填写提取文案的API Key');
      $('#analysisStatus').textContent = '⏳ 提取音频...';
      const audioPath = path.join(state.projectDir, 'audio.wav');
      await ipcRenderer.invoke('extract-audio', state.videoPath, audioPath);
      $('#analysisStatus').textContent = '⏳ 云端转录中...';
      const transRes = await ipcRenderer.invoke('stt-transcribe', audioPath, sttKey);
      if (transRes.error) throw new Error('转录失败: ' + transRes.error);
      transcriptText = transRes.text || '';
    }

    // 显示文案，让用户确认
    $('#manualTranscript').value = transcriptText;
    $('#analysisStatus').textContent = '✅ 文案已识别，请检查修改后点「确认文案提取关键词」';
    $('#btnExtractKeywords').disabled = false;
    $('#btnAnalyze').disabled = false;
    return; // 暂停，等用户确认文案
  } catch (err) {
    $('#analysisStatus').textContent = '❌ ' + err.message;
  } finally {
    $('#btnAnalyze').disabled = false;
    $('#btnAnalyze').textContent = '开始AI分析';
  }
});

$('#btnConfirmDesign').addEventListener('click', async () => {
  const vi = await ipcRenderer.invoke('get-video-info', state.videoPath);
  state.htmlCode = generateSmartHTML(state.effectsPlan || [], vi.duration, vi.width, vi.height);
  goStep(3);
  $('#htmlCodePreview').value = state.htmlCode;
});

// 修改关键词后重新生成特效方案
$('#btnRegenerate').addEventListener('click', async () => {
  const provider = $('#apiProvider').value;
  const apiKey = $('#apiKey').value;
  const transcriptText = $('#manualTranscript').value.trim();
  const newKeywords = $('#keywordsInput').value.trim();
  if (!transcriptText || !newKeywords) return alert('请先输入文案和关键词');

  $('#btnRegenerate').disabled = true;
  $('#btnRegenerate').textContent = '重新生成中...';
  $('#analysisStatus').textContent = '⏳ 根据新关键词重新设计特效...';

  try {
    const prompt = `你是视频特效设计师，风格参考柱子哥。

关键词：${newKeywords}
文案：${transcriptText}

【特效规则】
1. 标签：左上角蓝色竖线 + 英文大写 + 中文
2. 大数字：金色180px，带发光阴影
3. 对比卡片：BEFORE(红) vs NOW(绿)，用文案真实数据
4. 金句：左边框金色 + 深色底 + 大字
5. 颜色：蓝=概念、金=标准、红=警告、绿=正面
6. 所有特效放左侧，右侧留人脸
7. 特效不堆叠，时间错开
8. 关键词必须出现在特效内容中

输出JSON（不要markdown代码块）：
{"title":"6字标题","subtitle":"10字副标题","effects":[
  {"type":"tag","keyword":"关键词","en":"英文","zh":"中文"},
  {"type":"bignum","keyword":"关键词","num":"具体数字"},
  {"type":"compare","keyword":"关键词","before":{"val":"旧数据"},"now":{"val":"新数据"}},
  {"type":"chart","keyword":"关键词","label":"标签","pct":85},
  {"type":"progress","keyword":"关键词","label":"标签","from":20,"to":85},
  {"type":"quote","keyword":"关键词","text":"文案原话"},
  {"type":"cta","keyword":"关键词","text":"行动号召"}
]}
每个effects必须带keyword字段，系统自动匹配时间点。
直接输出JSON。`;

    const aiRes = await callAI(provider, apiKey, prompt);
    const parsed = parseJSON(aiRes);
    // 匹配Whisper时间点
    const rawEffects2 = parsed.effects || [];
    // 获取segments（如果没有就用已有的）
    let segs2 = state.segments || [];
    if (segs2.length === 0) {
      const audioPath2 = path.join(state.projectDir, 'audio.wav');
      if (fs.existsSync(audioPath2)) {
        const sttKey2 = (await ipcRenderer.invoke('load-config')).sttApiKey || '';
        if (sttKey2) {
          const tr = await ipcRenderer.invoke('stt-transcribe', audioPath2, sttKey2);
          if (tr.success && tr.text) segs2 = [{ text: tr.text, start: 0, end: 0 }];
        }
      }
    }
    state.effectsPlan = rawEffects2.map(e => {
      const kw = e.keyword || '';
      let t = 0;
      if (kw && segs2.length > 0) {
        const seg = segs2.find(s => s.text.includes(kw));
        if (seg) t = seg.start;
      }
      return { ...e, time: t };
    });
    if (!state.effectsPlan.some(e => e.time > 0)) {
      const vi2 = await ipcRenderer.invoke('get-video-info', state.videoPath);
      const gap = vi2.duration / (state.effectsPlan.length + 1);
      state.effectsPlan.forEach((e, i) => { e.time = +(gap * (i + 1)).toFixed(1); });
    }
    state.effectsPlan.sort((a, b) => a.time - b.time);

    state.title = parsed.title || state.title;
    state.subtitle = parsed.subtitle || state.subtitle;

    const vi = await ipcRenderer.invoke('get-video-info', state.videoPath);
    state.htmlCode = generateSmartHTML(state.effectsPlan, vi.duration, vi.width, vi.height);

    $('#designPlan').textContent = `特效方案 (${state.effectsPlan.length}个):\n` +
      state.effectsPlan.map(e => `${e.time}s: ${e.type} - ${e.en||e.zh||e.text||e.num||''}`).join('\n');
    $('#htmlCode').value = state.htmlCode;
    $('#analysisStatus').textContent = '✅ 已重新生成！';
  } catch (err) {
    $('#analysisStatus').textContent = '❌ ' + err.message;
  } finally {
    $('#btnRegenerate').disabled = false;
    $('#btnRegenerate').textContent = '修改关键词后重新生成';
  }
});

// ==================== Step 3: 预览（低画质快速渲染） ====================
$('#btnPreviewVideo').addEventListener('click', async () => {
  if (!state.projectDir) return;
  await ipcRenderer.invoke('write-html', path.join(state.projectDir, 'index.html'), $('#htmlCodePreview').value);

  const previewPath = path.join(state.projectDir, 'preview.mp4');
  $('#btnPreviewVideo').disabled = true;
  $('#previewStatus').textContent = '⏳ 低画质预览渲染中...';

  const res = await ipcRenderer.invoke('hyperframes-render', state.projectDir, previewPath, true);
  if (res.success) {
    // 读取视频并显示
    const data = await ipcRenderer.invoke('read-file-base64', previewPath);
    if (data.data) {
      $('#previewVideo').src = 'data:video/mp4;base64,' + data.data;
      $('#previewVideo').hidden = false;
      $('#previewPlaceholder').hidden = true;
      $('#previewStatus').textContent = '✅ 预览已生成（低画质）';
    }
  } else {
    $('#previewStatus').textContent = '❌ ' + (res.error || '').substring(0, 200);
  }
  $('#btnPreviewVideo').disabled = false;
});

$('#btnSyncCode').addEventListener('click', () => {
  state.htmlCode = $('#htmlCodePreview').value;
  $('#previewStatus').textContent = '✅ 已同步';
});

$('#btnConfirmPreview').addEventListener('click', () => {
  state.htmlCode = $('#htmlCodePreview').value;
  state.confirmedPreview = true;
  $('[data-step="3"]').classList.add('done');
  goStep(4);
});

// ==================== Step 4: 导出 ====================
$('#btnExport').addEventListener('click', async () => {
  if (!state.projectDir || !state.htmlCode) return;
  const savePath = await ipcRenderer.invoke('select-save-path', 'output_' + Date.now() + '.mp4');
  if (!savePath) return;
  await ipcRenderer.invoke('write-html', path.join(state.projectDir, 'index.html'), state.htmlCode);
  state.outputPath = savePath;
  $('#progressArea').hidden = false;
  $('#progressFill').style.width = '20%';
  $('#progressText').textContent = '⏳ 渲染中...';
  $('#btnExport').disabled = true;
  $('#exportResult').hidden = true;

  const quality = $('#exportQuality').value;
  const fps = parseInt($('#exportFps').value) || 30;
  const res = await ipcRenderer.invoke('hyperframes-render', state.projectDir, state.outputPath, false, quality, fps);
  if (res.success) {
    // 删除预览文件
    try { fs.unlinkSync(path.join(state.projectDir, 'preview.mp4')); } catch(e) {}
    // 自动清理临时文件
    await ipcRenderer.invoke('cleanup-project', state.projectDir);
    $('#progressFill').style.width = '100%';
    $('#progressText').textContent = '✅ 完成!';
    $('#exportResult').hidden = false;
  } else {
    $('#progressText').textContent = '❌ ' + (res.error || '').substring(0, 200);
  }
  $('#btnExport').disabled = false;
});

$('#btnOpenFile').addEventListener('click', () => { if (state.outputPath) shell.showItemInFolder(state.outputPath); });

// 清理临时文件
$('#btnCleanup').addEventListener('click', async () => {
  if (!state.projectDir) return;
  const res = await ipcRenderer.invoke('cleanup-project', state.projectDir);
  if (res.success) {
    alert('临时文件已清理（保留了index.html、fonts、source.mp4、output视频）');
  } else {
    alert('清理失败: ' + res.error);
  }
});

// ==================== 模板生成 ====================

// 模式A: 口播加特效（柱子哥风格：人在右，特效在左，遮罩跟随）
function generateTalkHTML(keywords, title, subtitle, duration) {
  const kw = keywords.map(k => k.word || k).slice(0, 6);
  while (kw.length < 6) kw.push('');
  // 特效分段，每段2.5-4秒，中间留间隔
  const effects = [
    { id: 'e1', start: 0.3, dur: 3.5 },   // 标签+大字
    { id: 'e2', start: 4.5, dur: 3.5 },   // 三层标题
    { id: 'e3', start: 9, dur: 4 },        // 对比卡片
    { id: 'e4', start: 14.5, dur: 4 },     // 功能网格
    { id: 'e5', start: 20, dur: 3.5 },     // 金句
    { id: 'e6', start: 25, dur: 3.5 },     // CTA
  ];
  // 如果视频短于特效总时长，压缩间隔
  const totalFx = effects[effects.length-1].start + effects[effects.length-1].dur;
  const scale = totalFx > duration ? duration / totalFx : 1;
  // 预计算缩放后的时间点
  const se = effects.map(e => ({ s: +(e.start * scale).toFixed(2), d: +(e.dur * scale).toFixed(2) }));

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
@font-face{font-family:'Noto Sans SC';src:url('fonts/NotoSansSC-Regular.ttf');font-weight:400}
@font-face{font-family:'Noto Sans SC';src:url('fonts/NotoSansSC-Bold.ttf');font-weight:700}
@font-face{font-family:'Noto Sans SC';src:url('fonts/NotoSansSC-Black.ttf');font-weight:900}
*{margin:0;padding:0;box-sizing:border-box}
body{width:1920px;height:1080px;background:#000;overflow:hidden;font-family:'Noto Sans SC',sans-serif}
.video-bg{position:absolute;top:0;left:0;width:1920px;height:1080px;object-fit:cover;z-index:1}
.overlay{position:absolute;top:0;left:0;width:960px;height:1080px;background:linear-gradient(90deg,rgba(0,0,0,0.85) 0%,rgba(0,0,0,0.6) 55%,rgba(0,0,0,0) 100%);z-index:2;opacity:0}
.fx{position:absolute;top:0;left:0;width:960px;height:1080px;z-index:10;overflow:hidden}

/* 标签：左上角竖线+英文+中文 */
.tag{position:absolute;top:80px;left:80px;display:flex;align-items:center;gap:16px;opacity:0}
.tag-vline{width:4px;height:52px;border-radius:2px}
.tag .en{font-size:22px;font-weight:700;letter-spacing:4px;text-transform:uppercase}
.tag .zh{font-size:18px;color:rgba(255,255,255,0.6);margin-top:3px}

/* 大数字 */
.bignum{position:absolute;top:160px;left:80px;font-size:180px;font-weight:900;line-height:1;opacity:0}

/* 三层标题：英文(小蓝)+主标题(大白)+副标题(小灰) */
.three-layer{position:absolute;top:160px;left:80px;opacity:0}
.three-layer .en-sm{font-size:24px;font-weight:700;letter-spacing:3px;text-transform:uppercase}
.three-layer .main{font-size:108px;font-weight:900;color:#fff;line-height:1.1;margin:8px 0}
.three-layer .sub{font-size:28px;color:rgba(255,255,255,0.5);font-weight:400}

/* 对比卡片 BEFORE/NOW */
.compare{position:absolute;top:220px;left:80px;display:flex;gap:36px;opacity:0}
.compare-card{background:rgba(255,255,255,0.06);border-radius:16px;padding:36px 44px;min-width:320px;border:1px solid rgba(255,255,255,0.08)}
.compare-card.before{border-left:4px solid #EF4444}
.compare-card.now{border-left:4px solid #22C55E}
.compare-label{font-size:18px;font-weight:700;letter-spacing:3px;text-transform:uppercase;margin-bottom:12px}
.compare-card.before .compare-label{color:#EF4444}
.compare-card.now .compare-label{color:#22C55E}
.compare-val{font-size:72px;font-weight:900;color:#fff;line-height:1}
.compare-desc{font-size:22px;color:rgba(255,255,255,0.45);margin-top:10px}

/* 功能网格 */
.grid{position:absolute;top:200px;left:80px;display:grid;grid-template-columns:1fr 1fr;gap:18px;opacity:0}
.grid-card{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:28px 24px;text-align:center}
.grid-icon{font-size:36px;margin-bottom:8px}
.grid-name{font-size:24px;font-weight:700;color:#fff}
.grid-desc{font-size:16px;color:rgba(255,255,255,0.4);margin-top:4px}

/* 金句：左边框+深色底+大字 */
.quote{position:absolute;top:300px;left:80px;padding:32px 44px;max-width:680px;border-left:5px solid #F59E0B;background:rgba(0,0,0,0.5);border-radius:0 14px 14px 0;opacity:0}
.quote .txt{font-size:42px;font-weight:900;color:#fff;line-height:1.4}

/* CTA */
.cta{position:absolute;top:50%;left:80px;transform:translateY(-50%);opacity:0;text-align:center}
.cta .big{font-size:96px;font-weight:900;color:#F59E0B}
.cta .sm{font-size:28px;color:rgba(255,255,255,0.5);margin-top:10px}
/* 柱子图/进度条 */
.chart{position:absolute;top:280px;left:80px;width:650px;opacity:0}
.chart-label{font-size:22px;color:rgba(255,255,255,0.5);margin-bottom:16px}
.chart-bar{width:100%;height:64px;background:rgba(255,255,255,0.06);border-radius:12px;overflow:hidden;position:relative}
.chart-fill{height:100%;border-radius:12px;width:0%}
.chart-num{position:absolute;right:16px;top:50%;transform:translateY(-50%);font-size:36px;font-weight:900;color:#fff}
</style></head><body>
<div data-composition-id="root" data-start="0" data-duration="${duration}" data-width="1920" data-height="1080">
<video class="video-bg clip" id="v1" src="source.mp4" data-start="0" data-duration="${duration}" autoplay muted loop></video>
<div class="overlay clip" id="ov" data-start="0" data-duration="${duration}"></div>
<div class="fx clip" data-start="0" data-duration="${duration}">

  <!-- 特效1: 标签+大数字 [0.3-3.8s] -->
  <div class="tag clip" id="e1a" data-start="${effects[0].start}" data-duration="${effects[0].dur}">
    <div class="tag-vline" style="background:#3B82F6"></div>
    <div><div class="en" style="color:#3B82F6">KEYWORD</div><div class="zh">${kw[0]}</div></div>
  </div>
  <div class="bignum clip" id="e1b" data-start="${effects[0].start+0.3}" data-duration="${effects[0].dur-0.6}" style="color:#F59E0B;text-shadow:0 0 60px rgba(245,158,11,0.3)">${kw[0]}</div>

  <!-- 特效2: 三层标题 [4.5-8s] -->
  <div class="three-layer clip" id="e2" data-start="${effects[1].start}" data-duration="${effects[1].dur}">
    <div class="en-sm" style="color:#3B82F6">${kw[1]||'AI'}</div>
    <div class="main">${title}</div>
    <div class="sub">${subtitle}</div>
  </div>

  <!-- 特效3: 对比卡片 [9-13s] -->
  <div class="compare clip" id="e3" data-start="${effects[2].start}" data-duration="${effects[2].dur}">
    <div class="compare-card before"><div class="compare-label">BEFORE</div><div class="compare-val">8h+</div><div class="compare-desc">${kw[2]||'传统方式'}</div></div>
    <div class="compare-card now"><div class="compare-label">NOW</div><div class="compare-val">1h</div><div class="compare-desc">${kw[3]||'AI方式'}</div></div>
  </div>

  <!-- 特效4: 功能网格 [14.5-18.5s] -->
  <div class="grid clip" id="e4" data-start="${effects[3].start}" data-duration="${effects[3].dur}">
    <div class="grid-card"><div class="grid-icon">🎯</div><div class="grid-name">${kw[2]}</div></div>
    <div class="grid-card"><div class="grid-icon">⚡</div><div class="grid-name">${kw[3]}</div></div>
    <div class="grid-card"><div class="grid-icon">🚀</div><div class="grid-name">${kw[4]||''}</div></div>
    <div class="grid-card"><div class="grid-icon">💡</div><div class="grid-name">${kw[5]||''}</div></div>
  </div>

  <!-- 特效5: 金句 [20-23.5s] -->
  <div class="quote clip" id="e5" data-start="${effects[4].start}" data-duration="${effects[4].dur}">
    <div class="txt">${title}<br>${subtitle}</div>
  </div>

  <!-- 特效6: CTA [25-28.5s] -->
  <div class="cta clip" id="e6" data-start="${effects[5].start}" data-duration="${effects[5].dur}">
    <div class="big">立即行动</div>
    <div class="sm">用AI改变工作方式</div>
  </div>

</div></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script>
<script>
window.__timelines={};const tl=gsap.timeline();window.__timelines["root"]=tl;

// 遮罩跟随特效
tl.to('#ov',{opacity:1,duration:0.5,overwrite:"auto"},${se[0].s});
tl.to('#ov',{opacity:0,duration:0.4,overwrite:"auto"},${(se[0].s+se[0].d)});
tl.to('#ov',{opacity:1,duration:0.4,overwrite:"auto"},${se[1].s});
tl.to('#ov',{opacity:0,duration:0.4,overwrite:"auto"},${(se[1].s+se[1].d)});
tl.to('#ov',{opacity:1,duration:0.4,overwrite:"auto"},${se[2].s});
tl.to('#ov',{opacity:0,duration:0.4,overwrite:"auto"},${(se[2].s+se[2].d)});
tl.to('#ov',{opacity:1,duration:0.4,overwrite:"auto"},${se[3].s});
tl.to('#ov',{opacity:0,duration:0.4,overwrite:"auto"},${(se[3].s+se[3].d)});
tl.to('#ov',{opacity:1,duration:0.4,overwrite:"auto"},${se[4].s});
tl.to('#ov',{opacity:0,duration:0.4,overwrite:"auto"},${(se[4].s+se[4].d)});
tl.to('#ov',{opacity:1,duration:0.4,overwrite:"auto"},${se[5].s});

// 特效1: 标签+大字（弹入）
tl.fromTo('#e1a',{opacity:0,x:-30},{opacity:1,x:0,duration:0.6,ease:'power3.out',overwrite:"auto"},${se[0].s});
tl.fromTo('#e1b',{opacity:0,scale:0.7},{opacity:1,scale:1,duration:0.8,ease:'back.out(1.5)',overwrite:"auto"},${(se[0].s+0.3)});
tl.to('#e1a,#e1b',{opacity:0,duration:0.4,overwrite:"auto"},${(se[0].s+se[0].d-0.5)});

// 特效2: 三层标题（上滑入）
tl.fromTo('#e2',{opacity:0,y:40},{opacity:1,y:0,duration:0.7,ease:'power3.out',overwrite:"auto"},${se[1].s});
tl.to('#e2',{opacity:0,duration:0.4,overwrite:"auto"},${(se[1].s+se[1].d-0.5)});

// 特效3: 对比卡片（左右滑入）
tl.fromTo('.compare-card.before',{opacity:0,x:-40},{opacity:1,x:0,duration:0.5,ease:'power3.out',overwrite:"auto"},${se[2].s});
tl.fromTo('.compare-card.now',{opacity:0,x:40},{opacity:1,x:0,duration:0.5,ease:'power3.out',overwrite:"auto"},${(se[2].s+0.2)});
tl.to('#e3',{opacity:0,duration:0.4,overwrite:"auto"},${(se[2].s+se[2].d-0.5)});

// 特效4: 网格（逐个弹入）
tl.fromTo('.grid-card',{opacity:0,scale:0.8},{opacity:1,scale:1,duration:0.4,stagger:0.12,ease:'back.out(1.3)',overwrite:"auto"},${se[3].s});
tl.to('#e4',{opacity:0,duration:0.4,overwrite:"auto"},${(se[3].s+se[3].d-0.5)});

// 特效5: 金句（左滑入）
tl.fromTo('#e5',{opacity:0,x:-40},{opacity:1,x:0,duration:0.7,ease:'power3.out',overwrite:"auto"},${se[4].s});
tl.to('#e5',{opacity:0,duration:0.4,overwrite:"auto"},${(se[4].s+se[4].d-0.5)});

// 特效6: CTA（弹入）
tl.fromTo('#e6',{opacity:0,scale:0.7},{opacity:1,scale:1,duration:0.8,ease:'back.out(1.5)',overwrite:"auto"},${se[5].s});
</script></body></html>`;
}

// 模式B: 配字幕特效（字幕居底，关键词特效在左上）
function generateSubtitleHTML(keywords, title, subtitle, segments, duration) {
  const kw = keywords.slice(0, 8);
  let effectsHTML = '';
  let effectsAnim = '';

  // 根据关键词时间点生成特效
  kw.forEach((k, i) => {
    const t = k.time || i * 3;
    const end = Math.min(t + 2.5, duration);
    effectsHTML += `<div class="kw-fx clip" id="kw${i}" data-start="${t}" data-duration="${end-t}"><div class="kw-tag">${k.word||k}</div></div>`;
    effectsAnim += `tl.fromTo('#kw${i}',{opacity:0,x:-20},{opacity:1,x:0,duration:0.4,overwrite:"auto"},${t});tl.to('#kw${i}',{opacity:0,duration:0.3,overwrite:"auto"},${end-0.3});`;
  });

  // 字幕：每段文字按时间显示
  let subsHTML = '';
  let subsAnim = '';
  (segments || []).forEach((s, i) => {
    subsHTML += `<div class="sub clip" id="sub${i}" data-start="${s.start}" data-duration="${s.end-s.start}">${s.text}</div>`;
    subsAnim += `tl.fromTo('#sub${i}',{opacity:0,y:10},{opacity:1,y:0,duration:0.2,overwrite:"auto"},${s.start});tl.to('#sub${i}',{opacity:0,duration:0.15,overwrite:"auto"},${s.end-0.15});`;
  });

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
@font-face{font-family:'Noto Sans SC';src:url('fonts/NotoSansSC-Regular.ttf');font-weight:400}
@font-face{font-family:'Noto Sans SC';src:url('fonts/NotoSansSC-Bold.ttf');font-weight:700}
@font-face{font-family:'Noto Sans SC';src:url('fonts/NotoSansSC-Black.ttf');font-weight:900}
*{margin:0;padding:0;box-sizing:border-box}
body{width:1920px;height:1080px;background:#000;overflow:hidden;font-family:'Noto Sans SC',sans-serif}
.video-bg{position:absolute;top:0;left:0;width:1920px;height:1080px;object-fit:cover;z-index:1}
.sub{position:absolute;bottom:120px;left:50%;transform:translateX(-50%);z-index:20;font-size:42px;font-weight:700;color:#fff;text-shadow:2px 2px 8px rgba(0,0,0,0.9),0 0 20px rgba(0,0,0,0.5);opacity:0;text-align:center;max-width:1400px;line-height:1.4}
.kw-fx{position:absolute;top:80px;left:80px;z-index:15;opacity:0}
.kw-tag{background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.3);color:#F59E0B;padding:10px 24px;border-radius:24px;font-size:24px;font-weight:700;display:inline-block}
</style></head><body>
<div data-composition-id="root" data-start="0" data-duration="${duration}" data-width="1920" data-height="1080">
<video class="video-bg clip" id="v1" src="source.mp4" data-start="0" data-duration="${duration}" autoplay muted loop></video>
${subsHTML}
${effectsHTML}
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script>
<script>
window.__timelines={};const tl=gsap.timeline();window.__timelines["root"]=tl;
${subsAnim}
${effectsAnim}
</script></body></html>`;
}

// ==================== 智能特效生成（模板替换，一比一复刻手动效果） ====================
function generateSmartHTML(effects, duration, width, height) {
  // 读取模板（兼容不同__dirname路径）
  let templatePath = path.join(__dirname, 'template.html');
  if (!fs.existsSync(templatePath)) {
    templatePath = path.join(__dirname, 'src', 'template.html');
  }
  if (!fs.existsSync(templatePath)) {
    templatePath = path.join(process.cwd(), 'src', 'template.html');
  }
  let html = fs.readFileSync(templatePath, 'utf8');

  // 从effects提取内容
  const getVal = (type, field) => {
    const e = effects.find(x => x.type === type);
    return e ? (e[field] || '') : '';
  };
  const getNum = (type) => {
    const e = effects.find(x => x.type === 'bignum');
    return e ? (e.num || '100%') : '100%';
  };

  // 标签内容
  const tag1 = effects.find(x => x.type === 'tag');
  const tag1En = tag1 ? (tag1.en || tag1.zh || 'KEYWORD') : 'KEYWORD';
  const tag1Zh = tag1 ? (tag1.zh || tag1.en || '关键词') : '关键词';

  // 标题
  const title1 = effects.find(x => x.type === 'three-layer');
  const kw2En = title1 ? (title1.en || 'AI') : 'AI';

  // 对比
  const cmp = effects.find(x => x.type === 'compare');
  const cmpBefore = cmp ? (cmp.before?.val || '旧方式') : '旧方式';
  const cmpBeforeDesc = cmp ? (cmp.before?.desc || '') : '';
  const cmpNow = cmp ? (cmp.now?.val || '新方式') : '新方式';
  const cmpNowDesc = cmp ? (cmp.now?.desc || '') : '';

  // 柱子图
  const chart = effects.find(x => x.type === 'chart' || x.type === 'bignum');
  const chartPct = chart?.pct || 85;
  const chartNum = chart?.num || '85%';
  const chartLabel = chart?.label || '效率提升';

  // 功能网格
  const grid = effects.find(x => x.type === 'grid');
  const gridItems = grid?.items || [{icon:'🎯',name:'功能1'},{icon:'⚡',name:'功能2'},{icon:'🚀',name:'功能3'},{icon:'💡',name:'功能4'}];

  // 金句
  const quote = effects.find(x => x.type === 'quote');
  const quoteText = quote?.text || '金句内容';

  // CTA
  const cta = effects.find(x => x.type === 'cta');
  const ctaText = cta?.text || '立即行动';
  const ctaSub = cta?.sub || '用AI改变工作方式';

  // 时间点：按Whisper时间戳
  const getTime = (type) => {
    const e = effects.find(x => x.type === type);
    return e?.time || 0;
  };

  // 计算每个特效的时间段
  const t1Start = 0.3;
  const t1End = Math.min(5.5, getTime('compare') || 10) - 0.5;
  const t2Start = getTime('compare') || 10;
  const t2End = t2Start + Math.min(5, (getTime('chart') || t2Start+6) - t2Start - 0.5);
  const t3Start = getTime('chart') || (t2End + 2);
  const t3End = t3Start + Math.min(4, (getTime('grid') || t3Start+6) - t3Start - 0.5);
  const t4Start = getTime('grid') || (t3End + 2);
  const t4End = t4Start + Math.min(6, (getTime('quote') || t4Start+8) - t4Start - 0.5);
  const t5Start = getTime('quote') || (t4End + 2);
  const t5End = t5Start + Math.min(5, (getTime('cta') || t5Start+6) - t5Start - 0.5);
  const t6Start = getTime('cta') || (t5End + 2);
  const t6End = Math.min(t6Start + 5, duration);

  // 替换模板占位符
  const replace = (key, val) => { html = html.replace(new RegExp('\\{\\{' + key + '\\}\\}', 'g'), String(val)); };
  replace('TITLE', state.title || '特效');
  replace('DURATION', duration);
  replace('WIDTH', width || 1920);
  replace('HEIGHT', height || 1080);
  const isPortrait = (height || 1080) > (width || 1920);
  if (isPortrait) {
    replace('OVERLAY_BG', 'background:linear-gradient(180deg,rgba(0,0,0,0.82) 0%,rgba(0,0,0,0.55) 60%,rgba(0,0,0,0) 100%);');
    replace('FX_TOP', 'padding-top:80px;');
    replace('PORTRAIT_CSS', `
.effects-layer{text-align:center}
.tag{left:50%;transform:translateX(-50%)}
.big-title{left:50%;transform:translateX(-50%);text-align:center}
.compare-card{left:50%;transform:translateX(-50%)}
.chart-wrap{left:50%;transform:translateX(-50%);text-align:center}
.feature-grid{left:50%;transform:translateX(-50%)}
.quote-card{left:50%;transform:translateX(-50%);text-align:center;border-left:none;border-bottom:5px solid #F59E0B;border-radius:0 0 14px 14px}
.cta-wrap{left:50%;top:40%;transform:translate(-50%,-50%);text-align:center}
`);
  } else {
    replace('OVERLAY_BG', 'background:linear-gradient(90deg,rgba(0,0,0,0.82) 0%,rgba(0,0,0,0.55) 60%,rgba(0,0,0,0) 100%);');
    replace('FX_TOP', '');
    replace('PORTRAIT_CSS', '');
  }
  replace('KW1_EN', tag1En);
  replace('KW1_ZH', tag1Zh);
  replace('KW2_EN', kw2En);
  replace('TITLE_MAIN', state.title || '标题');
  replace('TITLE_SUB', state.subtitle || '');
  replace('T1_DUR', (t1End - t1Start).toFixed(1));
  replace('T1_END', t1End.toFixed(1));
  replace('T2_START', t2Start.toFixed(1));
  replace('T2_DUR', (t2End - t2Start).toFixed(1));
  replace('T2_END', t2End.toFixed(1));
  replace('CMP_BEFORE', cmpBefore);
  replace('CMP_BEFORE_DESC', cmpBeforeDesc);
  replace('CMP_NOW', cmpNow);
  replace('CMP_NOW_DESC', cmpNowDesc);
  replace('T3_START', t3Start.toFixed(1));
  replace('T3_DUR', (t3End - t3Start).toFixed(1));
  replace('T3_END', t3End.toFixed(1));
  replace('CHART_LABEL', chartLabel);
  replace('CHART_PCT', chartPct);
  replace('CHART_NUM', chartNum);
  replace('T4_START', t4Start.toFixed(1));
  replace('T4_DUR', (t4End - t4Start).toFixed(1));
  replace('T4_END', t4End.toFixed(1));
  for (let i = 0; i < 4; i++) {
    const item = gridItems[i] || {};
    replace(`GRID${i+1}_ICON`, item.icon || '');
    replace(`GRID${i+1}_NAME`, item.name || '');
    replace(`GRID${i+1}_DESC`, item.desc || '');
  }
  replace('T5_START', t5Start.toFixed(1));
  replace('T5_DUR', (t5End - t5Start).toFixed(1));
  replace('T5_END', t5End.toFixed(1));
  replace('QUOTE_TEXT', quoteText);
  replace('QUOTE_AUTHOR', '立刻行动');
  replace('T6_START', t6Start.toFixed(1));
  replace('T6_DUR', (t6End - t6Start).toFixed(1));
  replace('CTA_TEXT', ctaText);
  replace('CTA_SUB', ctaSub);

  return html;
}

// ==================== AI ====================
function parseJSON(text) {
  try {
    let c = text.replace(/```json\s*/g, '').replace(/```\s*/g, '');
    c = c.replace(/<think>[\s\S]*?<\/think>/g, '');
    const m = c.match(/\{[\s\S]*\}/);
    if (!m) return {};
    return JSON.parse(m[0]);
  } catch { return {}; }
}

async function callAI(provider, apiKey, prompt) {
  apiKey = apiKey.replace(/[^\x00-\x7F]/g, '').trim();
  let url, body;
  if (provider === 'deepseek') {
    url = 'https://api.deepseek.com/chat/completions';
    body = JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], temperature: 0.7, max_tokens: 1000 });
  } else {
    url = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
    body = JSON.stringify({ model: 'qwen-plus', messages: [{ role: 'user', content: prompt }], temperature: 0.7, max_tokens: 1000 });
  }
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body
  });
  const data = await resp.json();
  return data.choices[0].message.content;
}

// ==================== 启动检测 ====================
(async function() {
  try {
    const config = await ipcRenderer.invoke('load-config');
    if (config.aiProvider) $('#apiProvider').value = config.aiProvider;
    if (config.aiApiKey) $('#apiKey').value = config.aiApiKey;
    if (config.sttApiKey) $('#sttApiKey').value = config.sttApiKey;
  } catch {}

  $('#apiProvider').addEventListener('change', () => {
    ipcRenderer.invoke('save-config', { aiProvider: $('#apiProvider').value });
  });
  $('#apiKey').addEventListener('input', () => {
    ipcRenderer.invoke('save-config', { aiApiKey: $('#apiKey').value });
  });
  $('#sttApiKey').addEventListener('input', () => {
    ipcRenderer.invoke('save-config', { sttApiKey: $('#sttApiKey').value });
  });
})();
