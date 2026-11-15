// 앱 화면 로직: 공유 수신 → 인식 → 확인/수정 → 직렬/일괄 계산 → 기록.
import { CalcSession } from './session.js';
import { formatValue } from './format.js';
import { recognize, mockRecognize, checkLines, RecognitionError } from './recognizer.js';
import { normalizeSettings, DEFAULTS } from './settings.js';
import { prepareImage, readClipboardImage } from './imageutil.js';
import * as store from './storage.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

// ---------- 상태 ----------
const state = {
  settings: loadSettings(),
  session: null,
  lines: [],
  cursor: 0,
  image: null,
  imageUrl: null,
  historyId: null,
  userVars: [], // {name, expr}
  carry: new Map(), // 환경 유지: 이전 세션의 변수
  unreadable: [],
  editingUid: null,
  uid: 1,
  busy: false,
};
window.__cc = { state }; // 디버깅과 자동 테스트용

function loadSettings() {
  try { return normalizeSettings(JSON.parse(localStorage.getItem('cc.settings') || '{}')); } catch { return { ...DEFAULTS }; }
}
function saveSettings() {
  localStorage.setItem('cc.settings', JSON.stringify(state.settings));
}

// ---------- 공통 UI ----------
let toastTimer;
function toast(msg, ms = 4000) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function setStatus(msg = '', busy = false) {
  const s = $('#status');
  s.textContent = msg;
  s.classList.toggle('busy', busy);
}

function showTab(name) {
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('.tab').forEach((t) => { t.hidden = t.id !== `tab-${name}`; });
  $('#actionbar').hidden = name !== 'calc';
  if (name === 'history') renderHistory();
  if (name === 'settings') fillSettingsForm();
}

// ---------- 세션/계산 ----------
function newSession() {
  const s = new CalcSession({ angleMode: state.settings.angleMode, digits: state.settings.digits, eng: state.settings.eng });
  if (state.settings.keepEnv) for (const [k, v] of state.carry) s.env.set(k, v);
  for (const uv of state.userVars) s.runStatement(`${uv.name} = ${uv.expr}`);
  return s;
}

const isRunnable = (l) => l.checked && l.kind !== 'text' && l.calc.trim() !== '';

function markStaleAfter(i) {
  state.lines.forEach((l, k) => { if (k > i && l.parts) l.stale = true; });
}

function clearResults() {
  state.lines.forEach((l) => { l.parts = null; l.ran = false; l.stale = false; l.angle = null; });
  state.session = newSession();
  state.cursor = firstRunnable(0);
}
function firstRunnable(from) {
  for (let i = from; i < state.lines.length; i++) if (isRunnable(state.lines[i])) return i;
  return state.lines.length;
}

function applyResult(line, res) {
  line.parts = res.parts;
  line.ok = res.ok;
  line.ran = true;
  line.stale = false;
  line.angle = state.session.angleMode;
}

function runLineAt(i) {
  const line = state.lines[i];
  const needReplay = state.lines.some((l, k) => k > i && l.ran);
  if (needReplay || !state.session) {
    state.session = newSession();
    for (let k = 0; k < i; k++) {
      const p = state.lines[k];
      if (p.ran && p.ok && isRunnable(p)) state.session.runLine(k + 1, p.calc);
    }
    markStaleAfter(i);
  }
  state.session.setAngleMode(state.settings.angleMode);
  applyResult(line, state.session.runLine(i + 1, line.calc));
  state.cursor = firstRunnable(i + 1);
}

function runOne() {
  const i = firstRunnable(state.cursor);
  if (i >= state.lines.length) { toast('실행할 줄이 더 없습니다'); return false; }
  runLineAt(i);
  afterRun();
  return state.lines[i].ok;
}
function runRest() {
  let i = firstRunnable(state.cursor);
  if (i >= state.lines.length) { toast('실행할 줄이 더 없습니다'); return; }
  while (i < state.lines.length) {
    runLineAt(i);
    if (!state.lines[i].ok) break;
    i = firstRunnable(i + 1);
  }
  afterRun();
}
function skipOne() {
  state.cursor = firstRunnable(firstRunnable(state.cursor) + 1);
  renderLines();
}

