/* ══════════════════════════════════════════════════════
   레시피 노트 · Recipe Notebook
   - 비밀번호(4자리) → PBKDF2 → AES-GCM 복호화
   - 카드: 검색 · 카테고리 인덱스 · 넘기기 · 원본 사진
   - 새 카드/수정: 이 브라우저(localStorage)에 암호화해 저장
   ══════════════════════════════════════════════════════ */
'use strict';

const CATS = [
  { name: '스프레드·소스', color: 'var(--terra)' },
  { name: '디저트',        color: 'var(--rose)'  },
  { name: '음료',          color: 'var(--sage)'  },
  { name: '베이킹',        color: 'var(--ochre)' },
  { name: '기타',          color: 'var(--plum)'  }
];
const PIN_LEN = 4;
const LS_LOCAL = 'rn.local.v1';
const LS_OVR   = 'rn.ovr.v1';
const SS_KEY   = 'rn.key.v1';

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

const B64 = {
  enc(buf) {
    const bytes = new Uint8Array(buf);
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return btoa(out);
  },
  dec(str) {
    const bin = atob(str);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
};

const state = {
  ready: false,           // 암호문 로드 완료
  key: null,              // CryptoKey
  data: null,             // { cards: [...] } 복호화 결과
  locals: [],             // 이 브라우저에서 만든 카드
  overrides: {},          // 내장 카드 수정본
  cats: [],               // 실제 표시할 카테고리
  cat: '전체',
  q: '',
  list: [],               // 현재 필터된 카드
  idx: 0,
  pins: [],
  busy: false,
  editingId: null,
  pendingPhoto: null
};

/* ────────── 암호 ────────── */
let bundle = null;                        // data/recipes-enc.json
let textEnc = new TextEncoder();
let textDec = new TextDecoder();

async function deriveKey(pin, saltBytes, iterations) {
  const base = await crypto.subtle.importKey('raw', textEnc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
  );
}
async function decJSON(key, ivB64, ctB64) {
  const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: B64.dec(ivB64) }, key, B64.dec(ctB64));
  return JSON.parse(textDec.decode(buf));
}
async function encJSON(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const buf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, textEnc.encode(JSON.stringify(obj)));
  return { iv: B64.enc(iv), ct: B64.enc(buf) };
}

/* ────────── 저장소 ────────── */
async function readVault(name) {
  const raw = localStorage.getItem(name);
  if (!raw) return null;
  try { return await decJSON(state.key, JSON.parse(raw).iv, JSON.parse(raw).ct); }
  catch (e) { return null; }
}
async function writeVault(name, value) {
  const blob = await encJSON(state.key, value);
  localStorage.setItem(name, JSON.stringify(blob));
}

/* ────────── 데이터 ────────── */
function mergedCards() {
  const out = [];
  const seen = new Set();
  (state.data.cards || []).forEach((c, i) => {
    const ov = state.overrides[c.id];
    if (ov && ov.__deleted) return;
    const card = ov ? { ...c, ...ov, builtin: true } : { ...c, builtin: true };
    card.__order = i;
    out.push(card);
    seen.add(c.id);
  });
  state.locals.filter(c => !seen.has(c.id)).forEach((c, i) => {
    out.push({ ...c, builtin: false, __order: 1000 + i });
  });
  return out;
}

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, '');
function hay(c) {
  const parts = [c.title, c.subtitle, c.category, c.memo, (c.tags || []).join(' ')];
  (c.steps || []).forEach(s => {
    parts.push(s.text, s.note);
    (s.memos || []).forEach(m => parts.push(m.k, m.v));
  });
  return norm(parts.join(' '));
}

function currentCats(all) {
  const names = CATS.map(c => c.name);
  all.forEach(c => { if (c.category && !names.includes(c.category)) names.push(c.category); });
  return names.map(n => ({
    name: n,
    color: (CATS.find(c => c.name === n) || {}).color || 'var(--plum)',
    count: all.filter(c => c.category === n).length
  }));
}

function refilter(keepId) {
  const all = mergedCards();
  state.all = all;
  state.cats = currentCats(all);
  const q = norm(state.q);
  const tokens = state.q.trim().split(/\s+/).filter(Boolean).map(norm);
  let list = all.filter(c => state.cat === '전체' || c.category === state.cat);
  if (tokens.length) {
    list = list.filter(c => { const h = hay(c); return tokens.every(t => h.includes(t)); });
  }
  state.list = list;
  const keep = keepId || (state.list[state.idx] || {}).id;
  const found = keep ? list.findIndex(c => c.id === keep) : -1;
  state.idx = found >= 0 ? found : 0;
  if (q !== '' && state.idx > 0 && found < 0) state.idx = 0;
}

