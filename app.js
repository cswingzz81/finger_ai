'use strict';

// ===== 상수 =====
const API = 'https://generativelanguage.googleapis.com/v1beta';
const UPLOAD_API = 'https://generativelanguage.googleapis.com/upload/v1beta/files';
const INLINE_LIMIT = 15 * 1024 * 1024; // 이보다 큰 파일은 Files API로 올린다
const WARN_SEC = 25 * 60;
const MAX_SEC = 30 * 60;
const MIN_SEC = 10;
const GAP_SEC = 1.5;
const TTS_STYLE = '신뢰감 있는 차분한 남성 목소리로, 뉴스 앵커처럼 또박또박 회의 내용을 보고하는 톤';
const SETTINGS_KEY = 'mm_settings';
const DEFAULTS = {
  key: '',
  persist: false,
  minutesModel: 'gemini-4-argon',
  fallbackModel: 'gemini-3.8-flash',
  sttModel: 'gemini-3.5-transcribe',
  voiceEngine: 'chrome',
  ttsModel: 'gemini-3.8-flash-lite-tts',
  ttsVoice: 'Charon',
  glossary: '핑거, 파로스, NextPay, 핑거프라임, OneFinger',
};

const MINUTES_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    purpose: { type: 'string' },
    summary: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: {
      type: 'object',
      properties: { text: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } } },
      required: ['text', 'evidence'] } },
    action_items: { type: 'array', items: {
      type: 'object',
      properties: {
        task: { type: 'string' }, owner: { type: 'string' }, due: { type: 'string' },
        evidence: { type: 'array', items: { type: 'string' } },
      },
      required: ['task', 'owner', 'due', 'evidence'] } },
    pending: { type: 'array', items: {
      type: 'object',
      properties: { text: { type: 'string' }, reason: { type: 'string' } },
      required: ['text', 'reason'] } },
    next_meeting: {
      type: 'object',
      properties: { when: { type: 'string' }, agenda: { type: 'array', items: { type: 'string' } } },
      required: ['when', 'agenda'] },
    tts_script: { type: 'string' },
  },
  required: ['title', 'purpose', 'summary', 'decisions', 'action_items', 'pending', 'next_meeting', 'tts_script'],
};

const STEPS = [
  { key: 'stt', label: '녹취 변환' },
  { key: 'minutes', label: '회의록 작성' },
  { key: 'verify', label: '검증' },
  { key: 'tts', label: '듣기 준비' },
];

// ===== 상태 =====
const $ = (id) => document.getElementById(id);
let S = loadSettings();
let meeting = null;
const rec = { stream: null, recorder: null, chunks: [], ctx: null, analyser: null, raf: 0, tick: 0, elapsed: 0, startedAt: 0, paused: false, warned: false };
const tts = { token: 0, cache: {} };

// ===== 공통 유틸 =====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pad = (n) => String(Math.floor(n)).padStart(2, '0');
const mmss = (sec) => `${pad(sec / 60)}:${pad(sec % 60)}`;
const hhmmss = (sec) => (sec == null ? '--:--:--' : `${pad(sec / 3600)}:${pad((sec % 3600) / 60)}:${pad(sec % 60)}`);
const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD
const isTbd = (v) => !v || /미정/.test(v);