function runBatch() {
  const targets = state.lines.map((l, i) => ({ l, i })).filter((x) => isRunnable(x.l));
  if (!targets.length) { toast('실행할 줄이 없습니다 (체크 확인)'); return; }
  state.lines.forEach((l) => { l.parts = null; l.ran = false; l.stale = false; });
  state.session = newSession();
  const out = state.session.runBatch(targets.map((x) => ({ no: x.i + 1, text: x.l.calc })));
  out.forEach((res, k) => applyResult(targets[k].l, res));
  afterRun();
}

function afterRun() {
  if (state.settings.keepEnv && state.session) state.carry = new Map(state.session.env);
  renderLines();
  renderVars();
  persistSession();
}

// ---------- 기록 저장 ----------
const serializeLines = () => state.lines.map((l) => ({
  latex: l.latex, calc: l.calc, kind: l.kind, confidence: l.confidence, note: l.note, checked: l.checked,
}));
let persistChain = Promise.resolve();
function persistSession() {
  if (!state.lines.length) return;
  persistChain = persistChain.then(async () => {
    try {
      if (state.historyId != null) {
        await store.updateSession(state.historyId, { lines: serializeLines(), mode: state.settings.mode, angleMode: state.settings.angleMode });
      } else {
        state.historyId = await store.saveSession({
          image: state.image, lines: serializeLines(), mode: state.settings.mode, angleMode: state.settings.angleMode,
        });
      }
    } catch (e) { console.warn('기록 저장 실패', e); }
  });
}

// ---------- 줄 모델 ----------
function makeLine(src) {
  return {
    uid: state.uid++,
    latex: src.latex ?? '',
    calc: src.calc ?? '',
    kind: src.kind ?? 'expr',
    confidence: src.confidence ?? 1,
    note: src.note ?? '',
    syntaxError: src.syntaxError ?? null,
    checked: src.checked ?? src.kind !== 'text',
    parts: null, ok: null, ran: false, stale: false, angle: null,
  };
}

function setLines(list, { keepVars = false } = {}) {
  state.lines = list.map(makeLine);
  checkLines(state.lines);
  if (!keepVars && !state.settings.keepEnv) state.carry = new Map();
  state.editingUid = null;
  state.session = newSession();
  state.cursor = firstRunnable(0);
  renderAll();
}

