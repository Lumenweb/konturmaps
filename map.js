'use strict';

// В режиме предпросмотра (из админки) сервер подставляет window.KM_PREVIEW с другими адресами.
const PREVIEW = window.KM_PREVIEW || null;
// Просмотр сданной работы учителем: карта и ответы ученика только для чтения
const REVIEW = PREVIEW && PREVIEW.review;
const MAP_ID = (PREVIEW && PREVIEW.mapId) || location.pathname.split('/').filter(Boolean).pop();
const API = PREVIEW ? PREVIEW.api : '/api/maps/';
const IMG = PREVIEW ? PREVIEW.img : '/img/';
const PREVIEW_KEY = 'kmap-preview:' + MAP_ID; // в предпросмотре учителя работа живёт только в браузере
const SVG_NS = 'http://www.w3.org/2000/svg';

const COLORS = [
  ['#d62828', 'Красный'], ['#1d4ed8', 'Синий'], ['#15803d', 'Зелёный'], ['#7c3aed', 'Фиолетовый'],
  ['#ea580c', 'Оранжевый'], ['#db2777', 'Розовый'], ['#92400e', 'Коричневый'], ['#111827', 'Чёрный'],
];
const WIDTHS = [2, 3.5, 6];
const ICON = {
  pan: '<path d="M12 3v18M3 12h18M12 3L9 6M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>',
  point: '<circle cx="8" cy="12" r="4" fill="currentColor"/><path d="M15 12h6"/>',
  battle: '<path d="M5 5l14 14M19 5L5 19"/>',
  line: '<path d="M3 17c4-8 7 2 10-4s5-6 8-6"/>',
  arrow: '<path d="M4 19C8 11 12 9 19 6"/><path d="M13 4.5l6 1.5-2.5 5.5"/>',
  area: '<path d="M5 7l7-3 7 5-2 9-9 1z" fill="currentColor" fill-opacity=".25"/>',
  text: '<path d="M5 6h14M12 6v13"/>',
  erase: '<path d="M8 20h12M5 15l9-9 5 5-7 7H9z"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
};
const TOOLS = [
  ['pan', 'Двигать'], ['point', 'Город'], ['battle', 'Битва'], ['line', 'Линия'],
  ['arrow', 'Стрелка'], ['area', 'Область'], ['text', 'Надпись'], ['erase', 'Ластик'],
];
const DRAW_TOOLS = ['line', 'arrow', 'area'];
const TOOL_NAME = Object.fromEntries(TOOLS);
const TOOL_HINT = {
  pan: 'Двигайте карту пальцем, приближайте двумя пальцами. Чтобы отметить что-то, выберите инструмент ниже.',
  point: 'Нажмите на карту там, где находится город, — появится точка. Затем впишите его название.',
  battle: 'Нажмите на место сражения и впишите название и год.',
  line: 'Ведите пальцем по карте — так рисуется линия (например, граница).',
  arrow: 'Проведите пальцем линию по карте — на её конце появится стрелка.',
  area: 'Обведите пальцем территорию — она закрасится выбранным цветом.',
  text: 'Нажмите на карту там, где нужна надпись, и введите текст.',
  erase: 'Нажмите на отметку (или проведите по ней), чтобы стереть её.',
};
// Подбор инструментов по тексту задания, если учитель не выбрал их сам
const TOOL_RULES = [
  [/стрелк|направлени|поход|наступлени/i, 'arrow'],
  [/границ/i, 'line'],
  [/сражени|битв/i, 'battle'],
  [/город|крепост|столиц|центр|пункт/i, 'point'],
  [/территори|област|закрас|карандаш|владени/i, 'area'],
];

function taskTools(t) {
  if (Array.isArray(t.tools) && t.tools.length) return t.tools;
  const found = TOOL_RULES.filter(([re]) => re.test(t.text)).map(([, id]) => id);
  return found.length ? found : ['point', 'line', 'text'];
}
const LEGEND_STYLES = [
  ['line', 'Линия'], ['dash', 'Пунктир'], ['arrow', 'Стрелка'], ['area', 'Область'], ['point', 'Точка'], ['battle', 'Битва'],
];

const $ = s => document.querySelector(s);
const vp = $('#viewport'), world = $('#world'), svg = $('#svg'), marksLayer = $('#marks'), liveLayer = $('#live');

let map = null, W = 0, H = 0, U = 1;
let tool = 'pan', color = COLORS[0][0], widthIdx = 1, dashed = false;
let activeTask = null;
let work = REVIEW ? Object.assign(blankWork(), REVIEW.work) : PREVIEW ? loadPreviewWork() : blankWork();
const history = [];
let me = null;                  // ученик, который вошёл
let submission = null;          // сданная версия и результат проверки: {at, status, grade, comment, checked}
let changedSinceSubmit = false; // ученик изменил работу после сдачи

// ---------- хранение работы: на сервере, с копией в телефоне на случай потери связи ----------

function blankWork() {
  return { marks: [], legend: [], answers: {}, done: {} };
}