/* ────────── 잠금 화면 ────────── */
function showLock() {
  $('#app').hidden = true;
  $('#lock').hidden = false;
  state.pins = [];
  paintPins();
  $('#lockMsg').textContent = '';
  $('#lockMsg').classList.remove('busy');
}
function showApp() {
  $('#lock').hidden = true;
  $('#app').hidden = false;
}
function paintPins() {
  $$('#pins .pin').forEach((p, i) => p.classList.toggle('on', i < state.pins.length));
}
function pressKey(k) {
  if (state.busy) return;
  if (!state.ready) { flashMsg('노트를 준비하는 중이에요…'); return; }
  if (k === 'del') { state.pins.pop(); paintPins(); return; }
  if (k === 'clear') { state.pins = []; paintPins(); return; }
  if (state.pins.length >= PIN_LEN) return;
  state.pins.push(k);
  paintPins();
  if (state.pins.length === PIN_LEN) setTimeout(() => submitPin(), 140);
}
function flashMsg(msg, busy) {
  const el = $('#lockMsg');
  el.textContent = msg;
  el.classList.toggle('busy', !!busy);
}
async function submitPin() {
  if (state.busy) return;
  const pin = state.pins.join('');
  state.busy = true;
  flashMsg('노트를 여는 중…', true);
  await new Promise(r => setTimeout(r, 60));
  try {
    const key = await deriveKey(pin, B64.dec(bundle.salt), bundle.iter);
    let parsed;
    try {
      parsed = await decJSON(key, bundle.iv, bundle.ct);
    } catch (e) {
      state.busy = false;
      state.pins = [];
      paintPins();
      const pins = $('#pins');
      pins.classList.remove('shake'); void pins.offsetWidth; pins.classList.add('shake');
      flashMsg('비밀번호가 맞지 않아요');
      return;
    }
    state.key = key;
    state.data = parsed;
    try { sessionStorage.setItem(SS_KEY, B64.enc(await crypto.subtle.exportKey('raw', key))); } catch (e) {}
    await loadLocal();
    state.busy = false;
    flashMsg('');
    enterApp();
  } catch (e) {
    state.busy = false;
    state.pins = [];
    paintPins();
    flashMsg('여는 중 문제가 생겼어요. 다시 한 번 눌러 주세요.');
  }
}
async function loadLocal() {
  state.locals = (await readVault(LS_LOCAL)) || [];
  state.overrides = (await readVault(LS_OVR)) || {};
  if (!Array.isArray(state.locals)) state.locals = [];
  if (!state.overrides || typeof state.overrides !== 'object') state.overrides = {};
}
function enterApp() {
  showApp();
  refilter();
  renderTabs(); renderToc(); renderAll();
}

/* ────────── 화면 그리기 ────────── */
function catColor(name) {
  const c = state.cats.find(x => x.name === name);
  return c ? c.color : 'var(--plum)';
}

function renderTabs() {
  const tabs = $('#tabs');
  const items = [{ name: '전체', color: 'var(--terra)', count: (state.all || []).length }, ...state.cats];
  tabs.innerHTML = items.map(t => `
    <button class="tab" role="tab" data-cat="${esc(t.name)}" style="--tabc:${t.color}"
      aria-selected="${state.cat === t.name}">
      <i></i>${esc(t.name)}<b>${t.count}</b>
    </button>`).join('');
}

function renderToc() {
  const groups = new Map();
  (state.all || []).forEach(c => {
    const k = c.category || '기타';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  });
  const order = state.cats.map(c => c.name);
  const activeId = (state.list[state.idx] || {}).id;
  let html = `<p class="toc-title">목차 · ${(state.all || []).length}장</p>`;
  if (!state.all || !state.all.length) html += `<p class="toc-empty">아직 카드가 없어요.</p>`;
  order.forEach(name => {
    const cards = groups.get(name);
    if (!cards || !cards.length) return;
    html += `<div class="toc-group" style="--tabc:${catColor(name)}">
      <h3><i></i>${esc(name)}</h3>
      ${cards.map(c => `<button class="toc-item" data-id="${esc(c.id)}" aria-current="${c.id === activeId}">
        <span>${esc(c.no || '·')}</span><span>${esc(c.title)}</span></button>`).join('')}
    </div>`;
  });
  $('#toc').innerHTML = html;
  $('#tocSheetList').innerHTML = html.replace('class="toc-title"', 'class="toc-title" style="display:none"');
}

