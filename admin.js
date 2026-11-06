'use strict';

const BASE = document.body.dataset.base;
const $ = (s, root = document) => root.querySelector(s);
const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter(k => k != null && k !== false));
const FOLDER_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M3 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>';

let state = { folders: [], maps: [] };
// section: 'maps' — карты, 'subs' — работы учеников (sub — открытая работа), 'students' — классы и ученики,
// 'teachers' — учителя (только у главного учителя)
// folder: 'all' — все карты, null — без раздела, иначе id раздела
const view = { section: 'maps', folder: 'all', map: null, sub: null, q: '', showImport: false };

function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'selected') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k);
  return e;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  return `${n} ${m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many}`;
}

function toast(text, error) {
  const t = h('div', { class: 'toast' + (error ? ' error' : '') }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}

// Пароль для учителя: 12 символов без похожих (0/O, 1/l/I)
const PW_CHARS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
const genPassword = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => PW_CHARS[b % PW_CHARS.length]).join('');
const PW_OK = /^[\x21-\x7e]{8,64}$/;
const PW_RULE = 'Пароль: от 8 символов — латинские буквы, цифры и знаки, без пробелов и русских букв';

function modal({ title, text, fields = [], ok = 'Готово', danger = false }) {
  return new Promise(resolve => {
    const inputs = fields.map(f => h('input', { class: 'input', type: f.type || 'text', value: f.value || '', placeholder: f.placeholder || '', autocomplete: f.generate ? 'off' : null }));
    const close = v => { wrap.remove(); resolve(v); };
    const form = h('form', { class: 'modal-box', onsubmit: e => { e.preventDefault(); close(fields.length ? inputs.map(i => i.value.trim()) : true); } },
      h('h3', {}, title), text && h('p', {}, text),
      fields.map((f, i) => h('label', { class: 'field' }, f.label && h('span', {}, f.label),
        // у поля пароля — кнопка, которая подставляет надёжный пароль
        f.generate ? h('div', { class: 'pw-row' }, inputs[i], h('button', {
          class: 'btn', type: 'button', onclick: () => { inputs[i].value = genPassword(); inputs[i].type = 'text'; inputs[i].focus(); },
        }, 'Сгенерировать')) : inputs[i])),
      h('div', { class: 'modal-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, 'Отмена'),
        h('button', { type: 'submit', class: 'btn ' + (danger ? 'danger' : 'primary') }, ok)));
    const wrap = h('div', { class: 'modal', onclick: e => { if (e.target === wrap) close(null); } }, form);
    wrap.addEventListener('keydown', e => { if (e.key === 'Escape') close(null); });
    document.body.append(wrap);
    (inputs[0] || $('[type=submit]', form)).focus();
  });
}

async function api(method, url, body) {
  const opt = { method, headers: { 'X-KM': '1' } };
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(BASE + '/api' + url, opt);
  if (r.status === 404) { toast('Сессия истекла, войдите снова', true); setTimeout(() => location.reload(), 1200); throw new Error('session'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { toast(data.error || 'Ошибка ' + r.status, true); throw new Error(data.error); }
  return data;
}

// ---------- разделы ----------

const folderById = id => state.folders.find(f => f.id === id);
const childFolders = pid => state.folders.filter(f => (f.parent || null) === pid).sort((a, b) => collator.compare(a.name, b.name));
const byTitle = (a, b) => collator.compare(a.title, b.title);

function folderPath(id) {
  const names = [];
  for (let f = folderById(id), i = 0; f && i < 50; f = folderById(f.parent), i++) names.unshift(f.name);
  return names.join(' / ');
}

function descendants(id) {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of state.folders) if (out.has(f.parent) && !out.has(f.id)) { out.add(f.id); grew = true; }
  }
  return out;
}

function countDeep(fid) {
  const ids = descendants(fid);
  return state.maps.filter(m => ids.has(m.folder)).length;
}

function folderOptions(selected) {
  const opts = [h('option', { value: '', selected: !selected }, '— без раздела —')];
  const walk = (pid, depth) => childFolders(pid).forEach(f => {
    opts.push(h('option', { value: f.id, selected: f.id === selected }, '  '.repeat(depth) + f.name));
    walk(f.id, depth + 1);
  });
  walk(null, 0);
  return opts;
}

async function createFolder(parent) {
  const res = await modal({ title: parent ? `Новый подраздел в «${folderById(parent).name}»` : 'Новый раздел', fields: [{ placeholder: 'Например: 8 класс' }], ok: 'Создать' });
  if (!res || !res[0]) return;
  const f = await api('POST', '/folders', { name: res[0], parent });
  state.folders.push(f);
  view.folder = f.id; view.map = null;
  render();
}

async function renameFolder(id) {
  const f = folderById(id);
  const res = await modal({ title: 'Переименовать раздел', fields: [{ value: f.name }], ok: 'Сохранить' });
  if (!res || !res[0]) return;
  Object.assign(f, await api('PATCH', '/folders/' + id, { name: res[0] }));
  render();
}

async function deleteFolder(id) {
  const f = folderById(id);
  const ok = await modal({ title: `Удалить раздел «${f.name}»?`, text: 'Карты и подразделы из него не удалятся, а переместятся на уровень выше.', ok: 'Удалить', danger: true });
  if (!ok) return;
  state = await api('DELETE', '/folders/' + id);
  view.folder = f.parent || 'all';
  render();
}

async function moveTo(kind, id, target) {
  if (kind === 'map') {
    const m = state.maps.find(x => x.id === id);
    if (!m || (m.folder || null) === target) return;
    Object.assign(m, await api('PATCH', '/maps/' + id, { folder: target }));
    toast(`Карта перемещена в «${target ? folderById(target).name : 'Без раздела'}»`);
  } else {
    const f = folderById(id);
    if (!f || (f.parent || null) === target || (target && descendants(id).has(target))) return;
    Object.assign(f, await api('PATCH', '/folders/' + id, { parent: target }));
  }
  render();
}

function makeDropTarget(el, target) {
  el.addEventListener('dragover', e => {
    if (![...e.dataTransfer.types].some(t => t.startsWith('km/'))) return;
    e.preventDefault(); el.classList.add('drop');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop'));
  el.addEventListener('drop', e => {
    el.classList.remove('drop');
    const mapId = e.dataTransfer.getData('km/map'), folderId = e.dataTransfer.getData('km/folder');
    if (!mapId && !folderId) return;
    e.preventDefault();
    moveTo(mapId ? 'map' : 'folder', mapId || folderId, target).catch(() => {});
  });
}

function makeDraggable(el, kind, id) {
  el.draggable = true;
  el.addEventListener('dragstart', e => { e.dataTransfer.setData('km/' + kind, id); el.classList.add('dragging'); });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
}

// ---------- боковое дерево ----------

function treeItem(id, name, count, depth, special) {
  const li = h('li', {
    class: 'tree-item' + (view.section === 'maps' && view.folder === id ? ' active' : '') + (special ? ' special' : ''),
    style: `padding-left:${10 + depth * 16}px`,
    onclick: () => openFolder(id),
  }, h('span', { class: 'tree-name' }, name), h('span', { class: 'count' }, count));
  if (id !== 'all') makeDropTarget(li, id);
  if (!special) makeDraggable(li, 'folder', id);
  return li;
}

function renderTree() {
  const items = [
    treeItem('all', 'Все карты', state.maps.length, 0, true),
    treeItem(null, 'Без раздела', state.maps.filter(m => !m.folder).length, 0, true),
  ];
  const walk = (pid, depth) => childFolders(pid).forEach(f => { items.push(treeItem(f.id, f.name, countDeep(f.id), depth)); walk(f.id, depth + 1); });
  walk(null, 0);
  $('#tree').replaceChildren(...items);
}

// ---------- список карт ----------

async function flushSave() { if (saveTimer) { clearTimeout(saveTimer); await saveNow(); } }

async function openFolder(id) {
  await flushSave();
  view.section = 'maps'; view.folder = id; view.map = null;
  render();
}

async function openMap(id) {
  await flushSave();
  view.section = 'maps'; view.map = id; view.showImport = false;
  render();
  window.scrollTo(0, 0);
}

function mapCard(m, showPath) {
  const card = h('div', { class: 'card', onclick: () => openMap(m.id) },
    h('div', { class: 'thumb', style: `background-image:url('${BASE}/img/${m.id}?v=${m.imageVersion}')` }),
    h('div', { class: 'body' },
      h('div', { class: 'title' }, m.title),
      h('div', { class: 'meta' }, [showPath && (folderPath(m.folder) || 'Без раздела'), plural(m.tasks.length, 'задание', 'задания', 'заданий')].filter(Boolean).join(' · ')),
      m.published ? h('span', { class: 'badge' }, 'Опубликована') : h('span', { class: 'badge warn' }, 'Черновик')));
  makeDraggable(card, 'map', m.id);
  return card;
}

async function uploadFiles(files) {
  const images = [...files].filter(f => f.type.startsWith('image/'));
  if (!images.length) { toast('Выберите файл изображения (JPG, PNG, WebP)', true); return; }
  let last = null;
  for (const file of images) {
    const fd = new FormData();
    fd.append('image', file);
    fd.append('title', file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '));
    fd.append('folder', view.folder && view.folder !== 'all' ? view.folder : '');
    try { last = await api('POST', '/maps', fd); state.maps.push(last); } catch { /* сообщение уже показано */ }
  }
  if (images.length === 1 && last) openMap(last.id);
  else { render(); if (last) toast(`Загружено карт: ${images.length}`); }
}

function fileInput(accept, multiple, onFiles) {
  const input = h('input', { type: 'file', accept, hidden: true, multiple });
  input.addEventListener('change', () => { if (input.files.length) onFiles(input.files); input.value = ''; });
  return input;
}

function renderList() {
  const fid = view.folder;
  const isFolder = fid !== 'all' && fid !== null;
  const title = fid === 'all' ? 'Все карты' : fid === null ? 'Без раздела' : folderPath(fid);
  const q = view.q.trim().toLowerCase();

  let maps = fid === 'all' ? state.maps : state.maps.filter(m => (m.folder || null) === fid);
  if (q) maps = state.maps.filter(m => [m.title, m.description, folderPath(m.folder), ...m.tasks.map(t => t.text)].join(' ').toLowerCase().includes(q));
  maps = [...maps].sort(byTitle);
  const subfolders = !q && fid !== 'all' ? childFolders(fid) : [];

  const upload = fileInput('image/*', true, uploadFiles);
  const zone = h('label', { class: 'dropzone' }, upload,
    h('b', {}, '+ Добавить карту'),
    h('span', {}, 'Перетащите сюда изображение карты или нажмите, чтобы выбрать файл. Можно сразу несколько.'),
    isFolder && h('span', {}, `Карта попадёт в раздел «${folderById(fid).name}»`));
  zone.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); zone.classList.add('over'); } });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('over'); uploadFiles(e.dataTransfer.files); });

  const folderTiles = subfolders.map(f => {
    const tile = h('div', { class: 'folder-tile', html: FOLDER_ICON, onclick: () => openFolder(f.id) },
      h('span', {}, f.name), h('span', { class: 'muted', style: 'font-weight:400;margin-left:auto' }, countDeep(f.id)));
    makeDropTarget(tile, f.id);
    makeDraggable(tile, 'folder', f.id);
    return tile;
  });

  const search = h('input', { class: 'input', type: 'search', placeholder: 'Поиск по всем картам и заданиям', value: view.q, style: 'max-width:320px' });
  search.addEventListener('input', () => { view.q = search.value; renderList(); const s = $('#main input[type=search]'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); });

  fill($('#main'),
    h('div', { class: 'main-head' },
      h('h1', {}, q ? 'Результаты поиска' : title),
      search,
      fid !== 'all' && h('button', { class: 'btn', type: 'button', onclick: () => createFolder(isFolder ? fid : null) }, isFolder ? '+ Подраздел' : '+ Раздел'),
      isFolder && h('button', { class: 'btn', type: 'button', onclick: () => renameFolder(fid) }, 'Переименовать'),
      isFolder && h('button', { class: 'btn ghost-danger', type: 'button', onclick: () => deleteFolder(fid) }, 'Удалить раздел')),
    !q && zone,
    folderTiles.length > 0 && h('div', { class: 'grid' }, folderTiles),
    maps.length ? h('div', { class: 'grid' }, maps.map(m => mapCard(m, fid === 'all' || !!q)))
      : !folderTiles.length && h('p', { class: 'empty' }, q ? 'Ничего не найдено' : 'Здесь пока нет карт'),
  );
}