function notice(el, text, kind = '') {
  el.hidden = !text;
  el.className = `notice ${kind}`;
  el.innerHTML = text || '';
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function fileBase() {
  const title = (meeting?.title || '회의').replace(/[\\/:*?"<>|\s]+/g, '');
  return `${today()}_${title}`;
}

// ===== F1. 설정 =====
function loadSettings() {
  let raw = null;
  try { raw = localStorage.getItem(SETTINGS_KEY) || sessionStorage.getItem(SETTINGS_KEY); } catch (e) { /* 저장소 차단 */ }
  try { return { ...DEFAULTS, ...(raw ? JSON.parse(raw) : {}) }; } catch (e) { return { ...DEFAULTS }; }
}

function saveSettings() {
  const json = JSON.stringify(S);
  try {
    if (S.persist) { localStorage.setItem(SETTINGS_KEY, json); sessionStorage.removeItem(SETTINGS_KEY); }
    else { sessionStorage.setItem(SETTINGS_KEY, json); localStorage.removeItem(SETTINGS_KEY); }
  } catch (e) { /* 저장소 차단 시 메모리에만 유지 */ }
}

const SETTING_FIELDS = { sKey: 'key', sMinutesModel: 'minutesModel', sFallbackModel: 'fallbackModel', sSttModel: 'sttModel',
  sVoiceEngine: 'voiceEngine', sTtsModel: 'ttsModel', sTtsVoice: 'ttsVoice', sGlossary: 'glossary' };

function openSettings() {
  for (const [id, k] of Object.entries(SETTING_FIELDS)) $(id).value = S[k];
  $('sPersist').checked = S.persist;
  $('keyStatus').textContent = '';
  $('dlgSettings').showModal();
}

function readSettingsForm() {
  const next = { ...S };
  for (const [id, k] of Object.entries(SETTING_FIELDS)) next[k] = $(id).value.trim() || DEFAULTS[k];
  next.persist = $('sPersist').checked;
  return next;
}

async function testKey() {
  const s = readSettingsForm();
  $('keyStatus').textContent = '확인 중…';
  try {
    await callGemini({ model: s.fallbackModel, input: '안녕' }, s.key);
    $('keyStatus').textContent = '✔ 연결됨 · 회의록 모델 확인 중…';
    try {
      await callGemini({ model: s.minutesModel, input: '안녕' }, s.key);
      $('keyStatus').textContent = `✔ 연결됨 · ${s.minutesModel} 사용 가능`;
    } catch (e) {
      $('keyStatus').textContent = `✔ 연결됨 · ${s.minutesModel} 사용 불가 → 회의록 모델을 ${s.fallbackModel}(으)로 바꾸세요`;
    }
  } catch (e) {
    $('keyStatus').textContent = isKeyError(e) ? '✖ API 키를 확인해 주세요' : `✖ ${e.message}`;
  }
}

function updateGate() {
  const hasKey = !!S.key;
  const recording = !!rec.recorder;
  $('keyNotice').hidden = hasKey;
  $('btnStart').disabled = !hasKey || !$('consent').checked || recording;
  $('fileInput').disabled = !hasKey || !$('consent').checked || recording;
}

// ===== Gemini 호출 =====
async function callGemini(body, key = S.key, retried = false) {
  let res;
  try {
    res = await fetch(`${API}/interactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error('연결이 끊겼습니다');
  }
  if (res.status === 429 && !retried) {
    notice($('pipeNotice'), '요청 한도에 걸렸습니다. 10초 뒤 다시 시도합니다…', 'warn');
    await sleep(10000);
    notice($('pipeNotice'), '');
    return callGemini(body, key, true);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function isKeyError(e) {
  return e.status === 401 || /API key|API_KEY/i.test(e.message) || (e.status === 403 && /permission|key/i.test(e.message) && !/model/i.test(e.message));
}

// REST 응답에는 output_text가 없을 수 있어 steps에서 직접 모은다
function outputText(d) {
  if (typeof d.output_text === 'string' && d.output_text) return d.output_text;
  const parts = [];
  for (const step of d.steps || []) {
    if (step.type !== 'model_output') continue;
    for (const c of step.content || []) if (c.type === 'text') parts.push(c.text || '');
  }
  return parts.join('');
}

function outputAudio(d) {
  if (d.output_audio?.data) return d.output_audio;
  for (const step of d.steps || []) {
    for (const c of step.content || []) if (c.type === 'audio' && c.data) return c;
  }
  return null;
}

async function uploadToFiles(blob, mime) {
  const start = await fetch(UPLOAD_API, {
    method: 'POST',
    headers: {
      'x-goog-api-key': S.key,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(blob.size),
      'X-Goog-Upload-Header-Content-Type': mime,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: 'meeting-audio' } }),
  });
  const url = start.headers.get('x-goog-upload-url');
  if (!start.ok || !url) throw new Error(`파일 업로드를 시작하지 못했습니다 (HTTP ${start.status})`);
  const up = await fetch(url, {
    method: 'POST',
    headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
    body: blob,
  });
  const info = await up.json().catch(() => ({}));
  if (!up.ok || !info.file?.uri) throw new Error(`파일 업로드 실패 (HTTP ${up.status})`);
  return info.file.uri;
}

// ===== F2. 녹음 =====
async function startRecording() {
  notice($('recNotice'), '');
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    notice($('recNotice'), '마이크를 쓸 수 없습니다. 주소창 왼쪽 자물쇠 → 마이크 허용 후 새로고침해 주세요.', 'err');
    $('btnStart').disabled = true;
    return;
  }
  newMeeting();
  rec.chunks = [];
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
  rec.recorder = new MediaRecorder(rec.stream, { mimeType, audioBitsPerSecond: 32000 });
  rec.recorder.ondataavailable = (e) => e.data.size && rec.chunks.push(e.data);
  rec.recorder.onstop = onRecordingStopped;
  rec.recorder.start(1000);

  rec.ctx = new AudioContext();
  rec.analyser = rec.ctx.createAnalyser();
  rec.analyser.fftSize = 512;
  rec.ctx.createMediaStreamSource(rec.stream).connect(rec.analyser);
  drawMeter();

  rec.elapsed = 0;
  rec.startedAt = performance.now();
  rec.paused = false;
  rec.warned = false;
  rec.tick = setInterval(onTick, 250);

  $('btnPause').disabled = false;
  $('btnStop').disabled = false;
  $('btnPause').textContent = 'Ⅱ 일시정지';
  updateGate();
}

function elapsedSec() {
  return rec.elapsed + (rec.paused ? 0 : (performance.now() - rec.startedAt) / 1000);
}

function onTick() {
  const sec = elapsedSec();
  $('timer').textContent = mmss(sec);
  if (sec >= WARN_SEC && !rec.warned) {
    rec.warned = true;
    notice($('recNotice'), '5분 뒤 자동 종료됩니다 (화자 구분 STT는 최대 30분).', 'warn');
  }
  if (sec >= MAX_SEC) stopRecording();
}

function drawMeter() {
  const buf = new Uint8Array(rec.analyser.fftSize);
  const loop = () => {
    rec.analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += ((v - 128) / 128) ** 2;
    const rms = Math.sqrt(sum / buf.length);
    $('meterBar').style.width = `${Math.min(100, rms * 400)}%`;
    rec.raf = requestAnimationFrame(loop);
  };
  loop();
}

function togglePause() {
  if (!rec.recorder) return;
  if (rec.paused) {
    rec.recorder.resume();
    rec.startedAt = performance.now();
    rec.paused = false;
    $('btnPause').textContent = 'Ⅱ 일시정지';
  } else {
    rec.recorder.pause();
    rec.elapsed = elapsedSec();
    rec.paused = true;
    $('btnPause').textContent = '▶ 재개';
  }
}

function stopRecording() {
  if (!rec.recorder || rec.recorder.state === 'inactive') return;
  meeting.durationSec = Math.round(elapsedSec());
  clearInterval(rec.tick);
  rec.recorder.stop();
}

function onRecordingStopped() {
  cancelAnimationFrame(rec.raf);
  rec.stream.getTracks().forEach((t) => t.stop());
  rec.ctx.close();
  $('meterBar').style.width = '0';
  meeting.audio = new Blob(rec.chunks, { type: 'audio/webm' });
  meeting.audioName = `녹음_${fileBase()}.webm`;
  rec.recorder = null;
  $('btnPause').disabled = true;
  $('btnStop').disabled = true;
  updateGate();
  if (meeting.durationSec < MIN_SEC) {
    notice($('recNotice'), '녹음이 너무 짧습니다 (10초 이상 녹음해 주세요).', 'err');
    return;
  }
  notice($('recNotice'), `녹음 완료 · ${mmss(meeting.durationSec)}`);
  runPipeline('stt');
}

// ===== 업로드 (녹음 파일 또는 녹취 .txt) =====
async function onFileSelected(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  newMeeting();
  if (/\.txt$/i.test(file.name) || file.type === 'text/plain') {
    meeting.transcript = parseTranscriptText(await file.text());
    if (!meeting.transcript.length) {
      notice($('recNotice'), '녹취 파일에서 읽을 내용이 없습니다.', 'err');
      return;
    }
    notice($('recNotice'), `녹취 업로드 완료 · ${file.name} · ${meeting.transcript.length}개 발화`);
    renderTranscript();
    setStep('stt', 'done', '업로드');
    runPipeline('minutes');
    return;
  }
  meeting.audio = file;
  meeting.audioName = file.name;
  meeting.durationSec = await audioDuration(file);
  if (meeting.durationSec != null && meeting.durationSec < MIN_SEC) {
    notice($('recNotice'), '녹음이 너무 짧습니다 (10초 이상이어야 합니다).', 'err');
    return;
  }
  const len = meeting.durationSec != null ? ` · ${mmss(meeting.durationSec)}` : '';
  const warn = meeting.durationSec > MAX_SEC ? ' — 30분이 넘어 화자 구분이 실패할 수 있습니다.' : '';
  notice($('recNotice'), `파일 업로드 완료 · ${esc(file.name)}${len}${warn}`, warn ? 'warn' : '');
  runPipeline('stt');
}

function audioDuration(blob) {
  return new Promise((resolve) => {
    const a = new Audio();
    const url = URL.createObjectURL(blob);
    const done = (v) => { URL.revokeObjectURL(url); resolve(v); };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? Math.round(a.duration) : null);
    a.onerror = () => done(null);
    setTimeout(() => done(null), 5000);
    a.src = url;
  });
}

function audioMime(blob) {
  const t = (blob.type || '').split(';')[0];
  const name = blob.name || '';
  const map = { 'audio/x-m4a': 'audio/m4a', 'audio/mp4': 'audio/m4a', 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav',
    'audio/mp3': 'audio/mpeg', 'video/webm': 'audio/webm', 'audio/x-flac': 'audio/flac' };
  if (map[t]) return map[t];
  if (t.startsWith('audio/')) return t;
  const ext = name.split('.').pop().toLowerCase();
  return { m4a: 'audio/m4a', mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac' }[ext] || 'audio/webm';
}

// "[U1 00:00:03 화자1] 내용" 또는 "김가람: 내용" 또는 그냥 한 줄
function parseTranscriptText(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let m = line.match(/^\[(?:U\d+\s+)?(?:(\d{1,2}):(\d{2}):(\d{2})\s+)?([^\]]+)\]\s*(.+)$/);
    if (m) {
      const start = m[1] != null ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null;
      out.push({ start, end: start, speaker: m[4].trim(), text: m[5].trim() });
      continue;
    }
    m = line.match(/^([^:：]{1,20})[:：]\s*(.+)$/);
    if (m) out.push({ start: null, end: null, speaker: m[1].trim(), text: m[2].trim() });
    else out.push({ start: null, end: null, speaker: '화자', text: line });
  }
  return out.map((u, i) => ({ id: `U${i + 1}`, ...u }));
}

// ===== F3. 파이프라인 =====
function newMeeting() {
  stopSpeaking();
  tts.cache = {};
  meeting = {
    id: new Date().toISOString(),
    title: $('title').value.trim() || '회의',
    participants: $('participants').value.split(',').map((s) => s.trim()).filter(Boolean),
    consent: $('consent').checked,
    audio: null,
    audioName: '',
    durationSec: null,
    transcript: [],
    minutes: null,
    rawMinutes: '',
    validation: { passed: false, warnings: [] },
    models: { stt: S.sttModel, minutes: S.minutesModel },
    createdAt: new Date().toISOString(),
  };
  for (const st of STEPS) setStep(st.key, 'idle');
  notice($('pipeNotice'), '');
  $('tabMinutes').innerHTML = '<p class="muted">처리 중…</p>';
  $('tabTranscript').innerHTML = '<p class="muted">처리 중…</p>';
}

const stepState = {};
function renderSteps() {
  const label = { idle: '○', running: '⟳', done: '✔', failed: '✖' };
  $('steps').innerHTML = STEPS.map(({ key, label: name }) => {
    const s = stepState[key] || { status: 'idle' };
    const secs = s.status === 'running' ? Math.round((performance.now() - s.t0) / 1000) : s.secs;
    const time = secs != null ? `(${secs}초)` : '';
    const extra = s.note ? ` · ${esc(s.note)}` : '';
    const retry = s.status === 'failed' ? ` <button class="small" data-retry="${key}">다시 시도</button>` : '';
    return `<li class="${s.status}">${label[s.status]} ${name} ${time}${extra}${retry}</li>`;
  }).join('');
}

function setStep(key, status, note = '') {
  const prev = stepState[key] || {};
  const s = { status, note };
  if (status === 'running') s.t0 = performance.now();
  if (status === 'done' || status === 'failed') s.secs = prev.t0 ? Math.round((performance.now() - prev.t0) / 1000) : null;
  stepState[key] = s;
  renderSteps();
}
setInterval(() => Object.values(stepState).some((s) => s.status === 'running') && renderSteps(), 1000);

let pipelineBusy = false;
async function runPipeline(from) {
  if (pipelineBusy || !meeting) return;
  pipelineBusy = true;
  notice($('pipeNotice'), '');
  const order = STEPS.map((s) => s.key);
  try {
    for (const key of order.slice(order.indexOf(from))) {
      setStep(key, 'running');
      try {
        const note = await RUNNERS[key]();
        setStep(key, 'done', note || '');
      } catch (e) {
        setStep(key, 'failed');
        handleStepError(key, e);
        return;
      }
    }
  } finally {
    pipelineBusy = false;
  }
}

function handleStepError(key, e) {
  console.error(key, e);
  if (isKeyError(e)) {
    notice($('pipeNotice'), 'API 키를 확인해 주세요.', 'err');
    openSettings();
    return;
  }
  if (key === 'minutes' && [400, 403, 404].includes(e.status) && meeting.models.minutes !== S.fallbackModel) {
    notice($('pipeNotice'),
      `${esc(meeting.models.minutes)} 모델을 쓸 수 없는 키입니다 (${esc(e.message)}). 대체 모델로 다시 만들까요? ` +
      `<button class="small" id="btnFallback">대체 모델(${esc(S.fallbackModel)})로 다시 시도</button>`, 'err');
    $('btnFallback').onclick = () => { meeting.models.minutes = S.fallbackModel; runPipeline('minutes'); };
    return;
  }
  notice($('pipeNotice'), `${esc(e.message)} — 실패한 단계의 [다시 시도]를 눌러 주세요. 앞 단계 결과는 그대로 있습니다.`, 'err');
}

const RUNNERS = {
  async stt() {
    if (!meeting.audio) throw new Error('녹음 파일이 없습니다');
    const mime = audioMime(meeting.audio);
    const audio = meeting.audio.size <= INLINE_LIMIT
      ? { type: 'audio', data: await blobToBase64(meeting.audio), mime_type: mime }
      : { type: 'audio', uri: await uploadToFiles(meeting.audio, mime), mime_type: mime };
    const data = await callGemini({
      model: meeting.models.stt,
      input: [audio],
      generation_config: {
        transcription_config: {
          language_codes: ['ko-KR'],
          mode: { type: 'verbatim', diarization_mode: 'speaker', timestamp_granularities: ['word'] },
        },
      },
    });
    meeting.transcript = buildUtterances(data);
    if (!meeting.transcript.length) throw new Error('녹취 결과가 비어 있습니다');
    renderTranscript();
    return `${meeting.transcript.length}개 발화`;
  },

  async minutes() {
    meeting.rawMinutes = await requestMinutes();
  },

  async verify() {
    let result = validateMinutes(meeting.rawMinutes);
    if (result.fatal.length) {
      // V1 · V2 실패 → 문제 목록을 붙여 1회 재작성
      setStep('verify', 'running', '재작성 중');
      meeting.rawMinutes = await requestMinutes(result.fatal);
      result = validateMinutes(meeting.rawMinutes);
    }
    if (!result.minutes) throw new Error(`회의록 JSON을 읽지 못했습니다: ${result.fatal.join(', ')}`);
    meeting.minutes = result.minutes;
    meeting.validation = { passed: !result.fatal.length && !result.warnings.length, warnings: [...result.fatal, ...result.warnings] };
    renderMinutes();
    return meeting.validation.passed ? '통과' : `경고 ${meeting.validation.warnings.length}건`;
  },

  async tts() {
    if (S.voiceEngine !== 'gemini') {
      const v = koreanVoice();
      return v ? v.name : '한국어 음성 없음 — 기본 음성 사용';
    }
    await geminiAudio('full');
    return `${S.ttsVoice}`;
  },
};

// 단어 단위 결과 → 발화 묶기 (같은 화자 + 1.5초 미만 간격)
function buildUtterances(data) {
  const words = [];
  for (const step of data.steps || []) {
    for (const c of step.content || []) {
      for (const a of c.annotations || []) if (a.type === 'word_info' && a.text) words.push(a);
    }
  }
  const sec = (s) => (s == null ? null : parseFloat(String(s)));
  const spk = (s) => (s ? `화자${String(s).replace(/\D/g, '') || s}` : '화자');
  const utts = [];
  for (const w of words) {
    const start = sec(w.start_offset);
    const end = sec(w.end_offset);
    const last = utts[utts.length - 1];
    if (last && last.speaker === spk(w.speaker) && (start == null || last.end == null || start - last.end < GAP_SEC)) {
      last.text += ` ${w.text}`;
      last.end = end ?? last.end;
    } else {
      utts.push({ start, end, speaker: spk(w.speaker), text: w.text });
    }
  }
  if (!utts.length) {
    // 단어 정보가 없으면 전체 글을 문장 단위로 나눈다
    for (const line of outputText(data).split(/\n+|(?<=[.?!])\s+/)) {
      if (line.trim()) utts.push({ start: null, end: null, speaker: '화자', text: line.trim() });
    }
  }
  return utts.map((u, i) => ({ id: `U${i + 1}`, ...u, text: u.text.replace(/\s+([.,?!])/g, '$1').replace(/\s{2,}/g, ' ') }));
}

function transcriptLines() {
  return meeting.transcript.map((u) => `[${u.id} ${hhmmss(u.start)} ${u.speaker}] ${u.text}`).join('\n');
}

function minutesPrompt() {
  const who = meeting.participants.length ? meeting.participants.join(', ') : '알 수 없음';
  return `[역할] 너는 우리 팀 회의록 담당이야.

[맥락] 아래는 ${today()} 「${meeting.title}」 회의의 녹취야. 참석자: ${who}.
녹취는 음성 인식 결과라서 오탈자가 있을 수 있어. 아래 용어집에 있는 말은 용어집 표기로 고쳐 써.
용어집: ${S.glossary}
각 줄은 [발화번호 시간 화자] 형식이야.

[형식] 주어진 JSON 스키마로만 답해.
- title: 회의 제목 (「${meeting.title}」)
- purpose: 회의 목적 한 줄
- summary: 핵심 요약 3줄
- decisions: 결정된 것만. 「~하기로 했다」 수준으로 확정된 것
- action_items: 할 일 · 담당 · 기한. 담당이나 기한이 녹취에 없으면 "미정"
- pending: 결론 없이 미룬 안건과 그 이유
- next_meeting: 일시와 안건. 없으면 when은 "미정"
- tts_script: 회의에 없던 사람이 들을 1분 분량 평문 요약. 기호 · 표 · 괄호 없이 문장으로만
- 모든 decisions · action_items 항목의 evidence에 근거가 된 발화번호(예: "U12")를 1개 이상 넣어

[예시] action_items 한 줄 예시:
{"task": "견적서 할인율 수정 후 발송", "owner": "이도윤", "due": "10/23(금)", "evidence": ["U14"]}

[검증] 답하기 전에 스스로 점검해.
1. 녹취에 없는 내용은 쓰지 않았나 (추측 금지)
2. 결정사항과 보류 안건을 섞지 않았나
3. 액션아이템마다 담당 · 기한이 있거나 "미정"인가
4. evidence의 발화번호가 실제 녹취에 있는가

[녹취]
${transcriptLines()}`;
}

async function requestMinutes(problems) {
  let input = minutesPrompt();
  if (problems?.length) {
    input += `\n\n[앞의 답]\n${meeting.rawMinutes}\n\n앞의 답에서 다음 문제가 있었어: ${problems.join(' / ')}. 같은 스키마로 고쳐서 다시 답해.`;
  }
  const data = await callGemini({
    model: meeting.models.minutes,
    input,
    response_format: { type: 'text', mime_type: 'application/json', schema: MINUTES_SCHEMA },
  });
  return outputText(data);
}

// ===== 검증 V1~V5 =====
function validateMinutes(raw) {
  const fatal = [];
  const warnings = [];
  let m;
  try {
    m = JSON.parse(String(raw).replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch (e) {
    return { minutes: null, fatal: ['V1 JSON으로 읽을 수 없음'], warnings };
  }
  const missing = MINUTES_SCHEMA.required.filter((k) => m[k] == null);
  if (missing.length) fatal.push(`V1 필수 칸 없음: ${missing.join(', ')}`);
  m.summary ||= []; m.decisions ||= []; m.action_items ||= []; m.pending ||= [];
  m.next_meeting ||= { when: '미정', agenda: [] };
  m.next_meeting.agenda ||= [];
  m.tts_script ||= '';
  m.title ||= meeting.title;

  const ids = new Set(meeting.transcript.map((u) => u.id));
  const bad = new Set();
  const noEv = [];
  for (const [i, it] of [...m.decisions, ...m.action_items].entries()) {
    it.evidence ||= [];
    if (!it.evidence.length) noEv.push(i + 1);
    for (const ev of it.evidence) if (!ids.has(ev)) bad.add(ev);
  }
  if (bad.size) fatal.push(`V2 녹취에 없는 발화번호: ${[...bad].join(', ')}`);
  if (noEv.length) fatal.push('V2 근거 발화번호가 없는 항목이 있음');

  let filled = 0;
  for (const it of m.action_items) {
    if (!it.owner?.trim()) { it.owner = '미정'; filled++; }
    if (!it.due?.trim()) { it.due = '미정'; filled++; }
  }
  if (filled) warnings.push(`V3 빈 담당 · 기한 ${filled}칸을 「미정」으로 채움`);
  if (m.summary.length < 1 || m.summary.length > 5) warnings.push(`V4 요약이 ${m.summary.length}줄`);
  if (m.tts_script.length > 1000) warnings.push(`V4 음성 요약이 ${m.tts_script.length}자 (1,000자 초과)`);
  const dur = meeting.durationSec ?? (meeting.transcript.at(-1)?.end || 0);
  if (!m.decisions.length && !m.action_items.length && dur >= 180) warnings.push('V5 결정사항을 찾지 못했습니다 — 녹취를 확인하세요');
  return { minutes: m, fatal, warnings };
}

// ===== F4 · F5. 결과 보기 =====
function renderTranscript() {
  $('tabTranscript').innerHTML = `<div class="transcript">${meeting.transcript.map((u) =>
    `<div id="line-${u.id}"><span class="id">[${u.id}]</span> <span class="t">${u.start == null ? '--:--' : mmss(u.start)}</span> ${esc(u.speaker)} — ${esc(u.text)}</div>`
  ).join('')}</div>`;
}

const ed = (path, value) => `<span contenteditable="true" data-path="${path}" class="${isTbd(value) ? 'tbd' : ''}">${esc(value || '미정')}</span>`;
const evs = (list) => (list || []).map((id) => `<span class="ev" data-ev="${esc(id)}">${esc(id)}</span>`).join('');

function renderMinutes() {
  const m = meeting.minutes;
  const v = meeting.validation;
  const badge = v.passed
    ? '<span class="badge ok">검증 통과</span>'
    : `<span class="badge warn">경고</span>${v.warnings.map(esc).join(' · ')}`;
  const list = (arr, key) => (arr.length ? `<ul>${arr.map((s, i) => `<li>${ed(`${key}.${i}`, s)}</li>`).join('')}</ul>` : '<p class="muted">없음</p>');
  $('tabMinutes').innerHTML = `
    <p>${badge}</p>
    <div class="card"><h3>제목 · 날짜 · 참석자</h3>${ed('title', m.title)} · ${today()} · ${esc(meeting.participants.join(', ') || '알 수 없음')}</div>
    <div class="card"><h3>목적</h3>${ed('purpose', m.purpose)}</div>
    <div class="card"><h3>요약</h3>${list(m.summary, 'summary')}</div>
    <div class="card"><h3>결정사항</h3>${m.decisions.length
      ? `<ul>${m.decisions.map((d, i) => `<li>${ed(`decisions.${i}.text`, d.text)}${evs(d.evidence)}</li>`).join('')}</ul>`
      : '<p class="muted">없음</p>'}</div>
    <div class="card"><h3>액션아이템</h3>${m.action_items.length ? `<table>
      <tr><th>할 일</th><th>담당</th><th>기한</th><th>근거</th></tr>
      ${m.action_items.map((a, i) => `<tr><td>${ed(`action_items.${i}.task`, a.task)}</td><td>${ed(`action_items.${i}.owner`, a.owner)}</td>
        <td>${ed(`action_items.${i}.due`, a.due)}</td><td>${evs(a.evidence)}</td></tr>`).join('')}
    </table>` : '<p class="muted">없음</p>'}</div>
    <div class="card"><h3>보류</h3>${m.pending.length
      ? `<ul>${m.pending.map((p, i) => `<li>${ed(`pending.${i}.text`, p.text)} — ${ed(`pending.${i}.reason`, p.reason)}</li>`).join('')}</ul>`
      : '<p class="muted">없음</p>'}</div>
    <div class="card"><h3>다음 회의</h3>${ed('next_meeting.when', m.next_meeting.when)}${list(m.next_meeting.agenda, 'next_meeting.agenda')}</div>
    <div class="card"><h3>음성 요약 원고</h3>${ed('tts_script', m.tts_script)}</div>`;
  showTab('minutes');
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => o[k], obj);
  target[last] = value;
}

function onMinutesEdit(e) {
  const el = e.target.closest('[data-path]');
  if (!el || !meeting?.minutes) return;
  const value = el.textContent.trim();
  setPath(meeting.minutes, el.dataset.path, value);
  el.classList.toggle('tbd', isTbd(value));
  tts.cache = {};
}

function showTab(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $('tabMinutes').hidden = name !== 'minutes';
  $('tabTranscript').hidden = name !== 'transcript';
}

function jumpToEvidence(id) {
  showTab('transcript');
  document.querySelectorAll('.transcript .hl').forEach((el) => el.classList.remove('hl'));
  const line = $(`line-${id}`);
  if (line) { line.classList.add('hl'); line.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
}

// ===== F6. 듣기 =====
function speechText(kind) {
  const m = meeting?.minutes;
  if (!m) return '';
  const decisions = m.decisions.length
    ? `결정사항입니다. ${m.decisions.map((d, i) => `${i + 1}번. ${d.text}.`).join(' ')}`
    : '결정사항은 없습니다.';
  const actions = m.action_items.length
    ? `액션아이템입니다. ${m.action_items.map((a, i) => `${i + 1}번. ${a.task}. 담당 ${a.owner}. 기한 ${a.due}.`).join(' ')}`
    : '액션아이템은 없습니다.';
  if (kind === 'decisions') return decisions;
  if (kind === 'actions') return actions;
  return m.tts_script || `${m.purpose}. ${m.summary.join(' ')} ${decisions} ${actions}`;
}

function koreanVoice() {
  const voices = speechSynthesis.getVoices();
  return voices.find((v) => v.lang === 'ko-KR' && /Google/.test(v.name))
    || voices.find((v) => v.lang?.startsWith('ko'));
}

async function speak(kind) {
  stopSpeaking();
  const text = speechText(kind);
  if (!text) { $('ttsInfo').textContent = '먼저 회의록을 만들어 주세요.'; return; }
  const rate = parseFloat($('rate').value);
  if (S.voiceEngine === 'gemini') {
    $('ttsInfo').textContent = 'Gemini 음성 생성 중…';
    try {
      const url = await geminiAudio(kind);
      const player = $('player');
      player.hidden = false;
      player.src = url;
      player.playbackRate = rate;
      await player.play();
      $('ttsInfo').innerHTML = `<a href="${url}" download="음성요약_${esc(fileBase())}_${kind}.wav">음성 다운로드</a>`;
    } catch (e) {
      $('ttsInfo').textContent = `Gemini 음성 실패: ${e.message} — Chrome 음성으로 읽습니다.`;
      speakChrome(text, rate);
    }
    return;
  }
  speakChrome(text, rate);
}

// 긴 글은 Chrome에서 끊기므로 문장 단위로 차례로 읽는다
function speakChrome(text, rate) {
  const token = ++tts.token;
  const sentences = text.split(/(?<=[.?!。])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const voice = koreanVoice();
  let i = 0;
  const next = () => {
    if (token !== tts.token || i >= sentences.length) {
      if (token === tts.token) $('ttsInfo').textContent = '';
      return;
    }
    const u = new SpeechSynthesisUtterance(sentences[i++]);
    u.lang = 'ko-KR';
    if (voice) u.voice = voice;
    u.rate = rate;
    u.onend = next;
    u.onerror = next;
    speechSynthesis.speak(u);
  };
  $('ttsInfo').textContent = `읽는 중 (${voice?.name || '기본 음성'})`;
  next();
}

function stopSpeaking() {
  tts.token++;
  speechSynthesis.cancel();
  const player = $('player');
  player.pause();
}

async function geminiAudio(kind) {
  if (tts.cache[kind]) return tts.cache[kind];
  const data = await callGemini({
    model: S.ttsModel,
    input: [{
      type: 'user_input',
      content: [{ type: 'text', text: speechText(kind), annotations: [{ type: 'speech_metadata', style: TTS_STYLE }] }],
    }],
    response_format: { type: 'audio', mime_type: 'audio/wav' },
    generation_config: { speech_config: [{ voice: S.ttsVoice }] },
  });
  const audio = outputAudio(data);
  if (!audio) throw new Error('음성 데이터가 없습니다');
  const bytes = Uint8Array.from(atob(audio.data), (c) => c.charCodeAt(0));
  const isPcm = /l16|pcm/i.test(audio.mime_type || '');
  const blob = isPcm ? pcmToWav(bytes, audio.sample_rate || 24000) : new Blob([bytes], { type: audio.mime_type || 'audio/wav' });
  tts.cache[kind] = URL.createObjectURL(blob);
  return tts.cache[kind];
}

function pcmToWav(pcm, sampleRate) {
  const header = new DataView(new ArrayBuffer(44));
  const str = (o, s) => [...s].forEach((c, i) => header.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); header.setUint32(4, 36 + pcm.length, true); str(8, 'WAVE');
  str(12, 'fmt '); header.setUint32(16, 16, true); header.setUint16(20, 1, true); header.setUint16(22, 1, true);
  header.setUint32(24, sampleRate, true); header.setUint32(28, sampleRate * 2, true);
  header.setUint16(32, 2, true); header.setUint16(34, 16, true);
  str(36, 'data'); header.setUint32(40, pcm.length, true);
  return new Blob([header, pcm], { type: 'audio/wav' });
}

// ===== F7. 내보내기 =====
function toMarkdown() {
  const m = meeting?.minutes;
  if (!m) return '';
  const ev = (list) => (list?.length ? ` (${list.join(', ')})` : '');
  const lines = [
    `# ${m.title}`,
    '',
    `- 날짜: ${today()}`,
    `- 참석자: ${meeting.participants.join(', ') || '알 수 없음'}`,
    '',
    '## 목적', m.purpose, '',
    '## 요약', ...m.summary.map((s) => `- ${s}`), '',
    '## 결정사항', ...(m.decisions.length ? m.decisions.map((d) => `- ${d.text}${ev(d.evidence)}`) : ['- 없음']), '',
    '## 액션아이템',
    '| 할 일 | 담당 | 기한 | 근거 |',
    '|---|---|---|---|',
    ...m.action_items.map((a) => `| ${a.task} | ${a.owner} | ${a.due} | ${(a.evidence || []).join(', ')} |`), '',
    '## 보류', ...(m.pending.length ? m.pending.map((p) => `- ${p.text} — ${p.reason}`) : ['- 없음']), '',
    '## 다음 회의', `- 일시: ${m.next_meeting.when}`, ...m.next_meeting.agenda.map((a) => `- 안건: ${a}`), '',
  ];
  return lines.join('\n');
}

function exportGuard(ok, what) {
  if (!ok) notice($('pipeNotice'), `${what}이(가) 아직 없습니다.`, 'warn');
  return ok;
}

// ===== 이벤트 연결 =====
$('btnSettings').onclick = openSettings;
$('btnCloseSettings').onclick = () => $('dlgSettings').close();
$('btnTestKey').onclick = testKey;
$('formSettings').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'save') return;
  S = readSettingsForm();
  saveSettings();
  updateGate();
});
$('consent').onchange = updateGate;
$('btnStart').onclick = startRecording;
$('btnPause').onclick = togglePause;
$('btnStop').onclick = stopRecording;
$('fileInput').onchange = onFileSelected;
$('steps').onclick = (e) => { const k = e.target.dataset?.retry; if (k) runPipeline(k); };
document.querySelectorAll('.tab').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
$('tabMinutes').addEventListener('input', onMinutesEdit);
$('tabMinutes').addEventListener('click', (e) => { const id = e.target.dataset?.ev; if (id) jumpToEvidence(id); });
document.querySelectorAll('[data-say]').forEach((b) => (b.onclick = () => speak(b.dataset.say)));
$('btnSayStop').onclick = () => { stopSpeaking(); $('ttsInfo').textContent = ''; };
$('rate').onchange = () => { $('player').playbackRate = parseFloat($('rate').value); };

$('btnCopyMd').onclick = async () => {
  if (!exportGuard(meeting?.minutes, '회의록')) return;
  await navigator.clipboard.writeText(toMarkdown());
  notice($('pipeNotice'), 'Markdown을 복사했습니다.');
};
$('btnDlMd').onclick = () => exportGuard(meeting?.minutes, '회의록')
  && download(new Blob([toMarkdown()], { type: 'text/markdown' }), `회의록_${fileBase()}.md`);
$('btnDlAudio').onclick = () => exportGuard(meeting?.audio, '녹음') && download(meeting.audio, meeting.audioName);
$('btnDlTxt').onclick = () => exportGuard(meeting?.transcript.length, '녹취')
  && download(new Blob([transcriptLines()], { type: 'text/plain' }), `녹취_${fileBase()}.txt`);

window.addEventListener('beforeunload', (e) => {
  if (rec.recorder) { e.preventDefault(); e.returnValue = ''; }
});
speechSynthesis.getVoices(); // 음성 목록 미리 불러오기

renderSteps();
updateGate();
if (!S.key) openSettings();