function stepHTML(s, i) {
  const n = s.n || i + 1;
  const memos = (s.memos || []).filter(m => m && (m.k || m.v));
  return `<li class="step">
    <span class="step-n">${esc(n)}</span>
    <div class="step-main">
      <p class="step-text">${esc(s.text || '')}</p>
      ${memos.length ? `<div class="step-memos">${memos.map(m => `<span class="memo"><b>${esc(m.k || '')}</b>${esc(m.v || '')}</span>`).join('')}</div>` : ''}
    </div>
    <p class="step-note">${esc(s.note || '')}</p>
  </li>`;
}

function cardHTML(c) {
  const accent = catColor(c.category);
  return `
  <div class="index-box"><span>NO.</span>${esc(c.no || '—')}</div>
  <header class="card-head" style="--tabc:${accent}">
    <p class="cat" style="--tabc:${accent}"><i></i>${esc(c.category || '기타')}</p>
    <h2 class="card-title">${esc(c.title || '')}</h2>
    ${c.subtitle ? `<p class="card-sub">${esc(c.subtitle)}</p>` : ''}
  </header>
  <div class="dots" aria-hidden="true"></div>
  <div class="card-body">
    <ol class="steps">${(c.steps || []).map(stepHTML).join('') || '<li class="step"><span class="step-n">·</span><div class="step-main"><p class="step-text">아직 적힌 내용이 없어요.</p></div></li>'}</ol>
    ${c.memo ? `<p class="card-memo">${esc(c.memo)}</p>` : ''}
  </div>
  <div class="dots" aria-hidden="true"></div>
  <footer class="card-foot">
    ${c.photo ? `<button class="paper-btn" data-photo="${esc(c.id)}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5.5" width="17" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8.6" cy="10" r="1.5" fill="currentColor"/><path d="M5 17l5-5 4 3.6L17 12l2.5 2.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      원본 손글씨 보기</button>` : '<span></span>'}
    <div class="card-actions">
      <span class="mark">ring note</span>
      <button class="icon-mini" data-edit="${esc(c.id)}" aria-label="카드 고치기" title="카드 고치기">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l4-1 9.5-9.5a2.1 2.1 0 0 0-3-3L5 16l-1 4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
      </button>
    </div>
  </footer>`;
}

function renderCard(dir) {
  const card = $('#card');
  const c = state.list[state.idx];
  if (!c) {
    const found = state.q.trim();
    card.style.setProperty('--head-gap', '0px');
    card.innerHTML = `<div class="empty-card">
      <h3>${found ? '그 레시피는 아직 없어요' : '이 분류에는 카드가 없어요'}</h3>
      <p>${found ? `“${esc(found)}”로는 못 찾았어요.<br>다른 재료 이름으로 찾아보거나 새 카드로 적어 둘 수 있어요.` : '새 카드로 하나 적어 두면<br>여기 링에 끼워 둘게요.'}</p>
      <button class="paper-btn" data-new>+ 새 카드 만들기</button>
    </div>`;
    updateNav();
    return;
  }
  card.style.removeProperty('--head-gap');
  card.innerHTML = cardHTML(c);
  if (dir) {
    card.classList.remove('turn-l', 'turn-r');
    void card.offsetWidth;
    card.classList.add(dir === 'l' ? 'turn-l' : 'turn-r');
    setTimeout(() => card.classList.remove('turn-l', 'turn-r'), 300);
  }
  $('.card-body', card).scrollTop = 0;
  updateNav();
}

function updateNav() {
  const n = state.list.length;
  const i = n ? state.idx + 1 : 0;
  $('#prev').disabled = state.idx <= 0;
  $('#next').disabled = state.idx >= n - 1;
  $('#mbPrev').disabled = state.idx <= 0;
  $('#mbNext').disabled = state.idx >= n - 1;
  $('#mbCount').textContent = `${i} / ${n}`;
  updateActive();
}
function updateActive() {
  const id = (state.list[state.idx] || {}).id;
  $$('.toc-item').forEach(b => b.setAttribute('aria-current', String(b.dataset.id === id)));
}