// ---------- редактор карты ----------

let saveTimer = null, saving = null;

function setStatus(text, error) {
  const el = $('#saveStatus');
  if (el) { el.textContent = text; el.classList.toggle('error', !!error); }
}

function scheduleSave() {
  setStatus('Есть несохранённые изменения…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 700);
}

async function saveNow() {
  saveTimer = null;
  const m = state.maps.find(x => x.id === view.map);
  if (!m) return;
  if (saving) await saving;
  setStatus('Сохранение…');
  saving = api('PATCH', '/maps/' + m.id, { title: m.title, description: m.description, folder: m.folder || null, published: m.published, tasks: m.tasks })
    .then(saved => { m.updated = saved.updated; setStatus('Все изменения сохранены'); renderTree(); })
    .catch(() => setStatus('Не удалось сохранить', true))
    .finally(() => { saving = null; });
  await saving;
}

window.addEventListener('beforeunload', e => { if (saveTimer || saving) e.preventDefault(); });

function autosize(ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px'; }

// Разбивает текст на задания по строкам вида «1. …» или «1) …»
function parseTasks(text) {
  const tasks = [];
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d{1,3})\s*[.)]\s+(.*)$/);
    if (m || !tasks.length) tasks.push(m ? m[2] : line);
    else tasks[tasks.length - 1] += '\n' + line;
  }
  return tasks.map(t => ({ id: newId(), text: t.trim(), answer: t.includes('?') }));
}