// ---------- 렌더링 ----------
function renderAll() {
  const s = state.settings;
  $$('#seg-mode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === s.mode)));
  $$('#seg-angle button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.angle === s.angleMode)));
  $$('#seg-fmt button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.fmt === s.outFmt)));
  $('#chk-eng').checked = s.eng;
  $('#chk-keep').checked = s.keepEnv;
  $('#act-step').hidden = s.mode !== 'step';
  $('#act-batch').hidden = s.mode !== 'batch';
  renderLines();
  renderVars();
  renderImage();
}

function renderImage() {
  const panel = $('#image-panel');
  panel.hidden = !state.imageUrl;
  if (state.imageUrl) $('#img-preview').src = state.imageUrl;
  const un = $('#unreadable');
  un.hidden = state.unreadable.length === 0;
  un.textContent = state.unreadable.length ? `읽지 못한 부분: ${state.unreadable.join(' / ')}` : '';
}

function renderMath(el, line) {
  el.textContent = '';
  if (line.latex && window.katex) {
    try {
      window.katex.render(line.latex, el, { throwOnError: true, displayMode: false });
      return;
    } catch { /* 아래 원문 표시로 대체 */ }
  }
  el.append(h('span', { class: 'raw', text: line.calc || '(빈 줄)' }));
}

function renderLines() {
  const ol = $('#lines');
  ol.textContent = '';
  $('#empty').hidden = state.lines.length > 0;
  const step = state.settings.mode === 'step';
  const cur = firstRunnable(state.cursor);
  state.lines.forEach((line, i) => {
    const cls = ['line'];
    if (line.confidence < 0.7 || line.syntaxError) cls.push('low');
    if (line.parts) cls.push(line.ok ? 'ok' : 'err');
    if (step && i === cur) cls.push('current');
    if (!line.checked || line.kind === 'text') cls.push('skip');
    const li = h('li', { class: cls.join(' '), 'data-uid': line.uid });

    const chk = h('input', { type: 'checkbox', class: 'chk', 'aria-label': `${i + 1}번 줄 실행 대상`, onchange: (e) => { line.checked = e.target.checked; if (step) state.cursor = firstRunnable(state.cursor); renderLines(); persistSession(); } });
    chk.checked = line.checked;
    li.append(chk, h('span', { class: 'no', text: String(i + 1) }));

    const body = h('div', { class: 'body' });
    if (state.editingUid === line.uid) {
      const inp = h('input', { class: 'edit', value: line.calc, spellcheck: 'false', 'aria-label': `${i + 1}번 줄 계산식` });
      inp.value = line.calc;
      const commit = (save) => {
        if (state.editingUid !== line.uid) return;
        state.editingUid = null;
        if (save && inp.value !== line.calc) {
          line.calc = inp.value;
          line.latex = '';
          line.kind = line.kind === 'text' ? 'expr' : line.kind;
          line.confidence = 1;
          line.note = '';
          checkLines([line]);
          line.parts = null; line.ran = false; line.ok = null;
          if (state.settings.mode === 'step') { markStaleAfter(i); state.cursor = Math.min(state.cursor, i); }
          persistSession();
        }
        renderLines();
      };
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(true); }
        if (e.key === 'Escape') { e.preventDefault(); commit(false); }
      });
      inp.addEventListener('blur', () => commit(true));
      body.append(inp);
      setTimeout(() => { inp.focus(); inp.select(); }, 0);
    } else {
      const math = h('div', { class: 'math', title: '눌러서 수정', tabindex: '0', role: 'button', 'aria-label': `${i + 1}번 줄 수정`,
        onclick: () => { state.editingUid = line.uid; renderLines(); },
        onkeydown: (e) => { if (e.key === 'Enter') { state.editingUid = line.uid; renderLines(); } } });
      renderMath(math, line);
      body.append(math);
      if (line.latex && line.calc) body.append(h('div', { class: 'raw', text: line.calc }));
    }

    const meta = h('div', { class: 'meta' });
    if (line.confidence < 0.7) meta.append(h('span', { class: 'tag warn', text: `확인 필요 · 신뢰도 ${Math.round(line.confidence * 100)}%` }));
    if (line.note) meta.append(h('span', { class: 'tag warn', text: line.note }));
    if (line.syntaxError) meta.append(h('span', { class: 'tag err', text: `문법: ${line.syntaxError}` }));
    if (line.kind === 'text') meta.append(h('span', { class: 'tag', text: '설명(계산 제외)' }));
    if (meta.childNodes.length) body.append(meta);

    if (line.parts) body.append(...resultNodes(line));
    li.append(body);

    const tools = h('div', { class: 'tools' });
    if (step) tools.append(h('button', { class: 'btn small', title: '이 줄 실행', 'aria-label': `${i + 1}번 줄 실행`, onclick: () => { if (!isRunnable(line)) { line.checked = true; } runLineAt(i); afterRun(); }, text: '▶' }));
    tools.append(
      h('button', { class: 'btn small ghost', title: '위로', 'aria-label': '위로', disabled: i === 0, onclick: () => moveLine(i, -1), text: '↑' }),
      h('button', { class: 'btn small ghost', title: '아래로', 'aria-label': '아래로', disabled: i === state.lines.length - 1, onclick: () => moveLine(i, 1), text: '↓' }),
      h('button', { class: 'btn small ghost danger', title: '삭제', 'aria-label': '삭제', onclick: () => deleteLine(i), text: '✕' }),
    );
    li.append(tools);
    ol.append(li);
  });
}

function moveLine(i, d) {
  const j = i + d;
  if (j < 0 || j >= state.lines.length) return;
  [state.lines[i], state.lines[j]] = [state.lines[j], state.lines[i]];
  invalidateAll();
}
function deleteLine(i) {
  state.lines.splice(i, 1);
  invalidateAll();
}
function invalidateAll() {
  // 줄 번호(#n)와 대입 순서가 바뀌므로 결과를 모두 무효화
  state.lines.forEach((l) => { l.parts = null; l.ran = false; l.ok = null; l.stale = false; });
  state.session = newSession();
  state.cursor = firstRunnable(0);
  renderLines();
  persistSession();
}