function loadPreviewWork() {
  try {
    const w = JSON.parse(localStorage.getItem(PREVIEW_KEY));
    if (w && Array.isArray(w.marks)) return Object.assign(blankWork(), w);
  } catch { /* повреждённые данные — начинаем заново */ }
  return blankWork();
}

const pendingKey = () => `km-pending:${me.id}:${MAP_ID}`;
let serverVersion = 0;   // какую версию черновика сервер уже знает
let syncTimer = null, syncing = null, syncState = '';

function setSync(state) {
  syncState = state;
  updateName();
}

function saveWork() {
  if (REVIEW) return;
  if (PREVIEW) {
    try { localStorage.setItem(PREVIEW_KEY, JSON.stringify(work)); } catch { /* не страшно */ }
    return;
  }
  if (submission && !changedSinceSubmit) { changedSinceSubmit = true; renderSubmitState(); }
  // копия в телефоне: если связь пропадёт, работа не потеряется и уйдёт на сервер позже
  try { localStorage.setItem(pendingKey(), JSON.stringify({ base: serverVersion, work })); } catch { /* не страшно */ }
  setSync('pending');
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 800);
}

async function syncNow() {
  clearTimeout(syncTimer);
  syncTimer = null;
  if (syncing) await syncing;
  syncing = fetch(`/api/my/maps/${MAP_ID}/draft`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ work }),
  }).then(async r => {
    if (r.status === 401) { location.href = '/'; return; }
    if (!r.ok) throw new Error('save');
    serverVersion = (await r.json()).updated;
    // если ученик успел что-то изменить, пока шёл запрос, — новое сохранение уже запланировано
    if (!syncTimer) {
      try { localStorage.removeItem(pendingKey()); } catch { /* не страшно */ }
      setSync('saved');
    }
  }).catch(() => {
    setSync('offline');
    if (!syncTimer) syncTimer = setTimeout(syncNow, 5000);
  }).finally(() => { syncing = null; });
  await syncing;
}

// при сворачивании браузера сохраняем сразу, не дожидаясь паузы
document.addEventListener('visibilitychange', () => { if (document.hidden && syncTimer) syncNow(); });

function commit() {
  history.push(JSON.stringify(work.marks));
  if (history.length > 80) history.shift();
}

function undo() {
  if (!history.length) return;
  work.marks = JSON.parse(history.pop());
  saveWork(); renderMarks(); updateCounts();
}

function addMark(m) {
  commit();
  work.marks.push(m);
  saveWork(); renderMarks(); updateCounts();
}

// ---------- вспомогательное ----------

function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k);
  return e;
}