function newId() {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), b => a[b % a.length]).join('');
}

function readTextFile(file) {
  return file.arrayBuffer().then(buf => {
    const utf = new TextDecoder('utf-8').decode(buf);
    return utf.includes('�') ? new TextDecoder('windows-1251').decode(buf) : utf;
  });
}

const TASK_TOOLS = [['point', 'Город'], ['battle', 'Битва'], ['line', 'Линия'], ['arrow', 'Стрелка'], ['area', 'Область'], ['text', 'Надпись']];
// Те же правила, что у ученика: используются, пока учитель не выбрал инструменты сам
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

function renderToolPicker(t, row) {
  const current = taskTools(t);
  const auto = !(Array.isArray(t.tools) && t.tools.length);
  row.replaceChildren(
    h('span', {}, 'Ученик выполняет инструментом:'),
    ...TASK_TOOLS.map(([id, name]) => h('button', {
      class: 'pick' + (current.includes(id) ? ' on' : ''), type: 'button',
      onclick: () => {
        const next = current.includes(id) ? current.filter(x => x !== id) : current.concat(id);
        t.tools = TASK_TOOLS.map(([x]) => x).filter(x => next.includes(x));
        renderToolPicker(t, row); scheduleSave();
      },
    }, name)),
    auto && h('span', { class: 'auto' }, 'подобрано по тексту'));
}

function renderTaskList(m, box) {
  box.replaceChildren(...m.tasks.map((t, i) => {
    const toolsRow = h('div', { class: 'tool-picker' });
    renderToolPicker(t, toolsRow);
    const ta = h('textarea', { class: 'input', value: t.text, rows: 2, placeholder: 'Текст задания', oninput: e => { t.text = e.target.value; autosize(e.target); renderToolPicker(t, toolsRow); scheduleSave(); } });
    requestAnimationFrame(() => autosize(ta));
    const move = d => { const j = i + d; if (j < 0 || j >= m.tasks.length) return; [m.tasks[i], m.tasks[j]] = [m.tasks[j], m.tasks[i]]; renderTaskList(m, box); scheduleSave(); };
    return h('div', { class: 'task-ed' },
      h('div', { class: 'task-num' }, i + 1),
      h('div', {}, ta, toolsRow),
      h('div', { class: 'task-ctl' },
        h('div', { class: 'btns' },
          h('button', { class: 'icon-btn', type: 'button', title: 'Выше', disabled: i === 0, onclick: () => move(-1) }, '↑'),
          h('button', { class: 'icon-btn', type: 'button', title: 'Ниже', disabled: i === m.tasks.length - 1, onclick: () => move(1) }, '↓'),
          h('button', { class: 'icon-btn', type: 'button', title: 'Удалить задание', onclick: async () => {
            if (t.text.trim() && !await modal({ title: `Удалить задание ${i + 1}?`, text: t.text.slice(0, 160), ok: 'Удалить', danger: true })) return;
            m.tasks.splice(i, 1); renderTaskList(m, box); scheduleSave();
          } }, '✕')),
        h('label', { class: 'check', title: 'Под заданием у ученика появится поле для текстового ответа' },
          h('input', { type: 'checkbox', checked: t.answer, onchange: e => { t.answer = e.target.checked; scheduleSave(); } }), 'Письменный ответ')));
  }));
  const counter = $('#taskCount');
  if (counter) counter.textContent = m.tasks.length ? `(${m.tasks.length})` : '';
}