// ----- 결과 표시 -----
function fmtOpts(angleMode) { return { digits: state.settings.digits, eng: state.settings.eng, angleMode }; }

function copyBtn(text) {
  return h('button', { class: 'btn small ghost copy', title: '복사', 'aria-label': '결과 복사', onclick: async () => {
    try { await navigator.clipboard.writeText(text); toast('복사했습니다', 1500); } catch { toast('복사하지 못했습니다'); }
  }, text: '복사' });
}

function valueNodes(v, angleMode, name) {
  const d = formatValue(v, fmtOpts(angleMode));
  const fmt = state.settings.outFmt;
  const label = name ? h('span', { class: 'name', text: `${name} =` }) : null;
  if (d.type === 'matrix') {
    const tbl = h('table', { class: 'mat' }, ...d.rows.map((r) => h('tr', {}, ...r.map((c) => h('td', { text: c })))));
    return [h('div', { class: 'rv' }, label, tbl, copyBtn(d.text))];
  }
  const vals = [];
  let copy;
  if (d.isReal) { vals.push(h('span', { class: 'val', text: d.rect })); copy = d.rect; }
  else if (fmt === 'rect') { vals.push(h('span', { class: 'val', text: d.rect })); copy = d.rect; }
  else if (fmt === 'polar') { vals.push(h('span', { class: 'val', text: d.polar })); copy = d.polar; }
  else { vals.push(h('span', { class: 'val' }, h('small', { text: '직교' }), d.rect), h('span', { class: 'val' }, h('small', { text: '극' }), d.polar)); copy = d.rect; }
  return [h('div', { class: 'rv' }, label, ...vals, copyBtn(copy))];
}

function resultNodes(line) {
  const out = [];
  const stale = line.stale || (line.angle && line.angle !== state.settings.angleMode);
  for (const p of line.parts) {
    if (!p.ok) {
      const box = h('div', { class: 'errmsg' }, h('span', { text: p.error }));
      if (p.varName) box.append(h('button', { class: 'btn small', onclick: () => openVars(p.varName), text: `${p.varName} 값 입력` }));
      out.push(box);
      continue;
    }
    const res = h('div', { class: `result${stale ? ' stale' : ''}` });
    if (p.kind === 'expr') res.append(...valueNodes(p.value, line.angle));
    else if (p.kind === 'assign') res.append(...valueNodes(p.value, line.angle, p.name));
    else if (p.kind === 'check') res.append(h('div', { class: 'rv' }, h('span', { class: 'val', text: p.display.text })));
    else if (p.kind === 'equation' || p.kind === 'solve') {
      p.solutions.forEach((sol, k) => {
        const row = h('div', { class: 'sol' });
        if (p.solutions.length > 1) row.append(h('div', { class: 'sub', text: `해 ${k + 1}` }));
        sol.forEach((x) => row.append(...valueNodes(x.value, line.angle, x.name)));
        res.append(row);
      });
      const meta = [];
      if (p.system && p.system.equations > 1) meta.push(`연립 ${p.system.equations}개 식, 미지수 ${p.system.unknowns.join(', ')}`);
      if (p.method === 'newton') meta.push('수치 해법(뉴턴)');
      meta.push(...(p.warnings ?? []));
      if (meta.length) res.append(h('div', { class: 'sub', text: meta.join(' · ') }));
    }
    if (p.notes && p.notes.length) res.append(h('div', { class: 'sub', text: `해석: ${p.notes.join(' / ')}` }));
    if (stale) res.append(h('div', { class: 'sub', text: '이전 설정/수정 이후의 값입니다. 다시 실행하세요' }));
    out.push(res);
  }
  return out;
}

