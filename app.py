"""Контурные карты — сервер.

Два режима:
  * локальная сеть: python app.py (или run.bat) на компьютере учителя;
  * хостинг (Beget): запускается через passenger_wsgi.py, он включает KM_HOSTING=1 и задаёт KM_PUBLIC_URL.

Учителя (у каждого свои карты, классы, ученики и работы):
    python app.py --teachers                      — список учителей
    python app.py --add-teacher ЛОГИН "Имя"       — добавить учителя (пароль создастся и покажется)
    python app.py --password ЛОГИН НОВЫЙ_ПАРОЛЬ   — сменить пароль учителя
Новый адрес админки:    python app.py --new-admin-path
Ссылка и QR-код для учеников: /link

Хранилище (папка data/):
    data/folders.json             — дерево разделов
    data/maps/<id>/meta.json      — название, раздел, задания карты
    data/maps/<id>/image.<ext>    — изображение карты
    data/students.json            — классы и ученики (с паролями для входа)
    data/works/<id ученика>/<id карты>.json — работа ученика: черновик, сданная версия, оценка
"""
import json
import os
import re
import secrets
import shutil
import socket
import string
import sys
import threading
import time
from datetime import timedelta
from pathlib import Path

from flask import Flask, jsonify, redirect, request, send_file, send_from_directory, session, abort
from itsdangerous import BadSignature, URLSafeTimedSerializer
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash, generate_password_hash

BASE = Path(__file__).resolve().parent
STATIC = BASE / 'static'
ADMIN_ASSETS = BASE / 'admin_assets'
DATA = BASE / 'data'
MAPS = DATA / 'maps'
FOLDERS_FILE = DATA / 'folders.json'
STUDENTS_FILE = DATA / 'students.json'
WORKS = DATA / 'works'
CONFIG_FILE = BASE / 'config.json'
ACCESS_FILE = BASE / 'admin_access.txt'

ID_RE = re.compile(r'[a-z0-9]{6,24}')
TASK_START = re.compile(r'^(\d{1,3})\s*[.)]\s+(.*)$')
MIME = {'jpg': 'image/jpeg', 'png': 'image/png', 'gif': 'image/gif', 'webp': 'image/webp'}
LOWER = string.ascii_lowercase + string.digits
TASK_TOOLS = ['point', 'battle', 'line', 'arrow', 'area', 'text']
PW_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'  # без похожих символов: 0/o, 1/l/i
COLOR_RE = re.compile(r'#[0-9a-fA-F]{6}')
MARK_TYPES = {'point', 'battle', 'line', 'arrow', 'area', 'text'}
LEGEND_STYLES = {'line', 'dash', 'arrow', 'area', 'point', 'battle'}
GRADES = {'', '5', '4', '3', '2'}


class ApiError(Exception):
    pass


def rand_id(n=10, alphabet=LOWER):
    return ''.join(secrets.choice(alphabet) for _ in range(n))


def read_json(path, default=None):
    try:
        return json.loads(path.read_text('utf-8'))
    except FileNotFoundError:
        return default


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), 'utf-8')
    os.replace(tmp, path)


def now_ms():
    return int(time.time() * 1000)


# ---------- конфигурация ----------

LOGIN_RE = re.compile(r'[a-z0-9_.-]{3,32}')
TEACHER_PW_RE = re.compile(r'[\x21-\x7e]{8,64}')  # латиница, цифры, знаки; без пробелов и кириллицы
TEACHER_PW_RULE = 'Пароль: от 8 символов — латинские буквы, цифры и знаки, без пробелов и русских букв'


def new_teacher(login, name, password):
    return {'id': rand_id(), 'login': login, 'name': name, 'password_hash': generate_password_hash(password)}


def load_config():
    cfg = read_json(CONFIG_FILE)
    if cfg:
        if 'teachers' not in cfg:
            # раньше учитель был один — он становится учителем с логином admin и прежним паролем
            first = {'id': rand_id(), 'login': 'admin', 'name': 'Учитель', 'password_hash': cfg.pop('password_hash')}
            cfg['teachers'] = [first]
            write_json(CONFIG_FILE, cfg)
        return cfg
    password = rand_id(12, string.ascii_letters + string.digits)
    cfg = {'admin_path': rand_id(20), 'secret_key': secrets.token_hex(32),
           'teachers': [new_teacher('admin', 'Учитель', password)]}
    write_json(CONFIG_FILE, cfg)
    ACCESS_FILE.write_text(
        'Вход в админку контурных карт\n\n'
        f'Адрес:  http://localhost:5000/{cfg["admin_path"]}\n'
        'Логин:  admin\n'
        f'Пароль: {password}\n\n'
        'Сохраните эти данные в надёжном месте и удалите этот файл.\n'
        'Сменить пароль можно в админке или командой: python app.py --password admin НОВЫЙ\n',
        'utf-8')
    return cfg


def get_teachers():
    # читается из файла каждый раз: учителей можно добавить командой, не перезапуская сайт
    return (read_json(CONFIG_FILE) or {}).get('teachers', [])


def save_teachers(teachers):
    cfg = read_json(CONFIG_FILE)
    cfg['teachers'] = teachers
    write_json(CONFIG_FILE, cfg)


def teacher_name(tid):
    return next((t['name'] for t in get_teachers() if t['id'] == tid), '')


# ---------- хранилище ----------

def get_folders():
    return read_json(FOLDERS_FILE, [])


def save_folders(folders):
    write_json(FOLDERS_FILE, folders)


def folder_descendants(folders, fid):
    result = {fid}
    changed = True
    while changed:
        changed = False
        for f in folders:
            if f.get('parent') in result and f['id'] not in result:
                result.add(f['id'])
                changed = True
    return result


def map_dir(mid):
    if not ID_RE.fullmatch(mid or ''):
        abort(404)
    return MAPS / mid


def load_map(mid):
    meta = read_json(map_dir(mid) / 'meta.json')
    if meta is None:
        abort(404)
    return meta


def save_map(meta):
    meta['updated'] = now_ms()
    write_json(MAPS / meta['id'] / 'meta.json', meta)


def all_maps():
    if not MAPS.exists():
        return []
    maps = [read_json(d / 'meta.json') for d in MAPS.iterdir() if d.is_dir()]
    return sorted((m for m in maps if m), key=lambda m: m.get('created', 0))


def detect_image(head):
    if head.startswith(b'\xff\xd8\xff'):
        return 'jpg'
    if head.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'png'
    if head[:6] in (b'GIF87a', b'GIF89a'):
        return 'gif'
    if head[:4] == b'RIFF' and head[8:12] == b'WEBP':
        return 'webp'
    return None


def store_image(mid, file):
    if file is None:
        raise ApiError('Не выбрано изображение')
    data = file.read()
    ext = detect_image(data[:12])
    if not ext:
        raise ApiError('Нужна картинка в формате JPG, PNG, GIF или WebP')
    d = MAPS / mid
    d.mkdir(parents=True, exist_ok=True)
    for old in d.glob('image.*'):
        old.unlink()
    (d / f'image.{ext}').write_bytes(data)
    return f'image.{ext}'