function importBox(m, listBox) {
  const ta = h('textarea', { class: 'input', rows: 6, placeholder: '1. Покажите на карте город Псков…\n2. Отметьте границу…' });
  const mode = h('select', { class: 'input', style: 'width:auto' },
    h('option', { value: 'append' }, 'Добавить к существующим'), h('option', { value: 'replace' }, 'Заменить все задания'));
  const txt = fileInput('.txt,text/plain', false, async files => { ta.value = await readTextFile(files[0]); });
  return h('div', { class: 'import-box' },
    h('p', { style: 'margin:0 0 8px' }, 'Вставьте текст заданий или загрузите .txt файл. Каждое задание должно начинаться с номера: «1.» или «1)». Задания с вопросительным знаком автоматически получат поле для письменного ответа.'),
    ta,
    h('div', { class: 'row' },
      h('label', { class: 'btn' }, txt, 'Загрузить .txt'),
      mode,
      h('button', { class: 'btn primary', type: 'button', onclick: async () => {
        const tasks = parseTasks(ta.value);
        if (!tasks.length) { toast('В тексте не найдено заданий', true); return; }
        if (mode.value === 'replace' && m.tasks.length && !await modal({ title: 'Заменить все задания?', text: `Сейчас заданий: ${m.tasks.length}. Они будут удалены.`, ok: 'Заменить', danger: true })) return;
        m.tasks = mode.value === 'replace' ? tasks : m.tasks.concat(tasks);
        view.showImport = false;
        renderEditor();
        scheduleSave();
        toast(`Добавлено заданий: ${tasks.length}`);
      } }, 'Разобрать на задания'),
      h('button', { class: 'btn', type: 'button', onclick: () => { view.showImport = false; renderEditor(); } }, 'Отмена')));
}

function renderEditor() {
  const m = state.maps.find(x => x.id === view.map);
  if (!m) { view.map = null; renderList(); return; }
  const studentUrl = location.origin + '/map/' + m.id;
  const listBox = h('div');

  const replaceInput = fileInput('image/*', false, async files => {
    const fd = new FormData();
    fd.append('image', files[0]);
    const ok = await modal({ title: 'Заменить изображение?', text: 'Если у учеников уже есть отметки на этой карте, они могут сместиться.', ok: 'Заменить' });
    if (!ok) return;
    Object.assign(m, await api('POST', `/maps/${m.id}/image`, fd));
    renderEditor();
    toast('Изображение заменено');
  });

  const publishedBox = h('div');
  const renderPublished = () => fill(publishedBox,
    h('label', { class: 'check', style: 'font-weight:600' },
      h('input', { type: 'checkbox', checked: m.published, onchange: e => { m.published = e.target.checked; renderPublished(); scheduleSave(); } }),
      'Опубликована — ученики видят карту в списке'),
    m.published && h('div', { class: 'link-row', style: 'margin-top:10px' },
      h('code', {}, studentUrl),
      h('button', { class: 'btn small', type: 'button', onclick: () => navigator.clipboard.writeText(studentUrl).then(() => toast('Ссылка скопирована'), () => toast('Не удалось скопировать', true)) }, 'Копировать')));
  renderPublished();

  fill($('#main'),
    h('div', { class: 'editor-bar' },
      h('button', { class: 'btn', type: 'button', onclick: () => openFolder(view.folder) }, '← К списку'),
      h('span', { class: 'save-status', id: 'saveStatus' }, 'Изменения сохраняются автоматически'),
      h('span', { class: 'spacer' }),
      h('a', { class: 'btn', href: `${BASE}/preview/${m.id}`, target: '_blank' }, 'Предпросмотр'),
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        await flushSave();
        const copy = await api('POST', `/maps/${m.id}/duplicate`);
        state.maps.push(copy);
        openMap(copy.id);
        toast('Создана копия (черновик)');
      } }, 'Дублировать'),
      h('button', { class: 'btn ghost-danger', type: 'button', onclick: async () => {
        if (!await modal({ title: `Удалить карту «${m.title}»?`, text: 'Карта, изображение и задания будут удалены безвозвратно.', ok: 'Удалить', danger: true })) return;
        clearTimeout(saveTimer); saveTimer = null;
        await api('DELETE', '/maps/' + m.id);
        state.maps = state.maps.filter(x => x.id !== m.id);
        view.map = null;
        render();
        toast('Карта удалена');
      } }, 'Удалить')),
    h('div', { class: 'editor' },
      h('div', { class: 'panel-box ed-image' },
        h('img', { src: `${BASE}/img/${m.id}?v=${m.imageVersion}`, alt: m.title }),
        h('div', { class: 'row' }, h('label', { class: 'btn' }, replaceInput, 'Заменить изображение'))),
      h('div', { class: 'panel-box' },
        h('label', { class: 'field' }, h('span', {}, 'Название'),
          h('input', { class: 'input', value: m.title, maxlength: 200, oninput: e => { m.title = e.target.value; scheduleSave(); } })),
        h('label', { class: 'field' }, h('span', {}, 'Раздел'),
          h('select', { class: 'input', onchange: e => { m.folder = e.target.value || null; scheduleSave(); } }, folderOptions(m.folder))),
        h('label', { class: 'field' }, h('span', {}, 'Описание (необязательно, видно в поиске)'),
          h('textarea', { class: 'input', value: m.description || '', rows: 2, maxlength: 2000, placeholder: 'Например: § 12–13 учебника', oninput: e => { m.description = e.target.value; scheduleSave(); } })),
        publishedBox)),
    h('div', { class: 'tasks-head' },
      h('h2', {}, 'Задания ', h('span', { class: 'muted', id: 'taskCount' })),
      h('button', { class: 'btn', type: 'button', onclick: () => { view.showImport = !view.showImport; renderEditor(); } }, 'Импорт из текста'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => {
        m.tasks.push({ id: newId(), text: '', answer: false });
        renderTaskList(m, listBox); scheduleSave();
        const all = listBox.querySelectorAll('textarea'); all[all.length - 1].focus();
      } }, '+ Задание')),
    view.showImport && importBox(m, listBox),
    listBox,
  );
  renderTaskList(m, listBox);
  if (!m.tasks.length && !view.showImport) listBox.append(h('p', { class: 'muted' }, 'Заданий пока нет. Добавьте их по одному или вставьте весь текст через «Импорт из текста».'));
}