// ---------- 변수 서랍 ----------
function renderVars() {
  const ul = $('#vars-list');
  ul.textContent = '';
  const env = state.session ? state.session.env : new Map();
  $('#var-count').textContent = String(env.size);
  const userNames = new Set(state.userVars.map((u) => u.name));
  for (const [name, v] of env) {
    const d = formatValue(v, fmtOpts(state.settings.angleMode));
    const li = h('li', {}, h('span', { class: 'vn', text: name }), h('span', { class: 'vv', text: d.type === 'matrix' ? d.text : (d.isReal ? d.rect : `${d.rect}  (${d.polar})`) }));
    if (userNames.has(name)) {
      li.append(h('button', { class: 'btn small ghost danger', 'aria-label': `${name} 삭제`, onclick: () => { state.userVars = state.userVars.filter((u) => u.name !== name); invalidateAll(); renderVars(); }, text: '삭제' }));
    }
    ul.append(li);
  }
  if (!env.size) ul.append(h('li', {}, h('span', { class: 'vv', text: '변수가 없습니다. 줄에서 대입하거나 아래에서 추가하세요.' })));
}
function openVars(prefill) {
  $('#vars-drawer').hidden = false;
  renderVars();
  if (prefill) { $('#vars-form [name=vname]').value = prefill; $('#vars-form [name=vexpr]').focus(); }
}

// ---------- 인식 흐름 ----------
async function startRecognition(blob) {
  if (state.busy) { toast('이미 인식 중입니다'); return; }
  state.busy = true;
  showTab('calc');
  try {
    setStatus('이미지 준비 중…', true);
    const prep = await prepareImage(blob);
    if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
    state.image = prep.blob;
    state.imageUrl = URL.createObjectURL(prep.blob);
    state.historyId = null;
    state.unreadable = [];
    renderImage();

    const s = state.settings;
    let result;
    if (s.provider === 'mock') {
      setStatus('데모 인식 중…', true);
      await new Promise((r) => setTimeout(r, 250));
      result = mockRecognize();
    } else {
      if (!s.apiKey) { showTab('settings'); toast('먼저 설정에서 API 키를 입력하세요 (또는 인식 방식을 데모로 바꾸세요)'); setStatus(''); return; }
      setStatus('손글씨를 읽는 중…', true);
      result = await recognize({ imageBase64: prep.base64, mediaType: prep.mediaType, apiKey: s.apiKey, model: s.model, timeoutMs: s.timeoutSec * 1000 });
    }
    state.unreadable = result.unreadable;
    setLines(result.lines);
    setStatus(`${result.lines.length}줄을 인식했습니다. 틀린 곳은 눌러서 고친 뒤 실행하세요`);
    persistSession();
    if (s.autoRun) { if (s.mode === 'batch') runBatch(); else runRest(); }
  } catch (e) {
    console.error(e);
    setStatus('');
    if (e instanceof RecognitionError && e.code === 'no-key') showTab('settings');
    toast(e.message || String(e), 7000);
  } finally {
    state.busy = false;
  }
}

async function takeSharedImage() {
  const params = new URLSearchParams(location.search);
  const flag = params.get('shared');
  if (!flag) return;
  history.replaceState(null, '', location.pathname);
  if (flag === 'error') { toast('공유된 이미지를 받지 못했습니다. 다시 시도하세요'); return; }
  try {
    const cache = await caches.open('cc-shared');
    const res = await cache.match('./shared-image');
    if (!res) { toast('공유된 이미지를 찾지 못했습니다'); return; }
    const blob = await res.blob();
    await cache.delete('./shared-image');
    await startRecognition(blob);
  } catch (e) { toast(`공유 처리 실패: ${e.message}`); }
}

// ---------- 기록 화면 ----------
let historyUrls = [];
async function renderHistory() {
  historyUrls.forEach((u) => URL.revokeObjectURL(u));
  historyUrls = [];
  const ul = $('#history-list');
  ul.textContent = '';
  let list = [];
  try { list = await store.listSessions(); } catch (e) { toast('기록을 불러오지 못했습니다'); }
  $('#history-empty').hidden = list.length > 0;
  for (const rec of list) {
    let thumb;
    if (rec.image) { const u = URL.createObjectURL(rec.image); historyUrls.push(u); thumb = h('img', { src: u, alt: '' }); }
    else thumb = h('div', { class: 'noimg', text: '직접 입력' });
    const first = rec.lines?.find((l) => l.calc)?.calc ?? '';
    const li = h('li', { 'data-id': rec.id },
      thumb,
      h('div', {}, h('div', { class: 't', text: `${new Date(rec.createdAt).toLocaleString('ko-KR')} · ${rec.lines?.length ?? 0}줄` }), h('div', { class: 'f', text: first })),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => openHistory(rec), text: '열기' }),
        h('button', { class: 'btn small ghost danger', onclick: async () => { await store.deleteSession(rec.id); renderHistory(); }, text: '삭제' })));
    ul.append(li);
  }
}
function openHistory(rec) {
  if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
  state.image = rec.image ?? null;
  state.imageUrl = rec.image ? URL.createObjectURL(rec.image) : null;
  state.historyId = rec.id;
  state.unreadable = [];
  state.settings.mode = rec.mode ?? state.settings.mode;
  state.settings.angleMode = rec.angleMode ?? state.settings.angleMode;
  saveSettings();
  setLines(rec.lines ?? []);
  showTab('calc');
  setStatus('기록에서 불러왔습니다. 다시 실행하세요');
}