function renderAll(dir) {
  renderTabs();
  renderToc();
  renderCard(dir);
}

/* ────────── 이동 ────────── */
function go(delta) {
  const n = state.list.length;
  if (!n) return;
  const next = Math.min(n - 1, Math.max(0, state.idx + delta));
  if (next === state.idx) return;
  state.idx = next;
  renderCard(delta > 0 ? 'r' : 'l');
  renderToc();
}
function goToId(id) {
  const i = state.list.findIndex(c => c.id === id);
  if (i < 0) return;
  const dir = i > state.idx ? 'r' : 'l';
  state.idx = i;
  renderCard(dir);
  renderToc();
  closeSheet();
}

/* ────────── 모달 & 시트 ────────── */
function openModal(id) { const m = $('#' + id); m.hidden = false; document.body.style.overflow = 'hidden'; }
function closeModal(id) { const m = $('#' + id); m.hidden = true; if (!$$('.modal:not([hidden])').length) document.body.style.overflow = ''; }
function closeSheet() { $('#tocSheet').hidden = true; document.body.style.overflow = ''; }

function openPhoto(id) {
  const c = (state.all || []).find(x => x.id === id);
  if (!c || !c.photo) return;
  $('#photoImg').src = c.photo;
  $('#photoImg').alt = `${c.title} 손글씨 원본`;
  $('#photoCap').textContent = c.photoLabel || `${c.title} · 손글씨 원본`;
  openModal('photoModal');
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('on'), 2200);
}

/* ────────── 편집 ────────── */
function openEditor(card) {
  state.editingId = card ? card.id : null;
  state.pendingPhoto = card ? (card.photo || null) : null;
  $('#editTitle').textContent = card ? '카드 고치기' : '새 카드';
  $('#editSub').textContent = card && card.builtin
    ? '고친 내용은 이 브라우저에만 저장돼요. 내장 카드는 JSON 내보내기로 백업할 수 있어요.'
    : '이 브라우저에만 저장돼요. 필요하면 목차에서 JSON으로 내보내세요.';
  $('#fTitle').value = card ? (card.title || '') : '';
  $('#fSub').value = card ? (card.subtitle || '') : '';
  $('#fMemo').value = card ? (card.memo || '') : '';
  $('#editError').textContent = '';

  const sel = $('#fCat');
  sel.innerHTML = state.cats.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
  sel.value = card && card.category ? card.category : state.cats[0].name;

  const rows = (card && card.steps && card.steps.length ? card.steps : [{ text: '', note: '' }]);
  const wrap = $('#stepsEdit');
  wrap.innerHTML = '';
  rows.forEach(s => addStepRow(s.text || '', s.note || ''));

  $('#photoClear').hidden = !state.pendingPhoto;
  renderPhotoPreview();
  $('#deleteCard').hidden = !card || card.builtin;
  openModal('editModal');
  setTimeout(() => $('#fTitle').focus(), 80);
}
function addStepRow(text, note) {
  const row = document.createElement('div');
  row.className = 'step-row';
  row.innerHTML = `<input class="s-text" placeholder="재료 · 공정" maxlength="120" value="${esc(text)}">
    <input class="s-note" placeholder="옆 메모 (온도·시간)" maxlength="60" value="${esc(note)}">
    <button type="button" class="rm" aria-label="이 줄 지우기">×</button>`;
  $('.rm', row).addEventListener('click', () => row.remove());
  $('#stepsEdit').appendChild(row);
}
function renderPhotoPreview() {
  const box = $('#photoPreview');
  if (!state.pendingPhoto) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = `<img alt="첨부한 사진 미리보기" src="${state.pendingPhoto}">`;
}
async function fileToPhoto(file) {
  const dataUrl = await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
  const img = await new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = dataUrl;
  });
  const max = 1280;
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(img.width * scale);
  cv.height = Math.round(img.height * scale);
  cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
  return cv.toDataURL('image/jpeg', 0.78);
}