// ---------- работы учеников ----------

let subs = [];
const subFilter = { map: '', cls: '', status: 'new', q: '' };
// карта и класс, выбранные в фильтрах
const inScope = s => (!subFilter.map || s.map === subFilter.map) && (!subFilter.cls || s.className === subFilter.cls);
const fmtTime = ms => new Date(ms).toLocaleString('ru', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

async function loadSubs() {
  try { subs = (await api('GET', '/submissions')).submissions; } catch { return; }
  renderSubsNav();
  // список работ обновляется сам, пока ученики сдают их на уроке (но не мешаем, если учитель что-то вводит)
  if (view.section === 'subs' && !view.sub && !document.activeElement.matches('input, select, textarea')) renderSubs();
}

function renderSubsNav() {
  const fresh = subs.filter(s => s.status === 'new').length;
  fill($('#subsNav'),
    h('li', { class: 'tree-item' + (view.section === 'subs' ? ' active' : ''), onclick: openSubs },
      h('span', { class: 'tree-name' }, 'Работы учеников'),
      fresh ? h('span', { class: 'badge-new', title: 'Новые работы' }, fresh) : h('span', { class: 'count' }, subs.length)),
    h('li', { class: 'tree-item' + (view.section === 'students' ? ' active' : ''), onclick: openStudents },
      h('span', { class: 'tree-name' }, 'Ученики и пароли'),
      h('span', { class: 'count' }, roster.students.length)),
    teacher.main && h('li', { class: 'tree-item' + (view.section === 'teachers' ? ' active' : ''), onclick: openTeachers },
      h('span', { class: 'tree-name' }, 'Учителя'),
      h('span', { class: 'count' }, teachers.length || '')));
}

async function openSubs() {
  await flushSave();
  view.section = 'subs'; view.sub = null; view.map = null;
  render();
}

function openSub(id) {
  view.section = 'subs'; view.sub = id;
  render();
  window.scrollTo(0, 0);
}

function filteredSubs() {
  const q = subFilter.q.trim().toLowerCase();
  return subs.filter(s => inScope(s)
    && (subFilter.status === 'all' || s.status === subFilter.status)
    && (!q || s.name.toLowerCase().includes(q)))
    .sort((a, b) => b.submitted - a.submitted);
}

function subRow(s) {
  return h('div', { class: 'sub-row' + (s.status === 'new' ? ' is-new' : ''), onclick: () => openSub(s.id) },
    h('div', { class: 'sub-main' }, h('div', { class: 'sub-name' }, s.name, h('span', { class: 'sub-class' }, s.className)), h('div', { class: 'muted' }, s.mapTitle)),
    h('div', { class: 'muted sub-time' }, fmtTime(s.submitted), s.marks ? ` · отметок: ${s.marks}` : ' · без отметок'),
    h('div', { class: 'sub-status' },
      s.status === 'checked'
        ? h('span', { class: 'grade-pill' + (s.grade ? ' g' + s.grade : '') }, s.grade || '✓')
        : h('span', { class: 'badge warn' }, s.resubmits ? 'Исправлена' : 'Новая')));
}

function renderSubs() {
  const maps = [...new Map(subs.map(s => [s.map, s.mapTitle])).entries()].sort((a, b) => collator.compare(a[1], b[1]));
  if (subFilter.map && !maps.some(([id]) => id === subFilter.map)) subFilter.map = '';
  const classNames = [...new Set(subs.map(s => s.className))].sort((a, b) => collator.compare(a, b));
  if (subFilter.cls && !classNames.includes(subFilter.cls)) subFilter.cls = '';
  const inMap = subs.filter(inScope);
  const tabs = [['new', 'Новые'], ['checked', 'Проверенные'], ['all', 'Все']];
  const list = filteredSubs();
  const body = h('div', { class: 'sub-list' });
  const fillBody = () => {
    const l = filteredSubs();
    fill(body, l.length ? l.map(subRow) : h('p', { class: 'empty' },
      subs.length ? 'Здесь пусто' : 'Работ пока нет. Ученики отправляют их кнопкой «Сдать» на странице карты.'));
  };
  const checkedHere = inMap.filter(s => s.status === 'checked');

  fill($('#main'),
    h('div', { class: 'main-head' },
      h('h1', {}, 'Работы учеников'),
      h('input', { class: 'input', type: 'search', placeholder: 'Поиск по фамилии', value: subFilter.q, style: 'max-width:240px',
        oninput: e => { subFilter.q = e.target.value; fillBody(); } }),
      h('select', { class: 'input', style: 'width:auto;max-width:260px', onchange: e => { subFilter.map = e.target.value; renderSubs(); } },
        h('option', { value: '', selected: !subFilter.map }, 'Все карты'),
        maps.map(([id, title]) => h('option', { value: id, selected: id === subFilter.map }, title))),
      h('select', { class: 'input', style: 'width:auto', onchange: e => { subFilter.cls = e.target.value; renderSubs(); } },
        h('option', { value: '', selected: !subFilter.cls }, 'Все классы'),
        classNames.map(c => h('option', { value: c, selected: c === subFilter.cls }, c)))),
    h('div', { class: 'seg' }, tabs.map(([st, name]) => h('button', {
      type: 'button', class: 'seg-btn' + (subFilter.status === st ? ' on' : ''),
      onclick: () => { subFilter.status = st; renderSubs(); },
    }, name, ' ', h('span', { class: 'count' }, inMap.filter(s => st === 'all' || s.status === st).length)))),
    body,
    checkedHere.length > 0 && subFilter.status !== 'new' && h('button', {
      class: 'btn ghost-danger small', type: 'button', style: 'margin-top:16px', onclick: async () => {
        if (!await modal({ title: `Удалить проверенные работы (${checkedHere.length})?`, text: subFilter.map ? 'Только по выбранной карте.' : 'По всем картам.', ok: 'Удалить', danger: true })) return;
        for (const s of checkedHere) await api('DELETE', '/submissions/' + s.id).catch(() => {});
        await loadSubs(); renderSubs();
      },
    }, 'Удалить проверенные'),
  );
  fillBody();
  return list;
}

function renderReview() {
  const s = subs.find(x => x.id === view.sub);
  if (!s) { view.sub = null; renderSubs(); return; }
  const list = filteredSubs();
  const idx = list.findIndex(x => x.id === s.id);
  let grade = s.grade || '';
  const comment = h('textarea', { class: 'input', rows: 5, value: s.comment || '', maxlength: 2000, placeholder: 'Ученик увидит комментарий у себя на телефоне' });
  const gradeBox = h('div', { class: 'grades' });
  const drawGrades = () => gradeBox.replaceChildren(...['5', '4', '3', '2', ''].map(g => h('button', {
    type: 'button', class: 'grade-btn' + (grade === g ? ' on' : '') + (g ? ' g' + g : ''), onclick: () => { grade = g; drawGrades(); },
  }, g || 'Без оценки')));
  drawGrades();

  const save = async goNext => {
    const next = goNext ? (list[idx + 1] || subs.find(x => x.id !== s.id && x.status === 'new')) : null;
    await api('PATCH', '/submissions/' + s.id, { grade, comment: comment.value, status: 'checked' });
    Object.assign(s, { grade, comment: comment.value, status: 'checked' });
    renderSubsNav();
    if (!goNext) { toast('Сохранено'); render(); return; }
    if (next) openSub(next.id);
    else { toast('Все работы проверены'); view.sub = null; render(); }
  };

  fill($('#main'),
    h('div', { class: 'editor-bar' },
      h('button', { class: 'btn', type: 'button', onclick: () => { view.sub = null; render(); } }, '← К списку работ'),
      h('span', { class: 'spacer' }),
      idx >= 0 && h('button', { class: 'btn', type: 'button', disabled: idx <= 0, onclick: () => openSub(list[idx - 1].id) }, '‹ Предыдущая'),
      idx >= 0 && h('span', { class: 'muted' }, `${idx + 1} из ${list.length}`),
      idx >= 0 && h('button', { class: 'btn', type: 'button', disabled: idx >= list.length - 1, onclick: () => openSub(list[idx + 1].id) }, 'Следующая ›')),
    h('div', { class: 'review' },
      h('iframe', { class: 'review-frame', src: `${BASE}/review/${s.id}?v=${s.submitted}`, title: 'Работа ученика' }),
      h('div', { class: 'panel-box review-side' },
        h('h2', {}, s.name),
        h('div', { class: 'muted' }, s.mapTitle),
        h('div', { class: 'muted' }, 'Сдана ' + fmtTime(s.submitted) + (s.resubmits ? ` · исправлялась ${s.resubmits} раз` : '')),
        h('div', { style: 'margin:6px 0 14px' }, s.status === 'checked' ? h('span', { class: 'badge' }, 'Проверена') : h('span', { class: 'badge warn' }, 'Ждёт проверки')),
        h('div', { class: 'field' }, h('span', {}, 'Оценка'), gradeBox),
        h('label', { class: 'field' }, h('span', {}, 'Комментарий'), comment),
        h('div', { class: 'review-actions' },
          h('button', { class: 'btn primary', type: 'button', onclick: () => save(true) }, 'Сохранить и следующая'),
          h('button', { class: 'btn', type: 'button', onclick: () => save(false) }, 'Сохранить')),
        h('p', { class: 'muted', style: 'font-size:13px' }, 'Письменные ответы и условные знаки ученика — в «Заданиях» над картой.'),
        h('div', { class: 'review-actions' },
          s.status === 'checked' && h('button', { class: 'btn small', type: 'button', onclick: async () => {
            await api('PATCH', '/submissions/' + s.id, { status: 'new' });
            s.status = 'new'; renderSubsNav(); render();
          } }, 'Вернуть в «Новые»'),
          h('button', { class: 'btn small ghost-danger', type: 'button', onclick: async () => {
            if (!await modal({ title: `Удалить работу: ${s.name}?`, text: 'Работа пропадёт из админки. У ученика на телефоне она останется.', ok: 'Удалить', danger: true })) return;
            await api('DELETE', '/submissions/' + s.id);
            subs = subs.filter(x => x.id !== s.id);
            view.sub = null; render(); toast('Работа удалена');
          } }, 'Удалить работу')))),
  );
}

// ---------- ученики и классы ----------

let roster = { classes: [], students: [] };
const studentView = { cls: null };

async function loadRoster() {
  try { roster = await api('GET', '/students'); } catch { return; }
  renderSubsNav();
}

async function openStudents() {
  await flushSave();
  view.section = 'students'; view.map = null; view.sub = null;
  await loadRoster();
  render();
}

// изменение списка учеников: сервер возвращает весь список целиком
async function rosterUpdate(method, url, body) {
  roster = await api(method, url, body);
  renderStudents();
  renderSubsNav();
  loadSubs();
}

function renderStudents() {
  const classes = [...roster.classes].sort((a, b) => collator.compare(a.name, b.name));
  if (!classes.some(c => c.id === studentView.cls)) studentView.cls = classes.length ? classes[0].id : null;
  const cls = classes.find(c => c.id === studentView.cls);
  const studs = cls ? roster.students.filter(st => st.classId === cls.id).sort((a, b) => collator.compare(a.name, b.name)) : [];
  const addBox = h('textarea', { class: 'input', rows: 4, placeholder: 'Иванов Пётр\nСмирнова Анна\n…' });

  fill($('#main'),
    h('div', { class: 'main-head' },
      h('h1', {}, 'Ученики и пароли'),
      h('button', { class: 'btn primary', type: 'button', onclick: async () => {
        const res = await modal({ title: 'Новый класс', fields: [{ placeholder: 'Например: 7А' }], ok: 'Создать' });
        if (!res || !res[0]) return;
        const before = new Set(roster.classes.map(c => c.id));
        await rosterUpdate('POST', '/classes', { name: res[0] });
        const created = roster.classes.find(c => !before.has(c.id));
        if (created) { studentView.cls = created.id; renderStudents(); }
      } }, '+ Класс')),
    !cls ? h('p', { class: 'empty' }, 'Классов пока нет. Создайте класс и добавьте в него учеников — пароли создадутся сами.') : [
      h('div', { class: 'seg' }, classes.map(c => h('button', {
        type: 'button', class: 'seg-btn' + (c.id === cls.id ? ' on' : ''), onclick: () => { studentView.cls = c.id; renderStudents(); },
      }, c.name, ' ', h('span', { class: 'count' }, roster.students.filter(st => st.classId === c.id).length)))),
      h('div', { class: 'class-actions' },
        h('a', { class: 'btn', href: `${BASE}/print/${cls.id}`, target: '_blank' }, 'Печать карточек'),
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          if (!await modal({ title: `Новые пароли всему классу ${cls.name}?`, text: 'Старые пароли перестанут работать, ученикам придётся войти заново. Не забудьте распечатать новые карточки.', ok: 'Сменить', danger: true })) return;
          await rosterUpdate('POST', `/classes/${cls.id}/passwords`);
          toast('Пароли обновлены');
        } }, 'Новые пароли всем'),
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          const res = await modal({ title: 'Переименовать класс', fields: [{ value: cls.name }], ok: 'Сохранить' });
          if (res && res[0]) await rosterUpdate('PATCH', `/classes/${cls.id}`, { name: res[0] });
        } }, 'Переименовать'),
        h('button', { class: 'btn ghost-danger', type: 'button', onclick: async () => {
          if (!await modal({ title: `Удалить класс ${cls.name}?`, text: studs.length ? `Вместе с ним удалятся ученики (${studs.length}) и все их работы.` : 'В классе нет учеников.', ok: 'Удалить', danger: true })) return;
          await rosterUpdate('DELETE', `/classes/${cls.id}`);
        } }, 'Удалить класс')),
      h('div', { class: 'panel-box add-students' },
        h('b', {}, 'Добавить учеников в ' + cls.name),
        h('p', { class: 'muted' }, 'По одному в строке: фамилия и имя. Пароли из 8 символов создадутся автоматически.'),
        addBox,
        h('button', { class: 'btn primary', type: 'button', onclick: async () => {
          const names = addBox.value.split('\n').map(x => x.trim()).filter(Boolean);
          if (!names.length) { toast('Впишите хотя бы одно имя', true); return; }
          await rosterUpdate('POST', '/students', { classId: cls.id, names });
          toast(`Добавлено учеников: ${names.length}`);
        } }, 'Добавить')),
      studs.length
        ? h('div', { class: 'stud-list' }, studs.map(st => studentRow(st, classes)))
        : h('p', { class: 'empty' }, 'В классе пока нет учеников.'),
    ]);
}