// ---------- 설정 화면 ----------
function fillSettingsForm() {
  const f = $('#settings-form');
  for (const [k, v] of Object.entries(state.settings)) {
    const el = f.elements[k];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  }
}
function readSettingsForm() {
  const f = $('#settings-form');
  const raw = { ...state.settings };
  for (const el of f.elements) {
    if (!el.name) continue;
    raw[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return normalizeSettings(raw);
}

// ---------- 필기 입력 ----------
function setupDrawing() {
  const dlg = $('#dlg-draw');
  const cv = $('#draw-canvas');
  const ctx = cv.getContext('2d');
  let strokes = [];
  let cur = null;
  const redraw = () => {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.strokeStyle = '#111';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of strokes) {
      for (let i = 1; i < s.length; i++) {
        ctx.lineWidth = s[i].w;
        ctx.beginPath();
        ctx.moveTo(s[i - 1].x, s[i - 1].y);
        ctx.lineTo(s[i].x, s[i].y);
        ctx.stroke();
      }
      if (s.length === 1) { ctx.beginPath(); ctx.arc(s[0].x, s[0].y, s[0].w / 2, 0, Math.PI * 2); ctx.fillStyle = '#111'; ctx.fill(); }
    }
  };
  const pt = (e) => {
    const r = cv.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * cv.width) / r.width, y: ((e.clientY - r.top) * cv.height) / r.height, w: 2.5 + (e.pressure && e.pointerType === 'pen' ? e.pressure * 3 : 1.2) };
  };
  cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); cur = [pt(e)]; strokes.push(cur); redraw(); e.preventDefault(); });
  cv.addEventListener('pointermove', (e) => { if (!cur) return; cur.push(pt(e)); redraw(); e.preventDefault(); });
  const end = () => { cur = null; };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  $('#btn-draw').addEventListener('click', () => { strokes = []; redraw(); dlg.showModal(); });
  $('#draw-undo').addEventListener('click', () => { strokes.pop(); redraw(); });
  $('#draw-clear').addEventListener('click', () => { strokes = []; redraw(); });
  $('#draw-cancel').addEventListener('click', () => dlg.close());
  $('#draw-ok').addEventListener('click', () => {
    if (!strokes.length) { toast('먼저 수식을 쓰세요'); return; }
    cv.toBlob((blob) => { dlg.close(); startRecognition(blob); }, 'image/png');
  });
}