def image_response(meta):
    path = MAPS / meta['id'] / meta['image']
    if not path.exists():
        abort(404)
    return send_file(path, mimetype=MIME[path.suffix[1:]], max_age=30 * 86400)


def parse_tasks(text):
    """Делит текст на задания по строкам вида «1. …» или «1) …»."""
    tasks = []
    for raw in text.replace('\r', '').split('\n'):
        line = raw.strip().lstrip('﻿')
        if not line:
            continue
        m = TASK_START.match(line)
        if m or not tasks:
            tasks.append(m.group(2) if m else line)
        else:
            tasks[-1] += '\n' + line
    return [{'id': rand_id(8), 'text': t.strip(), 'answer': '?' in t} for t in tasks]


def clean_tasks(raw):
    if not isinstance(raw, list):
        raise ApiError('Неверный список заданий')
    tasks = []
    for t in raw[:200]:
        if not isinstance(t, dict):
            continue
        tid = str(t.get('id') or '')
        if not ID_RE.fullmatch(tid):
            tid = rand_id(8)
        task = {'id': tid, 'text': str(t.get('text') or '')[:5000], 'answer': bool(t.get('answer'))}
        if isinstance(t.get('tools'), list):
            task['tools'] = [x for x in TASK_TOOLS if x in t['tools']]
        tasks.append(task)
    return tasks


def clean_folder_ref(value):
    """Раздел из запроса учителя: только его собственный (или «без раздела»)."""
    if not value:
        return None
    if value not in {f['id'] for f in my_folders()}:
        raise ApiError('Раздел не найден')
    return value


def new_map(title, folder, owner):
    mid = rand_id()
    ts = now_ms()
    return {'id': mid, 'owner': owner, 'title': title, 'folder': folder, 'description': '', 'published': False,
            'tasks': [], 'image': None, 'imageVersion': ts, 'created': ts, 'updated': ts}


def seed():
    """При первом запуске добавляет тестовую карту из корня проекта."""
    if DATA.exists():
        return
    MAPS.mkdir(parents=True)
    img, txt = BASE / 'image021.jpg', BASE / 'задания.txt'
    if not img.exists():
        save_folders([])
        return
    owner = get_teachers()[0]['id']
    fid = rand_id()
    save_folders([{'id': fid, 'owner': owner, 'name': '7 класс', 'parent': None}])
    meta = new_map('Ливонская война (1558–1583)', fid, owner)
    (MAPS / meta['id']).mkdir()
    shutil.copyfile(img, MAPS / meta['id'] / 'image.jpg')
    meta['image'] = 'image.jpg'
    meta['published'] = True
    if txt.exists():
        meta['tasks'] = parse_tasks(txt.read_text('utf-8-sig'))
    save_map(meta)


# ---------- приложение ----------

CFG = load_config()
ADMIN = '/' + CFG['admin_path']

# На хостинге сайт работает за прокси, на школьном компьютере — напрямую
HOSTING = os.environ.get('KM_HOSTING') == '1'
# HTTPS включается в passenger_wsgi.py; пока его нет, cookie приходится разрешать и по http
HTTPS = HOSTING and os.environ.get('KM_HTTPS', '1') == '1'
PUBLIC_URL = os.environ.get('KM_PUBLIC_URL', '').rstrip('/')

app = Flask(__name__, static_folder=str(STATIC), static_url_path='/static')
if HOSTING:
    # настоящий адрес посетителя и протокол берутся из заголовков прокси хостинга
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1)
app.config.update(
    SECRET_KEY=CFG['secret_key'],
    SESSION_COOKIE_PATH=ADMIN,  # cookie админки не отправляется на публичные страницы
    SESSION_COOKIE_SECURE=HTTPS,  # по HTTPS cookie передаются только по защищённому соединению
    SESSION_COOKIE_SAMESITE='Strict',
    SESSION_COOKIE_HTTPONLY=True,
    PERMANENT_SESSION_LIFETIME=timedelta(hours=12),
    MAX_CONTENT_LENGTH=25 * 1024 * 1024,
)

NOT_FOUND_HTML = ('<!doctype html><meta charset="utf-8"><title>Не найдено</title>'
                  '<p style="font-family:sans-serif;padding:2em">Страница не найдена. '
                  '<a href="/">На главную</a></p>')


@app.errorhandler(404)
@app.errorhandler(405)
def not_found(_e):
    return NOT_FOUND_HTML, 404


@app.errorhandler(401)
def need_login(_e):
    return jsonify(error='Нужно войти заново'), 401


@app.errorhandler(413)
def too_large(_e):
    return jsonify(error='Файл слишком большой (максимум 25 МБ)'), 413


@app.errorhandler(ApiError)
def api_error(e):
    return jsonify(error=str(e)), 400


@app.after_request
def security_headers(resp):
    if '/api/' in request.path:
        resp.headers['Cache-Control'] = 'no-store'
    resp.headers.setdefault('X-Content-Type-Options', 'nosniff')
    resp.headers.setdefault('X-Frame-Options', 'SAMEORIGIN')
    # адрес админки не должен уходить другим сайтам через Referer
    admin = request.path == ADMIN or request.path.startswith(ADMIN + '/')
    resp.headers['Referrer-Policy'] = 'no-referrer' if admin else 'same-origin'
    return resp


@app.get('/robots.txt')
def robots():
    return app.response_class('User-agent: *\nDisallow:\n', mimetype='text/plain')


# ---------- публичная часть ----------

@app.get('/')
def index():
    return send_from_directory(STATIC, 'index.html', max_age=0)


@app.get('/map/<mid>')
def map_page(mid):
    st = current_student()
    if not st:
        return redirect('/')
    student_map(st, mid)
    return send_from_directory(STATIC, 'map.html', max_age=0)


@app.get('/api/catalog')
def catalog():
    owner = student_teacher(require_student())
    maps = [{
        'id': m['id'], 'title': m['title'], 'folder': m.get('folder'),
        'description': m.get('description', ''), 'taskCount': len(m.get('tasks', [])),
        'imageVersion': m.get('imageVersion'),
        'search': ' '.join(t['text'] for t in m.get('tasks', [])),
    } for m in all_maps() if m.get('owner') == owner and m.get('published') and m.get('image')]
    return jsonify(folders=[f for f in get_folders() if f.get('owner') == owner], maps=maps)


def student_view(m):
    return {k: m.get(k) for k in ('id', 'title', 'description', 'tasks', 'imageVersion')}


@app.get('/api/maps/<mid>')
def public_map(mid):
    return jsonify(student_view(student_map(require_student(), mid)))


@app.get('/img/<mid>')
def public_image(mid):
    m = student_map(require_student(), mid)
    if not m.get('image'):
        abort(404)
    return image_response(m)