function s_(tag, attrs, parent) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</svg>`;
const r1 = v => Math.round(v * 10) / 10;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function showNotice(text) {
  const n = $('#notice');
  n.textContent = text;
  n.hidden = false;
  n.onclick = () => { n.hidden = true; };
}

function modal({ title, text, input, value = '', placeholder = '', ok = 'Готово', danger = false }) {
  return new Promise(resolve => {
    const field = input ? h('input', { class: 'input', value, placeholder, maxlength: 120 }) : null;
    const opened = Date.now();
    const close = v => { wrap.remove(); resolve(v); };
    const form = h('form', { class: 'modal-box', onsubmit: e => { e.preventDefault(); close(field ? field.value.trim() : true); } },
      h('h3', {}, title), text && h('p', {}, text), field,
      h('div', { class: 'modal-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, 'Отмена'),
        h('button', { type: 'submit', class: 'btn ' + (danger ? 'danger' : 'primary') }, ok)));
    const wrap = h('div', { class: 'modal', onclick: e => { if (e.target === wrap && Date.now() - opened > 500) close(null); } }, form);
    wrap.addEventListener('keydown', e => { if (e.key === 'Escape') close(null); });
    document.body.append(wrap);
    (field || form.querySelector('[type=submit]')).focus();
  });
}

// ---------- отрисовка отметок ----------

function pathD(p, close) {
  let d = `M${p[0][0]} ${p[0][1]}`;
  for (let i = 1; i < p.length - 1; i++) {
    const mx = r1((p[i][0] + p[i + 1][0]) / 2), my = r1((p[i][1] + p[i + 1][1]) / 2);
    d += ` Q${p[i][0]} ${p[i][1]} ${mx} ${my}`;
  }
  const last = p[p.length - 1];
  d += ` L${last[0]} ${last[1]}`;
  return close ? d + ' Z' : d;
}

function arrowHead(p, w) {
  const e = p[p.length - 1], L = Math.max(12 * U, w * 4);
  let b = p[0];
  for (let i = p.length - 2; i >= 0; i--) {
    if (Math.hypot(e[0] - p[i][0], e[1] - p[i][1]) >= L * 0.8) { b = p[i]; break; }
  }
  let dx = e[0] - b[0], dy = e[1] - b[1];
  const len = Math.hypot(dx, dy) || 1;
  dx /= len; dy /= len;
  const bx = e[0] - dx * L, by = e[1] - dy * L, hw = L * 0.5;
  return `${e[0] + dx * w * 0.6},${e[1] + dy * w * 0.6} ${bx - dy * hw},${by + dx * hw} ${bx + dy * hw},${by - dx * hw}`;
}

function label(g, x, y, text, c, anchor) {
  const t = s_('text', {
    x, y, fill: c, 'font-size': 13 * U, 'font-weight': 700, 'text-anchor': anchor,
    stroke: '#fff', 'stroke-width': 3 * U, 'paint-order': 'stroke', 'stroke-linejoin': 'round',
    'font-family': 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
  }, g);
  t.textContent = text;
}

function drawMark(m, parent, i) {
  const g = s_('g', {}, parent);
  if (i != null) g.dataset.i = i;
  const w = m.w;
  if (m.t === 'line' || m.t === 'arrow' || m.t === 'area') {
    const close = m.t === 'area', d = pathD(m.p, close);
    s_('path', { d, fill: close ? 'transparent' : 'none', stroke: 'transparent', 'stroke-width': Math.max(w * 3, 14 * U), 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
    const attrs = { d, stroke: m.c, 'stroke-width': w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', fill: close ? m.c : 'none' };
    if (close) attrs['fill-opacity'] = 0.28;
    if (m.d) attrs['stroke-dasharray'] = `${w * 2.5} ${w * 2.2}`;
    s_('path', attrs, g);
    if (m.t === 'arrow') s_('polygon', { points: arrowHead(m.p, w), fill: m.c }, g);
  } else if (m.t === 'point' || m.t === 'battle') {
    s_('circle', { cx: m.x, cy: m.y, r: 12 * U, fill: 'transparent' }, g);
    if (m.t === 'point') {
      s_('circle', { cx: m.x, cy: m.y, r: 5 * U, fill: m.c, stroke: '#fff', 'stroke-width': 1.5 * U }, g);
    } else {
      const r = 6 * U;
      s_('path', { d: `M${m.x - r} ${m.y - r}L${m.x + r} ${m.y + r}M${m.x + r} ${m.y - r}L${m.x - r} ${m.y + r}`, stroke: '#fff', 'stroke-width': 5 * U, 'stroke-linecap': 'round' }, g);
      s_('path', { d: `M${m.x - r} ${m.y - r}L${m.x + r} ${m.y + r}M${m.x + r} ${m.y - r}L${m.x - r} ${m.y + r}`, stroke: m.c, 'stroke-width': 2.4 * U, 'stroke-linecap': 'round' }, g);
    }
    if (m.label) label(g, m.x + 9 * U, m.y + 4.5 * U, m.label, m.c, 'start');
  } else if (m.t === 'text') {
    label(g, m.x, m.y + 4.5 * U, m.label, m.c, 'middle');
  }
  return g;
}

function renderMarks() {
  marksLayer.replaceChildren();
  work.marks.forEach((m, i) => drawMark(m, marksLayer, i));
}

// ---------- масштаб и перемещение ----------

let s = 1, tx = 0, ty = 0, fitS = 1;

function applyView() {
  world.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
}

function fit() {
  const r = vp.getBoundingClientRect();
  fitS = Math.min(r.width / W, r.height / H) * 0.96;
  s = fitS;
  tx = (r.width - W * s) / 2;
  ty = (r.height - H * s) / 2;
  applyView();
}

function zoomAt(cx, cy, k) {
  const r = vp.getBoundingClientRect(), px = cx - r.left, py = cy - r.top;
  const ns = clamp(s * k, fitS * 0.6, fitS * 10);
  tx = px - (px - tx) * ns / s;
  ty = py - (py - ty) * ns / s;
  s = ns;
  applyView();
}

function zoomCenter(k) {
  const r = vp.getBoundingClientRect();
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, k);
}

function toImg(cx, cy) {
  const r = vp.getBoundingClientRect();
  return [(cx - r.left - tx) / s, (cy - r.top - ty) / s];
}

// ---------- жесты ----------

const ptrs = new Map();
let gesture = null;

function startPinch() {
  const [a, b] = [...ptrs.values()];
  gesture = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, c0: [(a.x + b.x) / 2, (a.y + b.y) / 2], s0: s, tx0: tx, ty0: ty };
}

function movePinch() {
  const [a, b] = [...ptrs.values()];
  const r = vp.getBoundingClientRect();
  const d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const g = gesture, ns = clamp(g.s0 * d / g.d0, fitS * 0.6, fitS * 10);
  const ix = (g.c0[0] - r.left - g.tx0) / g.s0, iy = (g.c0[1] - r.top - g.ty0) / g.s0;
  tx = cx - r.left - ix * ns;
  ty = cy - r.top - iy * ns;
  s = ns;
  applyView();
}

function liveAttrs() {
  const w = WIDTHS[widthIdx] * U, a = { stroke: color, 'stroke-width': w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', fill: tool === 'area' ? color : 'none' };
  if (tool === 'area') a['fill-opacity'] = 0.28;
  if (dashed) a['stroke-dasharray'] = `${w * 2.5} ${w * 2.2}`;
  return a;
}

function finishDraw(g) {
  g.el.remove();
  const p = g.p.map(([x, y]) => [r1(x), r1(y)]);
  let len = 0;
  for (let i = 1; i < p.length; i++) len += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  if (p.length < 2 || len < 4 * U || (g.tool === 'area' && p.length < 3)) return;
  addMark({ t: g.tool, task: activeTask, c: color, w: r1(WIDTHS[widthIdx] * U), d: dashed, p });
}

async function placeAt(cx, cy) {
  const [x, y] = toImg(cx, cy);
  if (x < 0 || y < 0 || x > W || y > H) return;
  const t = tool, c = color, task = activeTask;
  const texts = {
    point: ['Как называется этот город?', 'Например: Псков, 1581–1582'],
    battle: ['Место и год сражения', 'Например: Орша, 1564'],
    text: ['Надпись на карте', 'Например: Ливонский орден'],
  };
  const ghost = t === 'text' ? null : drawMark({ t, c, x, y }, liveLayer);
  const value = await modal({ title: texts[t][0], input: true, placeholder: texts[t][1], text: t === 'text' ? null : 'Можно оставить пустым' });
  if (ghost) ghost.remove();
  if (value === null || (t === 'text' && !value)) return;
  addMark({ t, task, c, x: r1(x), y: r1(y), label: value });
}

function eraseAt(cx, cy) {
  const el = document.elementFromPoint(cx, cy);
  const g = el && el.closest('#marks [data-i]');
  if (!g) return;
  if (!gesture.changed) { commit(); gesture.changed = true; }
  work.marks.splice(+g.dataset.i, 1);
  renderMarks();
}

vp.addEventListener('pointerdown', e => {
  if (!map || e.target.closest('.zoom-ctl, #notice, #toolHint')) return;
  try { vp.setPointerCapture(e.pointerId); } catch { /* указатель уже отпущен */ }
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 2) {
    if (gesture && gesture.el) gesture.el.remove();
    startPinch();
    return;
  }
  if (ptrs.size > 2) return;
  if (tool === 'pan' || e.button !== 0) {
    gesture = { type: 'pan', sx: e.clientX, sy: e.clientY, tx, ty };
  } else if (DRAW_TOOLS.includes(tool)) {
    gesture = { type: 'draw', tool, p: [toImg(e.clientX, e.clientY)], el: s_('path', liveAttrs(), liveLayer) };
  } else if (tool === 'erase') {
    gesture = { type: 'erase', changed: false };
    eraseAt(e.clientX, e.clientY);
  } else {
    gesture = { type: 'tap', sx: e.clientX, sy: e.clientY, tx, ty };
  }
});

vp.addEventListener('pointermove', e => {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const g = gesture;
  if (!g) return;
  if (g.type === 'pinch') { if (ptrs.size >= 2) movePinch(); return; }
  if (g.type === 'tap' || g.type === 'pan') {
    const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
    if (g.type === 'tap') {
      if (Math.hypot(dx, dy) < 8) return;
      g.type = 'pan'; // палец сдвинулся — значит, двигаем карту
    }
    tx = g.tx + dx; ty = g.ty + dy;
    applyView();
  } else if (g.type === 'draw') {
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of (events.length ? events : [e])) {
      const [x, y] = toImg(ev.clientX, ev.clientY), last = g.p[g.p.length - 1];
      if (Math.hypot(x - last[0], y - last[1]) >= 2.5 / s) g.p.push([x, y]);
    }
    if (g.p.length > 1) g.el.setAttribute('d', pathD(g.p.map(([x, y]) => [r1(x), r1(y)]), g.tool === 'area'));
  } else if (g.type === 'erase') {
    eraseAt(e.clientX, e.clientY);
  }
});

function endPointer(e) {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  const g = gesture;
  if (!g) return;
  if (g.type === 'pinch') { if (ptrs.size === 0) gesture = null; return; }
  gesture = null;
  if (e.type === 'pointercancel') { if (g.el) g.el.remove(); return; }
  if (g.type === 'draw') finishDraw(g);
  else if (g.type === 'tap') placeAt(e.clientX, e.clientY);
  else if (g.type === 'erase' && g.changed) { saveWork(); updateCounts(); }
}
vp.addEventListener('pointerup', endPointer);
vp.addEventListener('pointercancel', endPointer);
vp.addEventListener('contextmenu', e => e.preventDefault());
vp.addEventListener('wheel', e => { e.preventDefault(); zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15); }, { passive: false });
$('#zoomIn').onclick = () => zoomCenter(1.4);
$('#zoomOut').onclick = () => zoomCenter(1 / 1.4);
$('#zoomFit').onclick = fit;
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.target.closest('input, textarea')) { e.preventDefault(); undo(); }
});
// Не даём iOS масштабировать всю страницу жестом
document.addEventListener('gesturestart', e => e.preventDefault());

// ---------- панель инструментов ----------

function buildToolbar() {
  const tools = $('#tools');
  const task = map && map.tasks.find(t => t.id === activeTask);
  const suggested = task ? taskTools(task) : [];
  tools.replaceChildren(...TOOLS.map(([id, name]) => h('button', {
    class: 'tool' + (tool === id ? ' active' : '') + (suggested.includes(id) ? ' suggested' : ''), type: 'button', title: name,
    html: icon(id) + `<span>${name}</span>`, onclick: () => { tool = id; buildToolbar(); updateHint(); },
  })));
  vp.classList.toggle('pan', tool === 'pan');

  const widthSvg = WIDTHS.map((_, i) => `<svg viewBox="0 0 26 20"><path d="M3 10h20" stroke="currentColor" stroke-linecap="round" stroke-width="${[2, 3.5, 6][i]}"/></svg>`);
  const opts = $('#opts');
  opts.replaceChildren(
    ...COLORS.map(([c, name]) => h('button', {
      class: 'color' + (c === color ? ' active' : ''), type: 'button', title: name, 'aria-label': name,
      style: `background:${c}`, onclick: () => { color = c; opts.classList.remove('open'); buildToolbar(); },
    })),
    h('button', { class: 'opt-btn', type: 'button', title: 'Толщина линии', html: widthSvg[widthIdx], onclick: () => { widthIdx = (widthIdx + 1) % WIDTHS.length; buildToolbar(); } }),
    h('button', {
      class: 'opt-btn' + (dashed ? ' active' : ''), type: 'button', title: 'Пунктир',
      html: '<svg viewBox="0 0 26 20"><path d="M3 10h20" stroke="currentColor" stroke-width="3" stroke-dasharray="4 3"/></svg>',
      onclick: () => { dashed = !dashed; buildToolbar(); },
    }),
  );
  $('#toolSide').replaceChildren(
    h('button', {
      class: 'style-btn', type: 'button', title: 'Цвет и толщина', 'aria-label': 'Цвет и толщина',
      html: `<i style="background:${color}"></i>`, onclick: () => opts.classList.toggle('open'),
    }),
    h('button', { class: 'opt-btn', type: 'button', title: 'Отменить (Ctrl+Z)', 'aria-label': 'Отменить', html: icon('undo'), onclick: undo }),
  );
}

// окошко с цветами закрывается при нажатии мимо него
document.addEventListener('pointerdown', e => {
  if (!e.target.closest('#opts, .style-btn')) $('#opts').classList.remove('open');
});

// ---------- задания ----------

function setActiveTask(id) {
  activeTask = id;
  document.querySelectorAll('.task').forEach(el => el.classList.toggle('active', el.dataset.id === id));
  updateTaskBar();
  buildToolbar();
}

// Выбрать задание и инструмент и сразу перейти к карте
function startTask(taskId, toolId) {
  tool = toolId;
  setActiveTask(taskId);
  updateHint();
  if (!matchMedia('(min-width: 900px)').matches) togglePanel(false);
}

let hintTimer = null;

function updateHint() {
  const el = $('#toolHint');
  el.innerHTML = icon(tool) + '<span></span>';
  el.querySelector('span').textContent = TOOL_HINT[tool];
  el.classList.remove('gone');
  clearTimeout(hintTimer);
  // на телефоне подсказка не закрывает карту: показывается несколько секунд и прячется
  if (!matchMedia('(min-width: 900px)').matches) hintTimer = setTimeout(() => el.classList.add('gone'), 4500);
}

function updateTaskBar() {
  const bar = $('#taskBar');
  const i = map.tasks.findIndex(t => t.id === activeTask);
  bar.hidden = i < 0;
  if (i < 0) return;
  $('#taskChip').replaceChildren(h('b', {}, `Задание ${i + 1}/${map.tasks.length}`), h('span', {}, map.tasks[i].text.split('\n')[0]), h('i', {}, 'все задания'));
}

function updateCounts() {
  document.querySelectorAll('.task').forEach(el => {
    const n = work.marks.filter(m => m.task === el.dataset.id).length;
    el.querySelector('.task-count').textContent = n ? `Отметок на карте: ${n}` : 'Отметок пока нет';
  });
}

function updateName() {
  const el = $('#studentName');
  if (REVIEW) { el.textContent = REVIEW.name; return; }
  if (PREVIEW) { el.textContent = 'Работа в предпросмотре не сохраняется на сервер'; return; }
  if (!me) return;
  const sync = { saved: 'сохранено ✓', pending: 'сохранение…', offline: 'нет связи, сохранится позже' }[syncState];
  el.textContent = `${me.name}, ${me.className}` + (sync ? ` · ${sync}` : '');
  el.classList.toggle('unsigned', syncState === 'offline');
}

function renderTasks() {
  const box = $('#tabTasks');
  box.replaceChildren(...[
    h('div', { id: 'submitState' }),
    !map.tasks.length && h('p', { class: 'muted' }, 'К этой карте нет заданий.'),
    ...map.tasks.map((t, i) => h('div', {
      class: 'task' + (t.id === activeTask ? ' active' : '') + (work.done[t.id] ? ' done' : ''), 'data-id': t.id,
      onclick: e => { if (!e.target.closest('input, textarea, label')) setActiveTask(t.id); },
    },
      h('div', { class: 'task-head' }, h('div', { class: 'task-num' }, i + 1), h('div', { class: 'task-text' }, t.text)),
      h('div', { class: 'task-tools' },
        h('span', {}, 'Выполнить на карте:'),
        taskTools(t).map(id => h('button', {
          class: 'tool-chip', type: 'button', html: icon(id) + `<span>${TOOL_NAME[id]}</span>`,
          onclick: () => startTask(t.id, id),
        }))),
      t.answer && h('textarea', {
        class: 'input', placeholder: REVIEW ? 'Ответа нет' : 'Письменный ответ', value: work.answers[t.id] || '', readonly: !!REVIEW,
        onfocus: () => setActiveTask(t.id), oninput: e => { work.answers[t.id] = e.target.value; saveWork(); },
      }),
      h('div', { class: 'task-foot' },
        h('span', { class: 'task-count' }),
        h('label', { class: 'check' }, h('input', {
          type: 'checkbox', checked: !!work.done[t.id], disabled: !!REVIEW,
          onchange: e => { work.done[t.id] = e.target.checked; e.target.closest('.task').classList.toggle('done', e.target.checked); saveWork(); },
        }), 'Выполнено')))),
    !REVIEW && h('button', { class: 'btn ghost-danger', type: 'button', style: 'margin-top:8px', onclick: clearWork }, 'Очистить всю работу'),
  ].filter(Boolean));
  updateCounts();
  renderSubmitState();
}

async function clearWork() {
  const ok = await modal({ title: 'Очистить работу?', text: 'Все отметки, ответы и условные знаки на этой карте будут удалены.', ok: 'Очистить', danger: true });
  if (!ok) return;
  commit();
  work = blankWork();
  saveWork(); renderTasks(); renderLegend(); renderMarks();
}

// ---------- условные знаки ----------

function legendSample(item) {
  const sv = s_('svg', { viewBox: '0 0 44 26' });
  const c = item.c;
  switch (item.s) {
    case 'line': s_('path', { d: 'M5 13h34', stroke: c, 'stroke-width': 3, 'stroke-linecap': 'round' }, sv); break;
    case 'dash': s_('path', { d: 'M5 13h34', stroke: c, 'stroke-width': 3, 'stroke-dasharray': '6 4' }, sv); break;
    case 'arrow': s_('path', { d: 'M5 13h26', stroke: c, 'stroke-width': 3, 'stroke-linecap': 'round' }, sv); s_('polygon', { points: '39,13 29,7 29,19', fill: c }, sv); break;
    case 'area': s_('rect', { x: 6, y: 5, width: 32, height: 16, rx: 3, fill: c, 'fill-opacity': 0.28, stroke: c, 'stroke-width': 2 }, sv); break;
    case 'point': s_('circle', { cx: 22, cy: 13, r: 5, fill: c }, sv); break;
    case 'battle': s_('path', { d: 'M16 7l12 12M28 7L16 19', stroke: c, 'stroke-width': 2.6, 'stroke-linecap': 'round' }, sv); break;
  }
  return sv;
}

function renderLegend() {
  const box = $('#tabLegend');
  if (REVIEW) {
    box.replaceChildren(...(work.legend.length
      ? work.legend.map(item => h('div', { class: 'legend-row' }, legendSample(item), h('span', {}, item.text || '—')))
      : [h('p', { class: 'muted', style: 'margin-top:0' }, 'Ученик не добавил условных знаков.')]));
    return;
  }
  const rows = work.legend.map((item, i) => {
    const sample = legendSample(item);
    return h('div', { class: 'legend-row' },
      h('button', {
        class: 'swatch', type: 'button', title: 'Сменить цвет', style: `background:${item.c}`,
        onclick: () => { const k = COLORS.findIndex(c => c[0] === item.c); item.c = COLORS[(k + 1) % COLORS.length][0]; saveWork(); renderLegend(); },
      }),
      sample,
      h('select', { class: 'input', onchange: e => { item.s = e.target.value; saveWork(); renderLegend(); } },
        LEGEND_STYLES.map(([v, n]) => { const o = h('option', { value: v }, n); o.selected = v === item.s; return o; })),
      h('input', { class: 'input', value: item.text, placeholder: 'Что обозначает', maxlength: 120, oninput: e => { item.text = e.target.value; saveWork(); } }),
      h('button', { class: 'icon-btn', type: 'button', title: 'Удалить', onclick: () => { work.legend.splice(i, 1); saveWork(); renderLegend(); } }, '✕'));
  });
  box.replaceChildren(
    h('p', { class: 'muted', style: 'margin-top:0' }, 'Придумайте свои условные знаки и подпишите, что они обозначают. Цвет меняется нажатием на кружок.'),
    ...rows,
    h('button', {
      class: 'btn', type: 'button', onclick: () => {
        const style = { line: 'line', arrow: 'arrow', area: 'area', point: 'point', battle: 'battle' }[tool] || 'line';
        work.legend.push({ c: color, s: dashed && style === 'line' ? 'dash' : style, text: '' });
        saveWork(); renderLegend();
        box.querySelector('.legend-row:last-of-type input').focus();
      },
    }, '+ Добавить знак'),
  );
}

// ---------- сдача работы учителю ----------

const fmtTime = ms => new Date(ms).toLocaleString('ru', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

const isChecked = () => !!(submission && submission.status === 'checked');
const seenKey = () => `km-seen:${me.id}:${MAP_ID}`;

function showResult() {
  const r = submission;
  modal({
    title: r.grade ? `Учитель проверил работу. Оценка: ${r.grade}` : 'Учитель проверил работу',
    text: r.comment ? `Комментарий учителя: ${r.comment}` : 'Комментария нет.',
    ok: 'Понятно',
  });
}

// новая проверка (или учитель изменил оценку) — один раз показываем результат окном
function announceResult() {
  if (!isChecked()) return;
  let seen = null;
  try { seen = localStorage.getItem(seenKey()); } catch { /* хранилище недоступно */ }
  if (seen === String(submission.checked)) return;
  try { localStorage.setItem(seenKey(), String(submission.checked)); } catch { /* не страшно */ }
  showResult();
}

function renderResultBar() {
  const bar = $('#resultBar');
  if (!bar || PREVIEW) return;
  bar.hidden = !isChecked();
  if (bar.hidden) return;
  const r = submission;
  bar.replaceChildren(
    h('b', {}, '✓ Проверено учителем'),
    r.grade && h('span', { class: 'result-grade' }, `Оценка: ${r.grade}`),
    h('span', { class: 'result-comment' }, r.comment || ''),
    h('i', {}, r.comment ? 'читать' : ''));
}

function renderSubmitState() {
  renderResultBar();
  const box = $('#submitState'), btn = $('#submitBtn');
  if (!box || PREVIEW) return;
  const changed = !!submission && changedSinceSubmit;
  const checked = isChecked() && !changed;
  btn.textContent = !submission ? 'Сдать' : changed ? 'Сдать снова'
    : checked ? (submission.grade ? `Оценка ${submission.grade}` : 'Проверено') : 'Сдано ✓';
  btn.classList.toggle('primary', !submission || changed);
  btn.classList.toggle('checked', checked);
  if (!submission) { box.replaceChildren(); box.className = ''; return; }
  const r = submission;
  const lines = [];
  if (r.status === 'checked') {
    lines.push(h('b', {}, r.grade ? `Проверено учителем. Оценка: ${r.grade}` : 'Проверено учителем'));
    if (r.comment) lines.push(h('div', { class: 'teacher-comment' }, r.comment));
  } else {
    lines.push(h('b', {}, 'Работа отправлена учителю'), h('div', {}, `${fmtTime(r.at)} · ждёт проверки`));
  }
  if (changed) lines.push(h('div', { class: 'warn-line' }, 'Вы изменили работу после отправки. Нажмите «Сдать снова», чтобы учитель увидел исправления.'));
  box.className = 'submit-state' + (r.status === 'checked' ? ' checked' : '');
  box.replaceChildren(...lines);
}

async function fetchStatus() {
  if (PREVIEW || !submission) return;
  const r = await fetch(`/api/my/maps/${MAP_ID}/status`).catch(() => null);
  if (!r || !r.ok) return;
  submission = (await r.json()).submission;
  renderSubmitState();
  announceResult();
}

async function submitWork() {
  const empty = !work.marks.length && !Object.values(work.answers).some(v => v.trim());
  const ok = await modal({
    title: submission ? 'Отправить исправленную работу?' : 'Сдать работу учителю?',
    text: empty ? 'На карте пока нет ни одной отметки. Всё равно отправить?'
      : 'Работу получит учитель. После отправки её можно исправить и сдать снова.',
    ok: 'Отправить',
  });
  if (!ok) return;
  const btn = $('#submitBtn');
  btn.disabled = true;
  clearTimeout(syncTimer);
  syncTimer = null;
  const r = await fetch(`/api/my/maps/${MAP_ID}/submit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ work }),
  }).catch(() => null);
  btn.disabled = false;
  if (r && r.status === 401) { location.href = '/'; return; }
  if (!r || !r.ok) {
    const err = r && (await r.json().catch(() => ({}))).error;
    if (syncState === 'pending') syncTimer = setTimeout(syncNow, 800);
    await modal({ title: 'Не удалось отправить', text: err || 'Нет связи с сервером. Проверьте, что телефон подключён к Wi-Fi класса, и попробуйте ещё раз.', ok: 'Понятно' });
    return;
  }
  submission = (await r.json()).submission;
  serverVersion = submission.at;
  changedSinceSubmit = false;
  try { localStorage.removeItem(pendingKey()); } catch { /* не страшно */ }
  setSync('saved');
  renderSubmitState();
  await modal({ title: 'Работа отправлена', text: 'Учитель получил вашу работу. Если исправите что-то — нажмите «Сдать снова».', ok: 'Хорошо' });
}