function studentRow(st, classes) {
  return h('div', { class: 'stud-row' },
    h('div', { class: 'stud-name' }, st.name),
    h('code', { class: 'stud-pw', title: 'Пароль для входа' }, st.password),
    h('div', { class: 'stud-actions' },
      h('button', { class: 'btn small', type: 'button', onclick: async () => {
        if (!await modal({ title: `Новый пароль для: ${st.name}?`, text: 'Старый пароль перестанет работать.', ok: 'Сменить' })) return;
        await rosterUpdate('PATCH', `/students/${st.id}`, { newPassword: true });
      } }, 'Новый пароль'),
      h('button', { class: 'btn small', type: 'button', onclick: async () => {
        const res = await modal({ title: 'Фамилия и имя', fields: [{ value: st.name }], ok: 'Сохранить' });
        if (res && res[0]) await rosterUpdate('PATCH', `/students/${st.id}`, { name: res[0] });
      } }, 'Имя'),
      classes.length > 1 && h('select', {
        class: 'input small-select', title: 'Перевести в другой класс',
        onchange: e => rosterUpdate('PATCH', `/students/${st.id}`, { classId: e.target.value }),
      }, classes.map(c => h('option', { value: c.id, selected: c.id === st.classId }, c.name))),
      h('button', { class: 'btn small ghost-danger', type: 'button', onclick: async () => {
        if (!await modal({ title: `Удалить ученика: ${st.name}?`, text: 'Удалятся и все его работы.', ok: 'Удалить', danger: true })) return;
        await rosterUpdate('DELETE', `/students/${st.id}`);
      } }, 'Удалить')));
}