// ---------- 이벤트 연결 ----------
function bind() {
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  $$('#seg-mode button').forEach((b) => b.addEventListener('click', () => {
    state.settings.mode = b.dataset.mode; saveSettings();
    clearResults(); renderAll();
  }));
  $$('#seg-angle button').forEach((b) => b.addEventListener('click', () => {
    state.settings.angleMode = b.dataset.angle; saveSettings();
    if (state.session) state.session.setAngleMode(b.dataset.angle);
    renderAll();
  }));
  $$('#seg-fmt button').forEach((b) => b.addEventListener('click', () => { state.settings.outFmt = b.dataset.fmt; saveSettings(); renderAll(); }));
  $('#chk-eng').addEventListener('change', (e) => { state.settings.eng = e.target.checked; saveSettings(); renderAll(); });
  $('#chk-keep').addEventListener('change', (e) => {
    state.settings.keepEnv = e.target.checked; saveSettings();
    if (!e.target.checked) state.carry = new Map(); else if (state.session) state.carry = new Map(state.session.env);
  });
  $('#btn-vars').addEventListener('click', () => openVars());
  $('#btn-vars-close').addEventListener('click', () => { $('#vars-drawer').hidden = true; });
  $('#vars-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const name = f.vname.value.trim();
    const expr = f.vexpr.value.trim();
    const probe = new CalcSession({ angleMode: state.settings.angleMode });
    const r = probe.runStatement(`${name} = ${expr}`);
    if (!r.ok) { $('#vars-msg').textContent = r.error; return; }
    if (r.kind !== 'assign') { $('#vars-msg').textContent = '이름 = 값 형태의 대입이어야 합니다'; return; }
    state.userVars = state.userVars.filter((u) => u.name !== r.name);
    state.userVars.push({ name: r.name, expr });
    f.reset();
    $('#vars-msg').textContent = `${r.name} 을(를) 추가했습니다. 결과를 다시 실행하세요`;
    invalidateAll();
    renderVars();
  });

  $('#btn-pick').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) startRecognition(f); });
  $('#btn-paste').addEventListener('click', async () => {
    try { startRecognition(await readClipboardImage()); } catch (e) { toast(e.message); }
  });
  document.addEventListener('paste', (e) => {
    if (e.target.closest?.('input, textarea')) return;
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
    if (item) { e.preventDefault(); startRecognition(item.getAsFile()); }
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = [...(e.dataTransfer?.files ?? [])].find((x) => x.type.startsWith('image/'));
    if (f) startRecognition(f);
  });

  $('#btn-text').addEventListener('click', () => $('#dlg-text').showModal());
  $('#dlg-text').addEventListener('close', () => {
    const d = $('#dlg-text');
    if (d.returnValue !== 'ok') return;
    const texts = $('#text-input').value.split('\n').map((t) => t.trim()).filter(Boolean);
    $('#text-input').value = '';
    if (!texts.length) return;
    if (state.imageUrl) { URL.revokeObjectURL(state.imageUrl); state.imageUrl = null; state.image = null; }
    state.historyId = null; state.unreadable = [];
    setLines(texts.map((calc) => ({ calc, kind: 'expr', confidence: 1 })));
    setStatus(`${texts.length}줄을 입력했습니다`);
  });
  $('#btn-add').addEventListener('click', () => {
    const l = makeLine({ calc: '', kind: 'expr', confidence: 1 });
    state.lines.push(l);
    state.editingUid = l.uid;
    renderLines();
  });
  $('#btn-demo').addEventListener('click', () => {
    const m = mockRecognize();
    state.unreadable = [];
    setLines(m.lines);
    setStatus('데모 예제를 불러왔습니다');
  });

  $('#btn-run-one').addEventListener('click', () => runOne());
  $('#btn-skip').addEventListener('click', () => skipOne());
  $('#btn-run-rest').addEventListener('click', () => runRest());
  $('#btn-reset-step').addEventListener('click', () => { clearResults(); renderLines(); renderVars(); });
  $('#btn-run-batch').addEventListener('click', () => runBatch());
  $('#btn-reset-batch').addEventListener('click', () => { clearResults(); renderLines(); renderVars(); });

  const form = $('#settings-form');
  form.addEventListener('input', () => {
    const prev = state.settings;
    state.settings = readSettingsForm();
    saveSettings();
    $('#settings-saved').textContent = '저장되었습니다';
    if (prev.digits !== state.settings.digits) renderAll();
  });
  form.addEventListener('submit', (e) => e.preventDefault());
  $('#btn-clear-history').addEventListener('click', async () => {
    if (!confirm('기록을 모두 삭제할까요?')) return;
    await store.clearAll();
    renderHistory();
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      if (state.settings.mode === 'batch') runBatch(); else runOne();
    }
  });
  setupDrawing();
}

// ---------- 시작 ----------
async function init() {
  bind();
  renderAll();
  showTab('calc');
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('./sw.js'); } catch (e) { console.warn('서비스 워커 등록 실패', e); }
  }
  try { await store.purgeOlderThan(state.settings.retentionDays); } catch { /* 저장소 사용 불가 시 무시 */ }
  await takeSharedImage();
}
init();