async function saveEditor(e) {
  e.preventDefault();
  const title = $('#fTitle').value.trim();
  const err = $('#editError');
  if (!title) { err.textContent = '제목을 적어 주세요.'; $('#fTitle').focus(); return; }
  const steps = $$('#stepsEdit .step-row').map((row, i) => {
    const text = $('.s-text', row).value.trim();
    const note = $('.s-note', row).value.trim();
    const out = { n: i + 1, text };
    if (note) out.note = note;
    return out;
  }).filter(s => s.text || s.note);

  const base = state.editingId
    ? (state.all || []).find(x => x.id === state.editingId) || {}
    : {};
  const card = {
    id: state.editingId || `c-${Date.now().toString(36)}`,
    no: base.no || String((state.all || []).length + 1).padStart(2, '0'),
    title,
    subtitle: $('#fSub').value.trim(),
    category: $('#fCat').value,
    steps,
    memo: $('#fMemo').value.trim(),
    photo: state.pendingPhoto || '',
    photoLabel: state.pendingPhoto ? `${title} · 손글씨 원본` : '',
    date: new Date().toISOString().slice(0, 10)
  };
  if (base.tags) card.tags = base.tags;

  const btn = $('.primary-btn', $('#editForm'));
  btn.disabled = true;
  try {
    if (base.builtin) {
      state.overrides = { ...state.overrides, [card.id]: card };
      await writeVault(LS_OVR, state.overrides);
    } else {
      const i = state.locals.findIndex(c => c.id === card.id);
      if (i >= 0) state.locals[i] = card; else state.locals.push(card);
      await writeVault(LS_LOCAL, state.locals);
    }
    closeModal('editModal');
    refilter(card.id);
    state.idx = Math.max(0, state.list.findIndex(c => c.id === card.id));
    renderAll();
    toast(base.id ? '카드를 고쳤어요' : '카드를 끼워 넣었어요');
  } catch (e) {
    err.textContent = '저장 공간이 모자라요. 사진을 빼거나 작은 사진으로 다시 저장해 주세요.';
  } finally {
    btn.disabled = false;
  }
}

async function deleteCard() {
  const id = state.editingId;
  if (!id) return;
  const card = (state.all || []).find(c => c.id === id);
  if (!card || card.builtin) return;
  if (!confirm(`“${card.title}” 카드를 지울까요?`)) return;
  state.locals = state.locals.filter(c => c.id !== id);
  try { await writeVault(LS_LOCAL, state.locals); } catch (e) {}
  closeModal('editModal');
  refilter();
  renderAll();
  toast('카드를 지웠어요');
}