// ---------- панель ----------

function togglePanel(force) {
  if (matchMedia('(min-width: 900px)').matches) document.body.classList.toggle('panel-hidden', force === undefined ? undefined : !force);
  else $('#panel').classList.toggle('open', force);
}
$('#panelBtn').onclick = () => togglePanel();
// после проверки кнопка показывает оценку и по нажатию открывает результат
$('#submitBtn').onclick = () => (isChecked() && !changedSinceSubmit ? showResult() : submitWork());
$('#resultBar').onclick = showResult;
$('#panelClose').onclick = () => togglePanel(false);
$('#taskChip').onclick = () => { switchTab('tasks'); togglePanel(true); };
$('#toolHint').onclick = () => $('#toolHint').classList.add('gone');

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $('#tabTasks').hidden = name !== 'tasks';
  $('#tabLegend').hidden = name !== 'legend';
}
document.querySelectorAll('.tab').forEach(t => { t.onclick = () => switchTab(t.dataset.tab); });

$('#helpBtn').onclick = () => {
  const items = [
    ['Выберите задание', 'Откройте «Задания» и нажмите кнопку инструмента под нужным заданием, например «Город». Панель свернётся и откроется карта.'],
    ['Отметьте на карте', 'Город и Битва — нажмите в нужное место и впишите название. Линия, Стрелка, Область — ведите пальцем по карте.'],
    ['Двигайте карту', 'Двумя пальцами — приблизить и сдвинуть. Инструмент «Двигать» — перемещать одним пальцем.'],
    ['Исправляйте', 'Кнопка ↶ отменяет последнее действие, «Ластик» стирает отметку, на которую нажали.'],
    ['Сдавайте', 'Работа сохраняется сама — её можно продолжить и с другого телефона, войдя под своим именем. Когда закончите, нажмите «Сдать». Оценку и комментарий учителя вы увидите здесь же и в списке карт.'],
  ];
  const close = () => wrap.remove();
  const wrap = h('div', { class: 'modal', onclick: e => { if (e.target === wrap) close(); } },
    h('div', { class: 'modal-box' },
      h('h3', {}, 'Как работать с картой'),
      h('ol', { class: 'help-list' }, items.map(([b, t]) => h('li', {}, h('b', {}, b), h('br'), t))),
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: close }, 'Понятно'))));
  document.body.append(wrap);
};

