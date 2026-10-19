'use strict';

// app.js와 같은 저장소 키 · 모델 기본값을 쓴다
const API = 'https://generativelanguage.googleapis.com/v1beta';
const SETTINGS_KEY = 'mm_settings';
const MODEL_DEFAULTS = { minutesModel: 'gemini-4-argon', fallbackModel: 'gemini-3.8-flash' };
const $ = (id) => document.getElementById(id);

function readStored() {
  for (const [store, persist] of [[localStorage, true], [sessionStorage, false]]) {
    try {
      const raw = store.getItem(SETTINGS_KEY);
      if (raw) return { settings: JSON.parse(raw), persist };
    } catch (e) { /* 저장소 차단 · 깨진 값 */ }
  }
  return { settings: {}, persist: false };
}

function writeStored(settings, persist) {
  const json = JSON.stringify({ ...settings, persist });
  try {
    if (persist) { localStorage.setItem(SETTINGS_KEY, json); sessionStorage.removeItem(SETTINGS_KEY); }
    else { sessionStorage.setItem(SETTINGS_KEY, json); localStorage.removeItem(SETTINGS_KEY); }
    return true;
  } catch (e) {
    return false;
  }
}

const mask = (k) => (k.length > 10 ? `${k.slice(0, 6)}…${k.slice(-4)}` : '••••');

function showStatus() {
  const { settings, persist } = readStored();
  const el = $('status');
  if (settings.key) {
    el.className = 'notice';
    el.textContent = `등록됨: ${mask(settings.key)} · ${persist ? '이 브라우저에 저장' : '이 탭을 닫으면 삭제'}`;
  } else {
    el.className = 'notice warn';
    el.textContent = '등록된 키가 없습니다.';
  }
}

function result(text, kind = '') {
  const el = $('result');
  el.hidden = false;
  el.className = `notice ${kind}`;
  el.textContent = text;
}

async function ping(key, model) {
  const res = await fetch(`${API}/interactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ model, input: '안녕' }),
  });
  if (res.ok) return;
  const data = await res.json().catch(() => ({}));
  const err = new Error(data.error?.message || `HTTP ${res.status}`);
  err.status = res.status;
  throw err;
}

async function testKey() {
  const key = $('key').value.trim() || readStored().settings.key;
  if (!key) { result('키를 입력해 주세요.', 'warn'); return 'fail'; }
  const models = { ...MODEL_DEFAULTS, ...readStored().settings };
  result('확인 중…');
  try {
    await ping(key, models.fallbackModel);
  } catch (e) {
    const keyErr = e.status === 401 || /API key|API_KEY/i.test(e.message);
    result(keyErr ? '✖ API 키를 확인해 주세요.' : `✖ ${e.message}`, 'err');
    return 'fail';
  }
  try {
    await ping(key, models.minutesModel);
    result(`✔ 연결됨 · ${models.minutesModel} 사용 가능`);
    return 'ok';
  } catch (e) {
    result(`✔ 연결됨 · ${models.minutesModel} 사용 불가 (결제 등록 키 필요) → 회의록은 ${models.fallbackModel}로 만듭니다.`, 'warn');
    return 'fallback';
  }
}

async function saveKey() {
  const key = $('key').value.trim();
  if (!key) return result('키를 입력해 주세요.', 'warn');
  const { settings } = readStored();
  const check = await testKey();
  if (check === 'fail') return;
  const next = { ...settings, key };
  if (check === 'fallback') next.minutesModel = next.fallbackModel || MODEL_DEFAULTS.fallbackModel;
  if (!writeStored(next, $('persist').checked)) return result('이 브라우저에서 저장소를 쓸 수 없습니다 (시크릿 창 · 사이트 데이터 차단 확인).', 'err');
  $('key').value = '';
  showStatus();
  $('result').textContent += ' — 등록했습니다. 회의록 도우미로 돌아가 바로 쓰면 됩니다.';
}

function deleteKey() {
  const { settings, persist } = readStored();
  delete settings.key;
  writeStored(settings, persist);
  showStatus();
  result('등록된 키를 삭제했습니다.');
}

$('btnTest').onclick = testKey;
$('btnSave').onclick = saveKey;
$('btnDelete').onclick = deleteKey;
$('persist').checked = readStored().settings.key ? readStored().persist : true;
showStatus();