/* ────────── 내보내기 ────────── */
function exportJSON() {
  const payload = {
    app: 'recipe-notebook',
    exportedAt: new Date().toISOString(),
    count: (state.all || []).length,
    cards: (state.all || []).map(c => {
      const { __order, builtin, ...rest } = c;
      return rest;
    })
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `recipe-notebook-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('JSON으로 내보냈어요');
  closeSheet();
}

function lockNow() {
  try { sessionStorage.removeItem(SS_KEY); } catch (e) {}
  state.key = null; state.data = null; state.locals = []; state.overrides = {}; state.all = []; state.list = [];
  closeModal('editModal'); closeModal('photoModal'); closeSheet();
  showLock();
}

/* ────────── 이벤트 ────────── */
function bind() {
  // 잠금
  $('#keypad').addEventListener('click', (e) => {
    const b = e.target.closest('.key');
    if (!b) return;
    pressKey(b.dataset.key);
    b.classList.add('press');
    setTimeout(() => b.classList.remove('press'), 90);
  });
  document.addEventListener('keydown', (e) => {
    if (!$('#lock').hidden) {
      if (/^[0-9]$/.test(e.key)) { pressKey(e.key); return; }
      if (e.key === 'Backspace') { pressKey('del'); e.preventDefault(); return; }
      if (e.key === 'Escape') { pressKey('clear'); return; }
      if (e.key === 'Enter' && state.pins.length === PIN_LEN) { submitPin(); return; }
      return;
    }
    if (!$('#app').hidden) {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '');
      const modalOpen = $$('.modal:not([hidden])').length || !$('#tocSheet').hidden;
      if (e.key === 'Escape') {
        if (!$('#photoModal').hidden) closeModal('photoModal');
        else if (!$('#editModal').hidden) closeModal('editModal');
        else if (!$('#tocSheet').hidden) closeSheet();
        return;
      }
      if (typing || modalOpen) return;
      if (e.key === 'ArrowLeft') { go(-1); e.preventDefault(); }
      if (e.key === 'ArrowRight') { go(1); e.preventDefault(); }
      if (e.key === '/') { $('#search').focus(); e.preventDefault(); }
    }
  });

  // 앱
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (!b) return;
    state.cat = b.dataset.cat;
    refilter();
    renderAll();
  });
  $('#search').addEventListener('input', (e) => {
    state.q = e.target.value;
    $('#searchClear').hidden = !state.q;
    refilter();
    renderAll();
  });
  $('#searchClear').addEventListener('click', () => {
    $('#search').value = ''; state.q = ''; $('#searchClear').hidden = true;
    refilter(); renderAll();
  });
  $('#prev').addEventListener('click', () => go(-1));
  $('#next').addEventListener('click', () => go(1));
  $('#mbPrev').addEventListener('click', () => go(-1));
  $('#mbNext').addEventListener('click', () => go(1));
  $('#mbCount').addEventListener('click', openSheet);
  $('#btnToc').addEventListener('click', openSheet);
  $('#btnNew').addEventListener('click', () => openEditor(null));
  $('#btnLock').addEventListener('click', lockNow);
  $('#btnLock2').addEventListener('click', lockNow);
  $('#btnExport').addEventListener('click', exportJSON);

  $('#toc').addEventListener('click', (e) => {
    const b = e.target.closest('.toc-item');
    if (b) goToId(b.dataset.id);
  });
  $('#tocSheetList').addEventListener('click', (e) => {
    const b = e.target.closest('.toc-item');
    if (b) goToId(b.dataset.id);
  });

  // 카드 안 버튼
  $('#card').addEventListener('click', (e) => {
    const photo = e.target.closest('[data-photo]');
    if (photo) { openPhoto(photo.dataset.photo); return; }
    const edit = e.target.closest('[data-edit]');
    if (edit) { openEditor((state.all || []).find(c => c.id === edit.dataset.edit)); return; }
    if (e.target.closest('[data-new]')) openEditor(null);
  });

  // 모달 닫기
  $$('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(b.dataset.close)));
  $$('.modal').forEach(m => m.addEventListener('click', (e) => { if (e.target === m) closeModal(m.id); }));
  $('#tocSheet').addEventListener('click', (e) => { if (e.target.id === 'tocSheet') closeSheet(); });

  // 편집 폼
  $('#editForm').addEventListener('submit', saveEditor);
  $('#addStep').addEventListener('click', () => {
    addStepRow('', '');
    const rows = $$('#stepsEdit .step-row');
    rows[rows.length - 1].querySelector('.s-text').focus();
  });
  $('#fPhoto').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      state.pendingPhoto = await fileToPhoto(f);
      renderPhotoPreview();
      $('#photoClear').hidden = false;
    } catch (err) {
      $('#editError').textContent = '사진을 읽지 못했어요. 다른 사진으로 해보세요.';
    }
  });
  $('#photoClear').addEventListener('click', () => {
    state.pendingPhoto = null;
    $('#fPhoto').value = '';
    $('#photoClear').hidden = true;
    renderPhotoPreview();
  });
  $('#deleteCard').addEventListener('click', deleteCard);

  // 스와이프
  let sx = 0, sy = 0, tracking = false;
  $('#card').addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; tracking = true;
  }, { passive: true });
  $('#card').addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.6) go(dx < 0 ? 1 : -1);
  }, { passive: true });
}
function openSheet() {
  $('#tocSheetList').innerHTML = $('#toc').innerHTML.replace('class="toc-title"', 'class="toc-title" style="display:none"');
  $('#tocSheet').hidden = false;
  document.body.style.overflow = 'hidden';
}

/* ────────── 부팅 ────────── */
async function boot() {
  bind();
  try {
    const res = await fetch('data/recipes-enc.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    bundle = await res.json();
    state.ready = true;
  } catch (e) {
    flashMsg('노트를 불러오지 못했어요. 새로고침 해 주세요.');
    return;
  }
  const saved = (() => { try { return sessionStorage.getItem(SS_KEY); } catch (e) { return null; } })();
  if (saved) {
    try {
      const key = await crypto.subtle.importKey('raw', B64.dec(saved), 'AES-GCM', true, ['encrypt', 'decrypt']);
      const parsed = await decJSON(key, bundle.iv, bundle.ct);
      state.key = key; state.data = parsed;
      await loadLocal();
      enterApp();
      return;
    } catch (e) { try { sessionStorage.removeItem(SS_KEY); } catch (_) {} }
  }
  showLock();
}

boot();