// ---------- учителя (только у главного учителя) ----------

let teachers = [];

async function openTeachers() {
  await flushSave();
  view.section = 'teachers'; view.map = null; view.sub = null;
  teachers = (await api('GET', '/teachers')).teachers;
  render();
}

// новый пароль показывается один раз — сохранить его можно только сейчас
function showPassword(title, login, password) {
  return modal({ title, text: `Логин: ${login}\nПароль: ${password}\n\nПередайте учителю логин, пароль и адрес админки (тот же, что у вас). Пароль хранится зашифрованным и больше нигде не покажется — запишите его.`, ok: 'Записал' });
}

function renderTeachers() {
  fill($('#main'),
    h('div', { class: 'main-head' },
      h('h1', {}, 'Учителя'),
      h('button', { class: 'btn primary', type: 'button', onclick: async () => {
        const res = await modal({
          title: 'Новый учитель', ok: 'Добавить',
          fields: [
            { label: 'Имя (его видят ученики)', placeholder: 'Петрова Анна Сергеевна' },
            { label: 'Логин для входа (латиницей)', placeholder: 'petrova' },
            { label: 'Пароль: придумайте или сгенерируйте', placeholder: 'от 8 символов, латиницей', generate: true },
          ],
        });
        if (!res) return;
        if (!PW_OK.test(res[2])) { toast(PW_RULE, true); return; }
        teachers = (await api('POST', '/teachers', { name: res[0], login: res[1], password: res[2] })).teachers;
        render();
        await showPassword('Учитель добавлен', res[1].trim().toLowerCase(), res[2]);
      } }, '+ Учитель')),
    h('p', { class: 'muted' }, 'У каждого учителя свои карты, классы, ученики и работы — другие учителя их не видят. Адрес админки у всех общий, логин и пароль — свои.'),
    h('div', { class: 'stud-list' }, teachers.map(t => h('div', { class: 'stud-row' },
      h('div', { class: 'stud-name' }, t.name, t.main && h('span', { class: 'sub-class' }, 'главный учитель')),
      h('code', { class: 'stud-pw', title: 'Логин' }, t.login),
      h('div', { class: 'stud-actions' },
        h('button', { class: 'btn small', type: 'button', onclick: async () => {
          const res = await modal({ title: 'Имя учителя', fields: [{ value: t.name }], ok: 'Сохранить' });
          if (!res || !res[0]) return;
          teachers = (await api('PATCH', '/teachers/' + t.id, { name: res[0] })).teachers;
          if (t.main) { teacher.name = res[0]; showTeacher(); }
          render();
        } }, 'Имя'),
        !t.main && h('button', { class: 'btn small', type: 'button', onclick: async () => {
          const res = await modal({
            title: `Новый пароль для: ${t.name}`, text: 'Старый пароль перестанет работать.', ok: 'Сменить',
            fields: [{ label: 'Новый пароль: придумайте или сгенерируйте', placeholder: 'от 8 символов, латиницей', generate: true }],
          });
          if (!res) return;
          if (!PW_OK.test(res[0])) { toast(PW_RULE, true); return; }
          teachers = (await api('PATCH', '/teachers/' + t.id, { password: res[0] })).teachers;
          await showPassword('Пароль изменён', t.login, res[0]);
        } }, 'Новый пароль'),
        !t.main && h('button', { class: 'btn small ghost-danger', type: 'button', onclick: async () => {
          if (!await modal({
            title: `Удалить учителя: ${t.name}?`,
            text: 'Вместе с ним безвозвратно удалятся все его карты, разделы, классы, ученики и их работы.',
            ok: 'Удалить навсегда', danger: true,
          })) return;
          teachers = (await api('DELETE', '/teachers/' + t.id)).teachers;
          render();
          toast('Учитель удалён');
        } }, 'Удалить'))))),
  );
}