// ---------- запуск ----------

// Работа ученика с сервера; если в телефоне остались несохранённые изменения — они важнее
async function loadStudentWork() {
  const r = await fetch(`/api/my/maps/${MAP_ID}`).catch(() => null);
  if (r && r.status === 401) { location.href = '/'; return false; }
  if (!r || !r.ok) { $('#mapTitle').textContent = 'Нет связи с сервером — обновите страницу'; return false; }
  const data = await r.json();
  me = data.student;
  submission = data.submission;
  changedSinceSubmit = data.changed;
  serverVersion = data.draftUpdated || 0;
  work = Object.assign(blankWork(), data.draft || {});
  let pending = null;
  try { pending = JSON.parse(localStorage.getItem(pendingKey())); } catch { /* повреждённые данные */ }
  if (pending && pending.work && pending.base === serverVersion) {
    work = Object.assign(blankWork(), pending.work);
    saveWork();
  } else {
    // сервер знает более новую версию (например, с другого телефона) — старую копию убираем
    try { localStorage.removeItem(pendingKey()); } catch { /* не страшно */ }
    setSync(serverVersion ? 'saved' : '');
  }
  if (data.draftImageVersion && data.draftImageVersion !== map.imageVersion && work.marks.length) {
    showNotice('Учитель заменил изображение карты — ваши отметки могли сместиться. Нажмите, чтобы скрыть.');
  }
  return true;
}