# ---------- ученики и вход ----------

STUDENT_COOKIE = 'km_s'
STUDENT_SESSION_DAYS = 200
class DataLock:
    """Чтение-изменение-запись списка учеников и работ — по очереди.

    На хостинге сайт может работать в нескольких процессах, поэтому кроме блокировки
    между потоками берётся ещё и файловая блокировка (fcntl есть только в Linux).
    """

    def __init__(self):
        self._threads = threading.Lock()
        self._file = None

    def __enter__(self):
        self._threads.acquire()
        try:
            import fcntl
        except ImportError:
            return self
        DATA.mkdir(parents=True, exist_ok=True)
        self._file = open(DATA / '.lock', 'a')
        fcntl.flock(self._file, fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        if self._file:
            self._file.close()  # закрытие файла снимает блокировку
            self._file = None
        self._threads.release()


LOCK = DataLock()
STUDENT_FAILS = {}  # ip или id ученика -> (число неудач, заблокирован до)
signer = URLSafeTimedSerializer(CFG['secret_key'], salt='km-student')


def new_password():
    return ''.join(secrets.choice(PW_ALPHABET) for _ in range(8))


def natural(text):
    """Ключ сортировки, при котором «7А» идёт раньше «10А»."""
    return [int(p) if p.isdigit() else p.lower() for p in re.split(r'(\d+)', text)]


def get_roster():
    return read_json(STUDENTS_FILE, {'classes': [], 'students': []})


def save_roster(roster):
    write_json(STUDENTS_FILE, roster)


def find_student(roster, sid):
    return next((s for s in roster['students'] if s['id'] == sid), None)


def class_name(roster, cid):
    return next((c['name'] for c in roster['classes'] if c['id'] == cid), '')


def class_owner(roster, cid):
    return next((c.get('owner') for c in roster['classes'] if c['id'] == cid), None)


def student_public(roster, st):
    return {'id': st['id'], 'name': st['name'], 'className': class_name(roster, st['classId']),
            'teacher': teacher_name(class_owner(roster, st['classId']))}


def student_teacher(st):
    return class_owner(get_roster(), st['classId'])


def student_map(st, mid):
    """Карта, доступная ученику: опубликована и принадлежит его учителю."""
    meta = load_map(mid)
    if not meta.get('published') or meta.get('owner') != student_teacher(st):
        abort(404)
    return meta


def current_student():
    token = request.cookies.get(STUDENT_COOKIE)
    if not token:
        return None
    try:
        data = signer.loads(token, max_age=STUDENT_SESSION_DAYS * 86400)
    except BadSignature:
        return None
    st = find_student(get_roster(), data.get('s'))
    # смена пароля учителем завершает все прежние входы ученика
    return st if st and st.get('ver', 0) == data.get('v') else None


def require_student():
    st = current_student()
    if not st:
        abort(401)
    return st


def login_blocked(key):
    return STUDENT_FAILS.get(key, (0, 0))[1] > time.time()


def login_failed(key, limit=10, pause=300):
    fails = STUDENT_FAILS.get(key, (0, 0))[0] + 1
    STUDENT_FAILS[key] = (0, time.time() + pause) if fails >= limit else (fails, 0)


@app.get('/api/classes')
def public_classes():
    roster = get_roster()
    teachers = {t['id']: t['name'] for t in get_teachers()}
    classes = [c for c in roster['classes'] if c.get('owner') in teachers]
    return jsonify(classes=[{
        'id': c['id'], 'name': c['name'], 'teacher': teachers[c['owner']],
        'students': sorted(({'id': s['id'], 'name': s['name']} for s in roster['students'] if s['classId'] == c['id']),
                           key=lambda s: natural(s['name'])),
    } for c in sorted(classes, key=lambda c: (natural(teachers[c['owner']]), natural(c['name'])))])


@app.post('/api/login')
def student_login():
    body = request.get_json(silent=True) or {}
    sid = str(body.get('student') or '')
    password = str(body.get('password') or '').strip().lower()
    ip = request.remote_addr
    if login_blocked(ip) or login_blocked(sid):
        raise ApiError('Слишком много неудачных попыток. Подождите 5 минут.')
    roster = get_roster()
    st = find_student(roster, sid)
    if not st or not secrets.compare_digest(st['password'].encode(), password.encode()):
        # с одного адреса заходит весь класс (школьная сеть), поэтому строго — только по ученику
        login_failed(ip, limit=60)
        login_failed(sid)
        time.sleep(0.5)
        raise ApiError('Неверный пароль')
    STUDENT_FAILS.pop(ip, None)
    STUDENT_FAILS.pop(sid, None)
    resp = jsonify(student=student_public(roster, st))
    resp.set_cookie(STUDENT_COOKIE, signer.dumps({'s': st['id'], 'v': st.get('ver', 0)}),
                    max_age=STUDENT_SESSION_DAYS * 86400, httponly=True, samesite='Lax', path='/', secure=HTTPS)
    return resp


@app.post('/api/logout')
def student_logout():
    resp = jsonify(ok=True)
    resp.delete_cookie(STUDENT_COOKIE, path='/')
    return resp


@app.get('/api/me')
def student_me():
    return jsonify(student=student_public(get_roster(), require_student()))


# ---------- работы учеников: черновик хранится на сервере, сдача фиксирует копию ----------

def work_path(sid, mid):
    if not ID_RE.fullmatch(sid or '') or not ID_RE.fullmatch(mid or ''):
        abort(404)
    return WORKS / sid / f'{mid}.json'


def num(v, lo=-1e6, hi=1e6):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v:
        raise ApiError('Повреждённые данные работы')
    return round(min(hi, max(lo, float(v))), 1)


def clean_work(raw):
    """Проверяет присланную работу: только известные поля и разумные размеры."""
    if not isinstance(raw, dict):
        raise ApiError('Повреждённые данные работы')

    def as_list(v, limit):
        return v[:limit] if isinstance(v, list) else []

    marks = []
    for m in as_list(raw.get('marks'), 1500):
        if not isinstance(m, dict) or m.get('t') not in MARK_TYPES:
            continue
        mark = {'t': m['t'], 'task': str(m.get('task') or '')[:24],
                'c': m['c'] if isinstance(m.get('c'), str) and COLOR_RE.fullmatch(m['c']) else '#d62828'}
        try:
            if m['t'] in ('line', 'arrow', 'area'):
                pts = [[num(p[0]), num(p[1])] for p in as_list(m.get('p'), 5000) if isinstance(p, list) and len(p) == 2]
                if len(pts) < 2:
                    continue
                mark.update(p=pts, w=num(m.get('w', 3), 0.5, 100), d=bool(m.get('d')))
            else:
                mark.update(x=num(m.get('x')), y=num(m.get('y')), label=str(m.get('label') or '')[:200])
        except ApiError:
            continue  # испорченную отметку пропускаем, остальная работа сохраняется
        marks.append(mark)
    legend = [{'c': i['c'] if isinstance(i.get('c'), str) and COLOR_RE.fullmatch(i['c']) else '#d62828',
               's': i.get('s') if i.get('s') in LEGEND_STYLES else 'line',
               'text': str(i.get('text') or '')[:120]}
              for i in as_list(raw.get('legend'), 60) if isinstance(i, dict)]
    answers = raw.get('answers') if isinstance(raw.get('answers'), dict) else {}
    done = raw.get('done') if isinstance(raw.get('done'), dict) else {}
    return {'marks': marks, 'legend': legend,
            'answers': {str(k)[:24]: str(v)[:5000] for k, v in list(answers.items())[:200]},
            'done': {str(k)[:24]: bool(v) for k, v in list(done.items())[:200]}}


def submission_info(rec):
    if not rec or not rec.get('submittedAt'):
        return None
    return {'at': rec['submittedAt'], 'status': rec.get('status', 'new'), 'grade': rec.get('grade', ''),
            'comment': rec.get('comment', ''), 'checked': rec.get('checked')}


def changed_since_submit(rec):
    return bool(rec and rec.get('submittedAt') and rec.get('draftUpdated', 0) > rec['submittedAt'])


@app.get('/api/my/summary')
def my_summary():
    st = require_student()
    maps = {}
    for f in (WORKS / st['id']).glob('*.json'):
        rec = read_json(f) or {}
        draft = rec.get('draft') or {}
        maps[f.stem] = {'draft': bool(draft.get('marks') or any(draft.get('answers', {}).values())),
                        'submission': submission_info(rec), 'changed': changed_since_submit(rec)}
    return jsonify(maps=maps)


@app.get('/api/my/maps/<mid>')
def my_work(mid):
    st = require_student()
    student_map(st, mid)
    rec = read_json(work_path(st['id'], mid)) or {}
    return jsonify(student=student_public(get_roster(), st), draft=rec.get('draft'),
                   draftUpdated=rec.get('draftUpdated', 0), draftImageVersion=rec.get('draftImageVersion'),
                   submission=submission_info(rec), changed=changed_since_submit(rec))


@app.put('/api/my/maps/<mid>/draft')
def my_save_draft(mid):
    st = require_student()
    meta = student_map(st, mid)
    work = clean_work((request.get_json(silent=True) or {}).get('work'))
    path = work_path(st['id'], mid)
    with LOCK:
        rec = read_json(path) or {'map': mid, 'student': st['id']}
        rec.update(draft=work, draftUpdated=now_ms(), draftImageVersion=meta.get('imageVersion'))
        write_json(path, rec)
    return jsonify(updated=rec['draftUpdated'], changed=changed_since_submit(rec))


@app.post('/api/my/maps/<mid>/submit')
def my_submit(mid):
    st = require_student()
    meta = student_map(st, mid)
    work = clean_work((request.get_json(silent=True) or {}).get('work'))
    path = work_path(st['id'], mid)
    roster = get_roster()
    with LOCK:
        rec = read_json(path) or {'map': mid, 'student': st['id']}
        if now_ms() - rec.get('submittedAt', 0) < 3000:
            raise ApiError('Работа только что отправлена — подождите пару секунд')
        ts = now_ms()
        rec.update(
            draft=work, draftUpdated=ts, draftImageVersion=meta.get('imageVersion'),
            submitted=work, submittedAt=ts, imageVersion=meta.get('imageVersion'), status='new',
            name=st['name'], className=class_name(roster, st['classId']),
            resubmits=rec.get('resubmits', -1) + 1 if rec.get('submittedAt') else 0,
        )  # оценка за прошлую версию остаётся, чтобы учитель видел, что уже ставил
        write_json(path, rec)
    return jsonify(submission=submission_info(rec))


@app.get('/api/my/maps/<mid>/status')
def my_status(mid):
    st = require_student()
    rec = read_json(work_path(st['id'], mid))
    return jsonify(submission=submission_info(rec), changed=changed_since_submit(rec))


def migrate_owners():
    """Карты, разделы и классы без владельца (созданные до появления нескольких учителей) — первому учителю."""
    owner = get_teachers()[0]['id']
    with LOCK:
        folders = get_folders()
        if any('owner' not in f for f in folders):
            save_folders([dict(f, owner=f.get('owner', owner)) for f in folders])
        for m in all_maps():
            if 'owner' not in m:
                m['owner'] = owner
                write_json(MAPS / m['id'] / 'meta.json', m)
        roster = get_roster()
        if any('owner' not in c for c in roster['classes']):
            for c in roster['classes']:
                c.setdefault('owner', owner)
            save_roster(roster)


def migrate_old_submissions():
    """Работы, сданные до появления учеников (по номеру телефона), переносятся в общее хранилище."""
    old = DATA / 'submissions'
    if not old.exists():
        return
    for f in old.glob('*/*.json'):
        s = read_json(f)
        if not s or not ID_RE.fullmatch(s.get('device', '')):
            continue
        write_json(WORKS / s['device'] / f"{s['map']}.json", {
            'map': s['map'], 'student': s['device'], 'submitted': s['work'], 'submittedAt': s['submitted'],
            'imageVersion': s.get('imageVersion'), 'status': s.get('status', 'new'), 'grade': s.get('grade', ''),
            'comment': s.get('comment', ''), 'checked': s.get('checked'), 'resubmits': s.get('resubmits', 0),
            'name': s['name'], 'className': '',
        })
    shutil.rmtree(old)


# ---------- админка (только по секретному адресу) ----------

LOGIN_FAILS = {}  # ip -> (число неудач, заблокирован до)


def current_teacher():
    tid = session.get('teacher')
    return next((t for t in get_teachers() if t['id'] == tid), None) if tid else None


def is_admin():
    return current_teacher() is not None


def me_id():
    teacher = current_teacher()
    if not teacher:
        abort(404)
    return teacher['id']


def my_folders():
    me = me_id()
    return [f for f in get_folders() if f.get('owner') == me]


def own_map(mid):
    meta = load_map(mid)
    if meta.get('owner') != me_id():
        abort(404)
    return meta


def own_folder(folders, fid):
    folder = next((f for f in folders if f['id'] == fid and f.get('owner') == me_id()), None)
    if not folder:
        abort(404)
    return folder


def record_owner(roster, rec):
    st = find_student(roster, rec['student'])
    if st:
        return class_owner(roster, st['classId'])
    meta = read_json(MAPS / rec['map'] / 'meta.json') or {}  # старая работа без ученика — по владельцу карты
    return meta.get('owner')


def own_record(mid, sid):
    rec = read_json(work_path(sid, mid))
    if not rec or not rec.get('submittedAt'):
        abort(404)
    rec.setdefault('student', sid)
    rec.setdefault('map', mid)
    if record_owner(get_roster(), rec) != me_id():
        abort(404)
    return rec


def admin_html(name, **values):
    html = (ADMIN_ASSETS / name).read_text('utf-8')
    for key, value in values.items():
        html = html.replace('{{' + key + '}}', value)
    resp = app.response_class(html, mimetype='text/html')
    resp.headers['Cache-Control'] = 'no-store'
    resp.headers['X-Robots-Tag'] = 'noindex, nofollow'
    return resp


@app.before_request
def guard_admin_api():
    path = request.path
    if path.startswith(ADMIN + '/') and not path.startswith(ADMIN + '/assets/'):
        if not is_admin():
            abort(404)
        if request.method != 'GET' and request.headers.get('X-KM') != '1':
            abort(404)


@app.route(ADMIN, methods=['GET', 'POST'])
def admin_home():
    if request.method == 'POST':
        ip = request.remote_addr
        fails, until = LOGIN_FAILS.get(ip, (0, 0))
        if until > time.time():
            return admin_html('login.html', error='<p class="login-error">Слишком много попыток, подождите</p>')
        login = request.form.get('login', '').strip().lower()
        teacher = next((t for t in get_teachers() if t['login'] == login), None)
        if teacher and check_password_hash(teacher['password_hash'], request.form.get('password', '')):
            LOGIN_FAILS.pop(ip, None)
            session.clear()
            session['teacher'] = teacher['id']
            session.permanent = True
            return redirect(ADMIN)
        fails += 1
        LOGIN_FAILS[ip] = (0, time.time() + 600) if fails >= 5 else (fails, 0)
        time.sleep(1)
        return admin_html('login.html', error='<p class="login-error">Неверный логин или пароль</p>')
    if is_admin():
        return admin_html('admin.html', base=ADMIN)
    return admin_html('login.html', error='')


@app.get(ADMIN + '/assets/<name>')
def admin_asset(name):
    if not is_admin() or not re.fullmatch(r'[a-z]+\.(js|css)', name):
        abort(404)
    resp = send_from_directory(ADMIN_ASSETS, name, max_age=0)
    resp.headers['Cache-Control'] = 'no-store'
    return resp


@app.post(ADMIN + '/logout')
def admin_logout():
    session.clear()
    return jsonify(ok=True)


@app.get(ADMIN + '/img/<mid>')
def admin_image(mid):
    m = own_map(mid)
    if not m.get('image'):
        abort(404)
    return image_response(m)


@app.get(ADMIN + '/preview/<mid>')
def admin_preview(mid):
    own_map(mid)
    return map_page_for_admin(mid)


@app.get(ADMIN + '/review/<mid>/<sid>')
def admin_review_page(mid, sid):
    rec = own_record(mid, sid)
    st = find_student(get_roster(), sid)
    return map_page_for_admin(mid, review={'name': st['name'] if st else rec.get('name', ''),
                                           'work': rec['submitted'], 'imageVersion': rec.get('imageVersion')})


def map_page_for_admin(mid, review=None):
    cfg = {'api': ADMIN + '/api/maps/', 'img': ADMIN + '/img/', 'back': ADMIN, 'mapId': mid, 'review': review}
    # «<» экранируется, чтобы текст ученика не мог закрыть тег <script>
    cfg_js = json.dumps(cfg, ensure_ascii=False).replace('<', '\\u003c')
    html = (STATIC / 'map.html').read_text('utf-8').replace(
        '<script src="/static/map.js">', f'<script>window.KM_PREVIEW={cfg_js}</script><script src="/static/map.js">')
    resp = app.response_class(html, mimetype='text/html')
    resp.headers['Cache-Control'] = 'no-store'
    return resp


def all_records():
    recs = []
    for f in WORKS.glob('*/*.json'):
        rec = read_json(f)
        if rec:
            rec.setdefault('student', f.parent.name)
            rec.setdefault('map', f.stem)
            recs.append(rec)
    return recs


@app.get(ADMIN + '/api/submissions')
def admin_submissions():
    me = me_id()
    titles = {m['id']: m['title'] for m in all_maps()}
    roster = get_roster()
    out = []
    for r in all_records():
        if not r.get('submittedAt') or record_owner(roster, r) != me:
            continue
        st = find_student(roster, r['student'])
        out.append({
            'id': f"{r['map']}/{r['student']}", 'map': r['map'], 'mapTitle': titles.get(r['map'], 'Удалённая карта'),
            'name': st['name'] if st else r.get('name', '—'), 'classId': st['classId'] if st else '',
            'className': class_name(roster, st['classId']) if st else (r.get('className') or 'без класса'),
            'submitted': r['submittedAt'], 'status': r.get('status', 'new'), 'grade': r.get('grade', ''),
            'comment': r.get('comment', ''), 'resubmits': r.get('resubmits', 0),
            'marks': len((r.get('submitted') or {}).get('marks', [])),
        })
    return jsonify(submissions=out)


@app.patch(ADMIN + '/api/submissions/<mid>/<sid>')
def admin_grade(mid, sid):
    own_record(mid, sid)
    path = work_path(sid, mid)
    body = request.get_json(silent=True) or {}
    with LOCK:
        rec = read_json(path)
        if not rec or not rec.get('submittedAt'):
            abort(404)
        if 'grade' in body:
            if str(body['grade']) not in GRADES:
                raise ApiError('Неизвестная оценка')
            rec['grade'] = str(body['grade'])
        if 'comment' in body:
            rec['comment'] = str(body['comment'] or '')[:2000]
        if body.get('status') in ('new', 'checked'):
            rec['status'] = body['status']
            rec['checked'] = now_ms() if body['status'] == 'checked' else None
        write_json(path, rec)
    return jsonify(ok=True)


@app.delete(ADMIN + '/api/submissions/<mid>/<sid>')
def admin_delete_submission(mid, sid):
    own_record(mid, sid)
    path = work_path(sid, mid)
    with LOCK:
        rec = read_json(path)
        if not rec or not rec.get('submittedAt'):
            abort(404)
        # убирается только сданная версия; черновик ученика остаётся у него
        for key in ('submitted', 'submittedAt', 'imageVersion', 'status', 'grade', 'comment', 'checked', 'resubmits', 'name', 'className'):
            rec.pop(key, None)
        if rec.get('draft'):
            write_json(path, rec)
        else:
            path.unlink()
    return jsonify(ok=True)


# ---------- админка: классы и ученики ----------

def clean_name(value, what):
    name = ' '.join(str(value or '').split())[:80]
    if not name:
        raise ApiError(f'Введите {what}')
    return name


def roster_or_404(roster, cid):
    """Класс должен принадлежать учителю, который вошёл."""
    if not any(c['id'] == cid and c.get('owner') == me_id() for c in roster['classes']):
        abort(404)


def mine(roster):
    """Классы и ученики только этого учителя."""
    me = me_id()
    classes = [c for c in roster['classes'] if c.get('owner') == me]
    ids = {c['id'] for c in classes}
    return {'classes': classes, 'students': [st for st in roster['students'] if st['classId'] in ids]}


def own_student(roster, sid):
    st = find_student(roster, sid)
    if not st:
        abort(404)
    roster_or_404(roster, st['classId'])
    return st


@app.get(ADMIN + '/api/students')
def admin_students():
    return jsonify(mine(get_roster()))


@app.post(ADMIN + '/api/classes')
def admin_class_create():
    name = clean_name((request.get_json(silent=True) or {}).get('name'), 'название класса')
    with LOCK:
        roster = get_roster()
        roster['classes'].append({'id': rand_id(), 'owner': me_id(), 'name': name})
        save_roster(roster)
    return jsonify(mine(roster))


@app.patch(ADMIN + '/api/classes/<cid>')
def admin_class_rename(cid):
    name = clean_name((request.get_json(silent=True) or {}).get('name'), 'название класса')
    with LOCK:
        roster = get_roster()
        roster_or_404(roster, cid)
        next(c for c in roster['classes'] if c['id'] == cid)['name'] = name
        save_roster(roster)
    return jsonify(mine(roster))


@app.delete(ADMIN + '/api/classes/<cid>')
def admin_class_delete(cid):
    with LOCK:
        roster = get_roster()
        roster_or_404(roster, cid)
        for st in roster['students']:
            if st['classId'] == cid:
                shutil.rmtree(WORKS / st['id'], ignore_errors=True)
        roster['students'] = [s for s in roster['students'] if s['classId'] != cid]
        roster['classes'] = [c for c in roster['classes'] if c['id'] != cid]
        save_roster(roster)
    return jsonify(mine(roster))


@app.post(ADMIN + '/api/classes/<cid>/passwords')
def admin_class_passwords(cid):
    with LOCK:
        roster = get_roster()
        roster_or_404(roster, cid)
        for st in roster['students']:
            if st['classId'] == cid:
                st['password'] = new_password()
                st['ver'] = st.get('ver', 0) + 1
        save_roster(roster)
    return jsonify(mine(roster))


@app.post(ADMIN + '/api/students')
def admin_students_add():
    body = request.get_json(silent=True) or {}
    names = [' '.join(str(n).split())[:80] for n in (body.get('names') or [])[:200] if str(n).strip()]
    if not names:
        raise ApiError('Впишите хотя бы одно имя')
    with LOCK:
        roster = get_roster()
        roster_or_404(roster, body.get('classId'))
        for name in names:
            roster['students'].append({'id': rand_id(), 'classId': body['classId'], 'name': name,
                                       'password': new_password(), 'ver': 0})
        save_roster(roster)
    return jsonify(mine(roster))


@app.patch(ADMIN + '/api/students/<sid>')
def admin_student_update(sid):
    body = request.get_json(silent=True) or {}
    with LOCK:
        roster = get_roster()
        st = own_student(roster, sid)
        if 'name' in body:
            st['name'] = clean_name(body['name'], 'имя ученика')
        if 'classId' in body:
            roster_or_404(roster, body['classId'])
            st['classId'] = body['classId']
        if body.get('newPassword'):
            st['password'] = new_password()
            st['ver'] = st.get('ver', 0) + 1
        save_roster(roster)
    return jsonify(mine(roster))


@app.delete(ADMIN + '/api/students/<sid>')
def admin_student_delete(sid):
    with LOCK:
        roster = get_roster()
        own_student(roster, sid)
        roster['students'] = [s for s in roster['students'] if s['id'] != sid]
        save_roster(roster)
        shutil.rmtree(WORKS / sid, ignore_errors=True)
    return jsonify(mine(roster))


@app.get(ADMIN + '/print/<cid>')
def admin_print_cards(cid):
    """Лист с карточками для входа: учитель печатает, разрезает и раздаёт."""
    from html import escape
    roster = get_roster()
    roster_or_404(roster, cid)
    cname = class_name(roster, cid)
    url = (student_urls() or ['спросите адрес у учителя'])[0]
    students = sorted((s for s in roster['students'] if s['classId'] == cid), key=lambda s: natural(s['name']))
    cards = ''.join(f"""<div class="card"><div class="site">Контурные карты · {escape(url)}</div>
<div class="who">{escape(s['name'])}</div><div class="cls">Класс: {escape(cname)}</div>
<div class="pw">Пароль: <b>{escape(s['password'])}</b></div></div>""" for s in students)
    html = f"""<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Карточки — {escape(cname)}</title>
<style>
body {{ font-family: system-ui, "Segoe UI", Roboto, sans-serif; margin: 16px; color: #111; }}
.bar {{ display: flex; gap: 12px; align-items: center; margin-bottom: 16px; }}
button {{ font: inherit; padding: 8px 18px; border-radius: 8px; border: 1px solid #1f6fb2; background: #1f6fb2; color: #fff; cursor: pointer; }}
.grid {{ display: grid; grid-template-columns: repeat(3, 1fr); }}
.card {{ border: 1px dashed #888; padding: 12px 14px; break-inside: avoid; page-break-inside: avoid; }}
.site {{ font-size: 11px; color: #555; }}
.who {{ font-size: 17px; font-weight: 700; margin-top: 6px; }}
.cls {{ font-size: 13px; color: #333; }}
.pw {{ margin-top: 8px; font-size: 14px; }}
.pw b {{ font-family: Consolas, "Courier New", monospace; font-size: 20px; letter-spacing: .08em; }}
@media print {{ .bar {{ display: none; }} body {{ margin: 0; }} }}
</style></head><body>
<div class="bar"><button onclick="window.print()">Печать</button><span>Класс {escape(cname)}: {len(students)} учеников. Распечатайте и разрежьте по пунктиру.</span></div>
<div class="grid">{cards or '<p>В классе пока нет учеников.</p>'}</div></body></html>"""
    resp = app.response_class(html, mimetype='text/html')
    resp.headers['Cache-Control'] = 'no-store'
    return resp


@app.get(ADMIN + '/api/state')
def admin_state():
    me = me_id()
    return jsonify(folders=my_folders(), maps=[m for m in all_maps() if m.get('owner') == me],
                   teacher={'login': current_teacher()['login'], 'name': current_teacher()['name'], 'main': is_main()})


@app.get(ADMIN + '/api/maps/<mid>')
def admin_map(mid):
    return jsonify(student_view(own_map(mid)))


@app.post(ADMIN + '/api/folders')
def folder_create():
    body = request.get_json(silent=True) or {}
    name = str(body.get('name') or '').strip()[:120]
    if not name:
        raise ApiError('Введите название раздела')
    folder = {'id': rand_id(), 'owner': me_id(), 'name': name, 'parent': clean_folder_ref(body.get('parent'))}
    save_folders(get_folders() + [folder])
    return jsonify(folder)


@app.patch(ADMIN + '/api/folders/<fid>')
def folder_update(fid):
    body = request.get_json(silent=True) or {}
    folders = get_folders()
    folder = own_folder(folders, fid)
    if 'name' in body:
        name = str(body['name'] or '').strip()[:120]
        if not name:
            raise ApiError('Введите название раздела')
        folder['name'] = name
    if 'parent' in body:
        parent = clean_folder_ref(body['parent'])
        if parent in folder_descendants(folders, fid):
            raise ApiError('Нельзя переместить раздел внутрь самого себя')
        folder['parent'] = parent
    save_folders(folders)
    return jsonify(folder)


@app.delete(ADMIN + '/api/folders/<fid>')
def folder_delete(fid):
    folders = get_folders()
    folder = own_folder(folders, fid)
    parent = folder.get('parent')
    # содержимое удаляемого раздела поднимается на уровень выше
    for f in folders:
        if f.get('parent') == fid:
            f['parent'] = parent
    save_folders([f for f in folders if f['id'] != fid])
    for m in all_maps():
        if m.get('folder') == fid:
            m['folder'] = parent
            save_map(m)
    return admin_state()


@app.post(ADMIN + '/api/maps')
def map_create():
    title = str(request.form.get('title') or '').strip()[:200] or 'Новая карта'
    meta = new_map(title, clean_folder_ref(request.form.get('folder')), me_id())
    try:
        meta['image'] = store_image(meta['id'], request.files.get('image'))
    except ApiError:
        shutil.rmtree(MAPS / meta['id'], ignore_errors=True)
        raise
    save_map(meta)
    return jsonify(meta)


@app.patch(ADMIN + '/api/maps/<mid>')
def map_update(mid):
    meta = own_map(mid)
    body = request.get_json(silent=True) or {}
    if 'title' in body:
        meta['title'] = str(body['title'] or '').strip()[:200] or 'Без названия'
    if 'description' in body:
        meta['description'] = str(body['description'] or '')[:2000]
    if 'folder' in body:
        meta['folder'] = clean_folder_ref(body['folder'])
    if 'published' in body:
        meta['published'] = bool(body['published'])
    if 'tasks' in body:
        meta['tasks'] = clean_tasks(body['tasks'])
    save_map(meta)
    return jsonify(meta)


@app.post(ADMIN + '/api/maps/<mid>/image')
def map_replace_image(mid):
    meta = own_map(mid)
    meta['image'] = store_image(mid, request.files.get('image'))
    meta['imageVersion'] = now_ms()
    save_map(meta)
    return jsonify(meta)


@app.post(ADMIN + '/api/maps/<mid>/duplicate')
def map_duplicate(mid):
    src = own_map(mid)
    meta = new_map(src['title'] + ' (копия)', src.get('folder'), src['owner'])
    meta.update(description=src.get('description', ''), image=src.get('image'),
                tasks=[dict(t, id=rand_id(8)) for t in src.get('tasks', [])])
    (MAPS / meta['id']).mkdir(parents=True)
    if src.get('image'):
        shutil.copyfile(MAPS / mid / src['image'], MAPS / meta['id'] / src['image'])
    save_map(meta)
    return jsonify(meta)


@app.delete(ADMIN + '/api/maps/<mid>')
def map_delete(mid):
    own_map(mid)
    shutil.rmtree(map_dir(mid))
    for student_dir in WORKS.glob('*'):
        (student_dir / f'{mid}.json').unlink(missing_ok=True)
    return jsonify(ok=True)


@app.post(ADMIN + '/api/password')
def change_password():
    body = request.get_json(silent=True) or {}
    me = me_id()
    with LOCK:
        teachers = get_teachers()
        teacher = next(t for t in teachers if t['id'] == me)
        if not check_password_hash(teacher['password_hash'], str(body.get('current') or '')):
            raise ApiError('Текущий пароль введён неверно')
        new = clean_teacher_password(body.get('new'))
        teacher['password_hash'] = generate_password_hash(new)
        save_teachers(teachers)
    return jsonify(ok=True)


def is_main():
    """Главный учитель — первый в списке: он добавляет и удаляет остальных."""
    teachers = get_teachers()
    return bool(teachers) and teachers[0]['id'] == me_id()


def require_main():
    if not is_main():
        abort(404)


def teacher_password():
    return new_password() + new_password()[:4]  # 12 символов без похожих букв и цифр


def clean_teacher_password(value):
    password = str(value or '')
    if not TEACHER_PW_RE.fullmatch(password):
        raise ApiError(TEACHER_PW_RULE)
    return password


def teachers_view():
    teachers = get_teachers()
    return [{'id': t['id'], 'login': t['login'], 'name': t['name'], 'main': i == 0} for i, t in enumerate(teachers)]


def delete_teacher_data(tid):
    """Карты, разделы, классы, ученики и работы учителя — удаляются вместе с ним."""
    my_maps = [m['id'] for m in all_maps() if m.get('owner') == tid]
    for mid in my_maps:
        shutil.rmtree(MAPS / mid, ignore_errors=True)
        for student_dir in WORKS.glob('*'):
            (student_dir / f'{mid}.json').unlink(missing_ok=True)
    save_folders([f for f in get_folders() if f.get('owner') != tid])
    roster = get_roster()
    classes = {c['id'] for c in roster['classes'] if c.get('owner') == tid}
    for st in roster['students']:
        if st['classId'] in classes:
            shutil.rmtree(WORKS / st['id'], ignore_errors=True)
    roster['students'] = [st for st in roster['students'] if st['classId'] not in classes]
    roster['classes'] = [c for c in roster['classes'] if c['id'] not in classes]
    save_roster(roster)


@app.get(ADMIN + '/api/teachers')
def admin_teachers():
    require_main()
    return jsonify(teachers=teachers_view())


@app.post(ADMIN + '/api/teachers')
def admin_teacher_add():
    require_main()
    body = request.get_json(silent=True) or {}
    login = str(body.get('login') or '').strip().lower()
    name = clean_name(body.get('name'), 'имя учителя')
    if not LOGIN_RE.fullmatch(login):
        raise ApiError('Логин: от 3 до 32 латинских букв или цифр (можно точку, дефис, подчёркивание)')
    password = clean_teacher_password(body.get('password'))
    with LOCK:
        teachers = get_teachers()
        if any(t['login'] == login for t in teachers):
            raise ApiError('Учитель с таким логином уже есть')
        teachers.append(new_teacher(login, name, password))
        save_teachers(teachers)
    return jsonify(teachers=teachers_view())


@app.patch(ADMIN + '/api/teachers/<tid>')
def admin_teacher_update(tid):
    require_main()
    body = request.get_json(silent=True) or {}
    password = clean_teacher_password(body['password']) if 'password' in body else None
    with LOCK:
        teachers = get_teachers()
        teacher = next((t for t in teachers if t['id'] == tid), None)
        if not teacher:
            abort(404)
        if 'name' in body:
            teacher['name'] = clean_name(body['name'], 'имя учителя')
        if password:
            teacher['password_hash'] = generate_password_hash(password)
        save_teachers(teachers)
    return jsonify(teachers=teachers_view())


@app.delete(ADMIN + '/api/teachers/<tid>')
def admin_teacher_delete(tid):
    require_main()
    with LOCK:
        teachers = get_teachers()
        if tid == teachers[0]['id']:
            raise ApiError('Главного учителя удалить нельзя')
        if not any(t['id'] == tid for t in teachers):
            abort(404)
        save_teachers([t for t in teachers if t['id'] != tid])
        delete_teacher_data(tid)
    return jsonify(teachers=teachers_view())


@app.patch(ADMIN + '/api/me')
def change_my_name():
    name = clean_name((request.get_json(silent=True) or {}).get('name'), 'имя')
    me = me_id()
    with LOCK:
        teachers = get_teachers()
        next(t for t in teachers if t['id'] == me)['name'] = name
        save_teachers(teachers)
    return jsonify(name=name)


# ---------- ссылка для учеников ----------

PORT = int(os.environ.get('PORT', 5000))


def lan_ips():
    try:
        infos = socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
    except OSError:
        return []
    ips = {i[4][0] for i in infos if not i[4][0].startswith(('127.', '169.254.'))}
    # домашние и школьные сети обычно 192.168.x.x — показываем их первыми
    return sorted(ips, key=lambda ip: not ip.startswith('192.168.'))


def student_urls():
    if PUBLIC_URL:
        return [PUBLIC_URL]
    return [f'http://{ip}:{PORT}' if PORT != 80 else f'http://{ip}' for ip in lan_ips()]


def qr_svg(text):
    import qrcode
    import qrcode.image.svg
    return qrcode.make(text, image_factory=qrcode.image.svg.SvgPathImage, box_size=10, border=2).to_string(encoding='unicode')


@app.get('/link')
def link_page():
    """Страница для проектора: адрес сайта и QR-код, который ученики сканируют камерой."""
    from html import escape
    urls = student_urls()
    # ?ip=… выбирает, какой из адресов компьютера показать в QR-коде
    chosen = next((u for u in urls if u.split('//')[1].split(':')[0] == request.args.get('ip')), urls[0] if urls else None)
    blocks = (f'<div class="qr-block"><div class="qr">{qr_svg(chosen)}</div><div class="qr-url">{escape(chosen)}</div></div>'
              if chosen else '<p>Компьютер не подключён к сети.</p>')
    others = [u for u in urls if u != chosen]
    note = ('<p class="muted">Если телефоны не открывают сайт, переключите код на другой адрес этого компьютера: '
            + ', '.join(f'<a href="/link?ip={escape(u.split("//")[1].split(":")[0])}">{escape(u)}</a>' for u in others)
            + '</p>' if others else '')
    html = f"""<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Ссылка на контурные карты</title>
<link rel="stylesheet" href="/static/style.css"><style>
body {{ text-align: center; padding: 24px 16px; }}
h1 {{ margin: 0 0 6px; font-size: clamp(22px, 4vw, 40px); }}
.qr-wrap {{ display: flex; flex-wrap: wrap; justify-content: center; gap: 32px; margin: 24px 0; }}
.qr {{ width: min(70vh, 80vw); max-width: 520px; background: #fff; padding: 12px; border-radius: 16px; box-shadow: var(--shadow); }}
.qr svg {{ width: 100%; height: auto; display: block; }}
.qr-url {{ font-size: clamp(22px, 4vw, 44px); font-weight: 700; margin-top: 14px; letter-spacing: .01em; }}
</style></head><body>
<h1>Контурные карты</h1>
<p class="muted">{'Наведите камеру телефона на код' if PUBLIC_URL else 'Подключитесь к Wi-Fi класса и наведите камеру телефона на код'} — или наберите адрес в браузере</p>
<div class="qr-wrap">{blocks}</div>{note}
</body></html>"""
    return app.response_class(html, mimetype='text/html')


seed()
migrate_old_submissions()
migrate_owners()


def print_banner():
    urls = student_urls()
    print('\n  Контурные карты запущены. Не закрывайте это окно, пока идёт урок.\n')
    print(f'  На этом компьютере:  http://localhost:{PORT}')
    for u in urls:
        print(f'  Для учеников:        {u}')
    print(f'  QR-код для проектора: http://localhost:{PORT}/link')
    if ACCESS_FILE.exists():
        print(f'  Вход в админку:      см. файл {ACCESS_FILE.name}')
    if urls:
        try:
            import qrcode
            qr = qrcode.QRCode(border=2)
            qr.add_data(urls[0])
            print()
            qr.print_ascii(invert=True)
        except (ImportError, UnicodeEncodeError):
            pass
    print()


if __name__ == '__main__':
    args = sys.argv[1:]
    if args[:1] == ['--teachers']:
        for t in get_teachers():
            print(f"  {t['login']:<16} {t['name']}")
        sys.exit()
    if args[:1] == ['--add-teacher'] and len(args) == 3:
        login, name = args[1].strip().lower(), ' '.join(args[2].split())[:80]
        if not LOGIN_RE.fullmatch(login):
            sys.exit('Логин: 3–32 символа, латинские буквы, цифры, точка, дефис или подчёркивание.')
        teachers = get_teachers()
        if any(t['login'] == login for t in teachers):
            sys.exit(f'Учитель с логином {login} уже есть.')
        password = teacher_password()
        save_teachers(teachers + [new_teacher(login, name or login, password)])
        print(f'Учитель добавлен.\n  Логин:  {login}\n  Пароль: {password}\n  Адрес админки — тот же, что и у остальных учителей.')
        sys.exit()
    if args[:1] == ['--password'] and len(args) in (2, 3):
        # «--password НОВЫЙ» (как раньше) меняет пароль первого учителя
        login, password = (args[1].lower(), args[2]) if len(args) == 3 else (get_teachers()[0]['login'], args[1])
        teachers = get_teachers()
        teacher = next((t for t in teachers if t['login'] == login), None)
        if not teacher:
            sys.exit(f'Учителя с логином {login} нет. Список: python app.py --teachers')
        if not TEACHER_PW_RE.fullmatch(password):
            sys.exit(TEACHER_PW_RULE)
        teacher['password_hash'] = generate_password_hash(password)
        save_teachers(teachers)
        print(f'Пароль учителя {login} изменён.')
        sys.exit()
    if len(sys.argv) == 2 and sys.argv[1] == '--new-admin-path':
        CFG['admin_path'] = rand_id(20)
        write_json(CONFIG_FILE, CFG)
        print(f'Новый адрес админки: {PUBLIC_URL or "http://localhost:5000"}/{CFG["admin_path"]}')
        print('Старый адрес больше не работает (после перезапуска сайта).')
        sys.exit()
    print_banner()
    try:
        from waitress import serve
    except ImportError:
        app.run(host='0.0.0.0', port=PORT, threaded=True)
    else:
        serve(app, host='0.0.0.0', port=PORT, threads=16)