// ---------- общее ----------

function render() {
  renderTree();
  renderSubsNav();
  $('.admin').classList.toggle('wide', view.section === 'subs' && !!view.sub);
  if (view.section === 'subs') { if (view.sub) renderReview(); else renderSubs(); }
  else if (view.section === 'students') renderStudents();
  else if (view.section === 'teachers') renderTeachers();
  else if (view.map) renderEditor();
  else renderList();
}

$('#newRootFolder').onclick = () => createFolder(null);
$('#logoutBtn').onclick = async () => { await flushSave(); await fetch(BASE + '/logout', { method: 'POST', headers: { 'X-KM': '1' } }).catch(() => {}); location.reload(); };
$('#pwdBtn').onclick = async () => {
  const res = await modal({
    title: 'Смена пароля', ok: 'Сменить',
    fields: [{ label: 'Текущий пароль', type: 'password' }, { label: 'Новый пароль (от 8 символов, латиницей)', type: 'password' }, { label: 'Повторите новый пароль', type: 'password' }],
  });
  if (!res) return;
  if (res[1] !== res[2]) { toast('Новые пароли не совпадают', true); return; }
  if (!PW_OK.test(res[1])) { toast(PW_RULE, true); return; }
  await api('POST', '/password', { current: res[0], new: res[1] });
  toast('Пароль изменён');
};

// имя учителя видят ученики при выборе класса
let teacher = { login: '', name: '' };
function showTeacher() { $('#teacherName').textContent = `${teacher.name} (логин: ${teacher.login})`; }
$('#nameBtn').onclick = async () => {
  const res = await modal({ title: 'Моё имя', text: 'Его видят ученики, когда выбирают свой класс. Например: Иванова Мария Петровна.', fields: [{ value: teacher.name }], ok: 'Сохранить' });
  if (!res || !res[0]) return;
  teacher.name = (await api('PATCH', '/me', { name: res[0] })).name;
  showTeacher();
  toast('Имя сохранено');
};

api('GET', '/state').then(async s => {
  state = s; teacher = s.teacher; showTeacher();
  if (teacher.main) teachers = (await api('GET', '/teachers')).teachers;
  render(); loadSubs(); loadRoster();
});
setInterval(loadSubs, 10000);