async function init() {
  const resp = await fetch(API + MAP_ID).catch(() => null);
  if (!resp || !resp.ok) { $('#mapTitle').textContent = 'Карта не найдена'; return; }
  map = await resp.json();
  document.title = map.title + ' — контурная карта';
  $('#mapTitle').textContent = map.title;
  if (PREVIEW) {
    $('#backLink').href = PREVIEW.back;
    $('#submitBtn').hidden = true;
    if (REVIEW) document.body.classList.add('review-mode');
    else $('#mapTitle').append(Object.assign(document.createElement('span'), { className: 'preview-flag', textContent: 'предпросмотр' }));
  } else if (!await loadStudentWork()) {
    return;
  }
  activeTask = map.tasks[0] ? map.tasks[0].id : null;

  const img = $('#mapImg');
  await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = IMG + MAP_ID + '?v=' + map.imageVersion; })
    .catch(() => showNotice('Не удалось загрузить изображение карты.'));
  W = img.naturalWidth || 800; H = img.naturalHeight || 600;
  U = Math.max(W, H) / 800;
  world.style.width = W + 'px';
  world.style.height = H + 'px';
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  if (REVIEW && REVIEW.imageVersion && REVIEW.imageVersion !== map.imageVersion) {
    showNotice('Изображение карты заменили после сдачи работы — отметки могут быть смещены.');
  }

  buildToolbar(); renderTasks(); renderLegend(); renderMarks(); updateName(); updateTaskBar(); updateHint();
  fit();
  // На широком экране панель заданий открыта сразу, на телефоне — свёрнута
  if (!matchMedia('(min-width: 900px)').matches && !work.marks.length && !REVIEW) togglePanel(true);
  if (!PREVIEW) {
    announceResult();
    setInterval(fetchStatus, 30000);
  }
}

init();
init();
