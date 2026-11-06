'use strict';

const $ = s => document.querySelector(s);
const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });
let catalog = { folders: [], maps: [] };
let me = null;       // ученик, который вошёл
let summary = {};    // состояние его работ по картам: черновик, сдано, оценка

function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k);
  return e;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n} ${w}`;
}

const folderById = id => catalog.folders.find(f => f.id === id);

function folderPath(id) {
  const names = [];
  for (let f = folderById(id), i = 0; f && i < 50; f = folderById(f.parent), i++) names.unshift(f.name);
  return names.join(' / ');
}

// Значок на карточке: результат проверки, «сдано» или «есть работа»
function workBadge(id) {
  const w = summary[id];
  if (!w) return null;
  const sub = w.submission;
  if (sub && sub.status === 'checked') {
    return h('span', { class: 'badge ok' }, sub.grade ? `Проверено · оценка ${sub.grade}` : 'Проверено учителем');
  }
  if (sub) return h('span', { class: 'badge' }, w.changed ? 'Сдано, есть несданные исправления' : 'Сдано, ждёт проверки');
  if (w.draft) return h('span', { class: 'badge warn' }, 'Есть несданная работа');
  return null;
}

function card(m, showPath) {
  return h('a', { class: 'card', href: '/map/' + m.id },
    h('div', { class: 'thumb', style: `background-image:url('/img/${m.id}?v=${m.imageVersion}')` }),
    h('div', { class: 'body' },
      h('div', { class: 'title' }, m.title),
      h('div', { class: 'meta' }, [showPath && folderPath(m.folder), plural(m.taskCount, 'задание', 'задания', 'заданий')].filter(Boolean).join(' · ')),
      workBadge(m.id)));
}

const byTitle = (a, b) => collator.compare(a.title, b.title);
const childFolders = pid => catalog.folders.filter(f => (f.parent || null) === pid).sort((a, b) => collator.compare(a.name, b.name));

function countDeep(fid) {
  return catalog.maps.filter(m => m.folder === fid).length + childFolders(fid).reduce((n, f) => n + countDeep(f.id), 0);
}

function folderSection(f) {
  const total = countDeep(f.id);
  if (!total) return null;
  const maps = catalog.maps.filter(m => m.folder === f.id).sort(byTitle);
  return h('details', { class: 'section', open: true },
    h('summary', {}, f.name, h('span', { class: 'count' }, total)),
    childFolders(f.id).map(folderSection),
    maps.length > 0 && h('div', { class: 'grid' }, maps.map(m => card(m))));
}

function render() {
  const list = $('#list');
  const words = $('#search').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  list.innerHTML = '';
  if (words.length) {
    const found = catalog.maps.filter(m => {
      const hay = [m.title, m.description, folderPath(m.folder), m.search].join(' ').toLowerCase();
      return words.every(w => hay.includes(w));
    }).sort(byTitle);
    list.append(found.length ? h('div', { class: 'grid' }, found.map(m => card(m, true))) : h('p', { class: 'empty' }, 'Ничего не найдено'));
    return;
  }
  if (!catalog.maps.length) { list.append(h('p', { class: 'empty' }, 'Карт пока нет')); return; }
  const loose = catalog.maps.filter(m => !m.folder || !folderById(m.folder)).sort(byTitle);
  if (loose.length) list.append(h('div', { class: 'grid' }, loose.map(m => card(m))));
  list.append(...childFolders(null).map(folderSection).filter(Boolean));
}

$('#search').addEventListener('input', render);

// ---------- вход ученика: класс → своё имя → пароль ----------

let classes = [];
const login = { cls: null, student: null };

function rememberClass(id) {
  try { localStorage.setItem('km-class', id || ''); } catch { /* не страшно */ }
}

async function showLogin() {
  me = null;
  $('.search').hidden = true;
  $('#userBar').hidden = true;
  $('#heroText').textContent = 'Чтобы начать, найдите свой класс и себя в списке';
  const r = await fetch('/api/classes').catch(() => null);
  if (!r || !r.ok) { failed(); return; }
  classes = (await r.json()).classes;
  try {
    const last = localStorage.getItem('km-class');
    if (classes.some(c => c.id === last)) login.cls = last;
  } catch { /* хранилище недоступно */ }
  renderLogin();
}

function renderLogin() {
  const list = $('#list');
  list.replaceChildren();
  if (!classes.length) { list.append(h('p', { class: 'empty' }, 'Учитель ещё не добавил классы.')); return; }
  const cls = classes.find(c => c.id === login.cls);
  if (!cls) {
    // классы разных учителей могут называться одинаково, поэтому группируем по учителю
    const teachers = [...new Set(classes.map(c => c.teacher))];
    const classButton = c => h('button', {
      class: 'pick big', type: 'button', onclick: () => { login.cls = c.id; rememberClass(c.id); renderLogin(); },
    }, c.name);
    list.append(h('h2', { class: 'login-h' }, 'Выберите класс'),
      ...teachers.map(t => [
        teachers.length > 1 && h('div', { class: 'teacher-h' }, t),
        h('div', { class: 'pick-grid' }, classes.filter(c => c.teacher === t).map(classButton)),
      ]).flat().filter(Boolean));
    return;
  }
  if (!login.student) {
    list.append(
      h('div', { class: 'login-head' },
        h('button', { class: 'btn', type: 'button', onclick: () => { login.cls = null; rememberClass(null); renderLogin(); } }, '← Классы'),
        h('h2', { class: 'login-h' }, `${cls.name}: найдите себя`),
        classes.some(c => c.teacher !== cls.teacher) && h('span', { class: 'muted' }, cls.teacher)),
      cls.students.length
        ? h('div', { class: 'pick-list' }, cls.students.map(st => h('button', {
          class: 'pick', type: 'button', onclick: () => { login.student = st; renderLogin(); },
        }, st.name)))
        : h('p', { class: 'empty' }, 'В этом классе пока нет учеников.'));
    return;
  }
  const input = h('input', {
    class: 'input pw-input', type: 'password', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off',
    spellcheck: 'false', maxlength: 20, placeholder: '8 символов', 'aria-label': 'Пароль',
  });
  const err = h('p', { class: 'login-error' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Войти');
  const form = h('form', {
    class: 'login-card', onsubmit: async e => {
      e.preventDefault();
      err.textContent = '';
      btn.disabled = true;
      const r = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ student: login.student.id, password: input.value }),
      }).catch(() => null);
      btn.disabled = false;
      if (r && r.ok) { me = (await r.json()).student; login.student = null; showCatalog(); return; }
      err.textContent = r ? ((await r.json().catch(() => ({}))).error || 'Ошибка входа') : 'Нет связи с сервером';
      input.select();
    },
  },
    h('div', { class: 'muted' }, cls.name),
    h('h2', {}, login.student.name),
    h('label', { class: 'field' }, h('span', {}, 'Пароль с карточки'),
      h('div', { class: 'pw-row' }, input,
        h('button', { class: 'btn', type: 'button', onclick: () => { input.type = input.type === 'password' ? 'text' : 'password'; input.focus(); } }, 'Показать'))),
    err,
    h('div', { class: 'login-actions' }, btn,
      h('button', { class: 'btn', type: 'button', onclick: () => { login.student = null; renderLogin(); } }, 'Это не я')));
  list.append(form);
  input.focus();
}

async function showCatalog() {
  $('.search').hidden = false;
  $('#heroText').textContent = 'Выберите карту, чтобы начать работу';
  const bar = $('#userBar');
  bar.hidden = false;
  bar.replaceChildren(
    h('span', { class: 'user-name' }, me.name, h('span', { class: 'muted' }, ` · ${me.className}`)),
    h('button', { class: 'btn small', type: 'button', onclick: logout }, 'Выйти'));
  const [cat, sum] = await Promise.all([
    fetch('/api/catalog').then(r => r.json()),
    fetch('/api/my/summary').then(r => (r.ok ? r.json() : { maps: {} })),
  ]).catch(() => [null, null]);
  if (!cat) { failed(); return; }
  catalog = cat;
  summary = sum.maps;
  render();
}

async function logout() {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  showLogin();
}

function failed() {
  $('#list').innerHTML = '<p class="empty">Не удалось связаться с сервером. Проверьте Wi-Fi и обновите страницу.</p>';
}

fetch('/api/me')
  .then(async r => {
    if (r.ok) { me = (await r.json()).student; showCatalog(); } else showLogin();
  })
  .catch(failed);
