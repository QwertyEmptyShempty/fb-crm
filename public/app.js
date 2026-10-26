'use strict';
/* Панель управления. Без сборки: один файл, DOM строится через h() и textContent —
   данные из рекламы (utm_*, имена) никогда не попадают в innerHTML. */

const app = document.getElementById('app');
const state = { meta: null };
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

// ───────────────────────── утилиты ─────────────────────────

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  let late;
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'value') late = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'disabled') el.disabled = !!v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  if (late !== undefined) el.value = late;
  return el;
}

const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString('ru-RU'));
const pct = (v) => (v == null ? '—' : (v * 100).toFixed(1).replace('.', ',') + '%');
const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};
const debounce = (fn, ms) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};
const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
};

function toast(msg, bad) {
  const el = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), bad ? 7000 : 3500);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = h('textarea', { style: 'position:fixed;opacity:0' });
    t.value = text;
    document.body.append(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
  toast('Скопировано');
}

async function api(method, path, body, opts = {}) {
  const headers = { 'x-requested-with': 'crm', ...(opts.headers || {}) };
  let payload;
  if (body !== undefined && body !== null) {
    if (opts.raw) payload = body;
    else {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }
  const res = await fetch('/api/v1' + path, { method, headers, body: payload, credentials: 'same-origin' });
  if (res.status === 401) {
    showLogin();
    throw new Error('Нужно войти');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    let msg = data?.error ?? `Ошибка ${res.status}`;
    if (data?.details?.length) msg += ': ' + data.details.map((d) => `${d.path} — ${d.message}`).join('; ');
    throw new Error(msg);
  }
  return data;
}

function guard(fn) {
  return async (...a) => {
    try {
      return await fn(...a);
    } catch (e) {
      toast(e.message || 'Что-то пошло не так', true);
    }
  };
}

function field(label, input, hint) {
  return h('div', { class: 'field' }, h('label', null, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
}

function modal(title, body, buttons) {
  const close = () => ov.remove();
  const ov = h(
    'div',
    { class: 'overlay', onmousedown: (e) => e.target === ov && close() },
    h('div', { class: 'modal', role: 'dialog', 'aria-label': title }, h('h2', null, title), body, h('div', { class: 'actions' }, buttons(close))),
  );
  document.addEventListener('keydown', function esc(e) {
    if (!ov.isConnected) return document.removeEventListener('keydown', esc);
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', esc);
    }
  });
  document.body.append(ov);
  const first = ov.querySelector('input,select,textarea');
  if (first) first.focus();
  return { close };
}

const EVENT_LABELS = {
  page_view: 'Просмотр',
  click: 'Клик',
  join_request: 'Заявка',
  member_joined: 'Подписка',
  left: 'Отписка',
  dm_failed: 'Приветствие не доставлено',
  approve_failed: 'Заявка не одобрена',
};

// ───────────────────────── вход и каркас ─────────────────────────

function showLogin() {
  app.replaceChildren(
    h(
      'div',
      { class: 'login' },
      h(
        'form',
        {
          onsubmit: guard(async (e) => {
            e.preventDefault();
            const fd = new FormData(e.target);
            const res = await fetch('/admin/login', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ login: fd.get('login'), password: fd.get('password') }),
              credentials: 'same-origin',
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Не удалось войти');
            boot();
          }),
        },
        h('h1', null, 'Трекер Facebook → Telegram'),
        h('p', { class: 'sub' }, 'Войдите, чтобы открыть панель.'),
        field('Логин', h('input', { type: 'text', name: 'login', autocomplete: 'username', required: true, value: 'admin' })),
        field('Пароль', h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true })),
        h('button', { class: 'btn primary', type: 'submit' }, 'Войти'),
      ),
    ),
  );
}

const NAV = [
  ['analytics', 'Аналитика'],
  ['campaigns', 'Кампании'],
  ['bots', 'Боты и каналы'],
  ['domains', 'Домены'],
  ['pixels', 'Пиксели'],
  ['subscribers', 'Подписчики'],
  ['events', 'События'],
  ['connect', 'Подключение нейросети'],
];

let mainEl;
function shell() {
  mainEl = h('main');
  const nav = h(
    'nav',
    { class: 'nav' },
    NAV.map(([k, t]) => h('a', { href: '#/' + k, 'data-k': k }, t)),
  );
  app.replaceChildren(
    h(
      'div',
      { class: 'shell' },
      h(
        'aside',
        { class: 'rail' },
        h('div', { class: 'brand' }, 'Трекер', h('small', null, 'Facebook → Telegram')),
        nav,
        h(
          'div',
          { class: 'foot' },
          h('span', null, state.meta?.login ?? ''),
          h(
            'button',
            {
              onclick: async () => {
                await fetch('/admin/logout', { method: 'POST', credentials: 'same-origin' });
                showLogin();
              },
            },
            'Выйти',
          ),
        ),
      ),
      mainEl,
    ),
  );
}

async function route() {
  if (!mainEl || !mainEl.isConnected) return;
  const parts = (location.hash.replace(/^#\/?/, '') || 'analytics').split('/');
  const page = parts[0];
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('on', a.dataset.k === page));
  mainEl.replaceChildren(h('p', { class: 'muted' }, 'Загрузка…'));
  window.scrollTo(0, 0);
  try {
    let view;
    if (page === 'campaigns' && parts[1]) view = await pageCampaign(parts[1]);
    else if (page === 'campaigns') view = await pageCampaigns();
    else if (page === 'bots') view = await pageBots();
    else if (page === 'domains') view = await pageDomains();
    else if (page === 'pixels') view = await pagePixels();
    else if (page === 'subscribers') view = await pageSubscribers();
    else if (page === 'events') view = await pageEvents();
    else if (page === 'connect') view = await pageConnect();
    else view = await pageAnalytics();
    mainEl.replaceChildren(view);
  } catch (e) {
    mainEl.replaceChildren(h('div', { class: 'note bad' }, e.message || 'Ошибка загрузки'));
  }
}

function pageHead(title, sub, ...actions) {
  return h('div', { class: 'head' }, h('div', null, h('h1', null, title), sub ? h('p', { class: 'sub' }, sub) : null), h('div', { class: 'actions' }, actions));
}

function table(cols, rows, opts = {}) {
  if (!rows.length)
    return h('div', { class: 'tblwrap' }, h('div', { class: 'empty' }, h('b', null, opts.emptyTitle || 'Пока пусто'), opts.emptyText || ''));
  return h(
    'div',
    { class: 'tblwrap' },
    h(
      'table',
      { class: 'tbl' },
      h('thead', null, h('tr', null, cols.map((c) => h('th', { class: c.r ? 'r' : '' }, c.t)))),
      h(
        'tbody',
        null,
        rows.map((row, i) =>
          h(
            'tr',
            { class: opts.totalLast && i === rows.length - 1 ? 'total' : '' },
            cols.map((c) => {
              const v = c.f(row);
              return h('td', { class: (c.r ? 'r num ' : '') + (c.wrap ? 'wrap' : '') }, v);
            }),
          ),
        ),
      ),
    ),
  );
}

// ───────────────────────── Аналитика ─────────────────────────

const GROUPS = {
  none: 'Итого',
  day: 'День',
  utm_campaign: 'Кампания (utm_campaign)',
  utm_content: 'Объявление (utm_content)',
  utm_term: 'Адсет (utm_term)',
  utm_source: 'Источник (utm_source)',
  utm_medium: 'Канал (utm_medium)',
  campaign_id: 'ID кампании',
  adset_id: 'ID адсета',
  ad_id: 'ID объявления',
  placement: 'Плейсмент',
};

function periodRange(p, from, to) {
  const now = new Date();
  const day = (d, add = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + add);
  if (p === 'today') return [day(now), new Date(now.getTime() + 60000)];
  if (p === 'yesterday') return [day(now, -1), day(now)];
  if (p === '30') return [day(now, -29), new Date(now.getTime() + 60000)];
  if (p === 'custom') {
    const f = from ? new Date(from + 'T00:00:00') : day(now, -6);
    const t = to ? day(new Date(to + 'T00:00:00'), 1) : new Date(now.getTime() + 60000);
    return [f, t];
  }
  return [day(now, -6), new Date(now.getTime() + 60000)];
}

async function pageAnalytics() {
  const offers = await api('GET', '/offers');
  const s = JSON.parse(sessionStorage.getItem('an') || '{}');
  const st = { offer: s.offer || '', period: s.period || '7', group: s.group || 'day', from: s.from || '', to: s.to || '' };
  const out = h('div');
  const customBox = h('div', { class: 'inline' });
  const customField = h('div', { class: 'field' }, h('label', null, 'Даты'), customBox);

  const load = guard(async () => {
    sessionStorage.setItem('an', JSON.stringify(st));
    customField.classList.toggle('hide', st.period !== 'custom');
    const [f, t] = periodRange(st.period, st.from, st.to);
    const data = await api('GET', '/stats' + qs({ offer: st.offer, from: f.toISOString(), to: t.toISOString(), group_by: st.group, tz: TZ }));
    out.replaceChildren(renderStats(data));
  });

  const sel = (key, options) =>
    h('select', { value: st[key], onchange: (e) => ((st[key] = e.target.value), load()) }, options.map(([v, t]) => h('option', { value: v }, t)));

  customBox.append(
    h('input', { type: 'date', value: st.from, onchange: (e) => ((st.from = e.target.value), load()) }),
    h('span', null, '—'),
    h('input', { type: 'date', value: st.to, onchange: (e) => ((st.to = e.target.value), load()) }),
  );

  const view = h(
    'div',
    null,
    pageHead('Аналитика', 'Просмотры, клики, заявки и подписки. Считается по времени события.'),
    h(
      'div',
      { class: 'filters' },
      field('Кампания', sel('offer', [['', 'Все кампании'], ...offers.map((o) => [o.id, o.name])])),
      field('Период', sel('period', [['today', 'Сегодня'], ['yesterday', 'Вчера'], ['7', '7 дней'], ['30', '30 дней'], ['custom', 'Свой период']])),
      customField,
      field('Группировать по', sel('group', Object.entries(GROUPS))),
    ),
    out,
  );
  load();
  return view;
}

function renderStats(d) {
  const t = d.totals;
  const steps = [
    ['Просмотры', t.views, null],
    ['Клики по кнопке', t.clicks, t.views ? `${pct(t.click_rate)} от просмотров` : null],
    ['Заявки в канал', t.join_requests, t.clicks ? `${pct(t.request_rate)} от кликов` : null],
    ['Подписчики', t.joined, t.views ? `${pct(t.joined / t.views)} от просмотров` : null],
  ];
  const max = Math.max(1, t.views, t.clicks);
  const funnel = h('div', { class: 'funnel' });
  steps.forEach(([name, val, note]) => {
    funnel.append(
      h(
        'div',
        { class: 'fstep' },
        h('div', { class: 'name' }, name),
        h('div', { class: 'bar' }, h('i', { style: `width:${Math.max((val / max) * 100, val ? 1 : 0)}%` })),
        h('div', { class: 'val num' }, fmtNum(val), note ? h('small', null, note) : null),
      ),
    );
  });
  if (t.left) funnel.append(h('div', { class: 'fgap', style: 'margin-top:8px' }, `Отписались: ${fmtNum(t.left)}`));

  const cols = [
    { t: GROUPS[d.group_by] || 'Группа', f: (r) => r.key },
    { t: 'Просмотры', r: 1, f: (r) => fmtNum(r.views) },
    { t: 'Клики', r: 1, f: (r) => fmtNum(r.clicks) },
    { t: 'Клики / просм.', r: 1, f: (r) => pct(r.click_rate) },
    { t: 'Заявки', r: 1, f: (r) => fmtNum(r.join_requests) },
    { t: 'Заявки / клики', r: 1, f: (r) => pct(r.request_rate) },
    { t: 'Подписки', r: 1, f: (r) => fmtNum(r.joined) },
    { t: 'Подписки / просм.', r: 1, f: (r) => pct(r.join_rate) },
    { t: 'Отписки', r: 1, f: (r) => fmtNum(r.left) },
  ];
  const rows = d.group_by === 'none' ? [] : d.rows;
  const total = { key: 'Всего', ...t };
  const tbl = rows.length
    ? table(cols, [...rows, total], { totalLast: true })
    : d.group_by === 'none'
      ? null
      : h('div', { class: 'tblwrap' }, h('div', { class: 'empty' }, h('b', null, 'Нет данных за период'), 'Откройте ссылку лендинга — просмотры появятся здесь.'));

  const exportBtn = h(
    'button',
    {
      class: 'btn sm',
      onclick: () => {
        const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
        const csv = [cols.map((c) => esc(c.t)).join(';'), ...[...rows, total].map((r) => cols.map((c) => esc(c.f(r))).join(';'))].join('\n');
        const a = h('a', { href: URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })), download: `stats-${new Date().toISOString().slice(0, 10)}.csv` });
        document.body.append(a);
        a.click();
        a.remove();
      },
    },
    'Скачать CSV',
  );
  return h('div', null, funnel, tbl ? h('div', { class: 'actions', style: 'justify-content:space-between;margin-bottom:10px' }, h('h2', { style: 'margin:0' }, 'Детализация'), exportBtn) : null, tbl);
}

// ───────────────────────── Кампании ─────────────────────────

function readiness(o) {
  const issues = [];
  if (!o.channel) issues.push('нет канала');
  if (!o.pixel) issues.push('нет пикселя');
  else if (!o.pixel.has_capi_token) issues.push('нет токена CAPI');
  if (o.landing_type === 'custom' && (!o.has_landing_html || o.cta_count === 0)) issues.push('в лендинге нет кнопки');
  return issues;
}

async function pageCampaigns() {
  const offers = await api('GET', '/offers');
  const create = () => {
    const name = h('input', { type: 'text', placeholder: 'Например, Сигналы — Вьетнам', maxlength: 100 });
    modal('Новая кампания', field('Название', name, 'Его видите только вы. Ссылку и лендинг настроите дальше.'), (close) => [
      h('button', { class: 'btn', onclick: close }, 'Отмена'),
      h(
        'button',
        {
          class: 'btn primary',
          onclick: guard(async () => {
            if (!name.value.trim()) throw new Error('Введите название');
            const o = await api('POST', '/offers', { name: name.value.trim() });
            close();
            location.hash = '#/campaigns/' + o.id;
          }),
        },
        'Создать',
      ),
    ]);
  };
  return h(
    'div',
    null,
    pageHead('Кампании', 'Кампания связывает лендинг, пиксель Facebook и канал Telegram. Одна кампания — одна ссылка для рекламы.', h('button', { class: 'btn primary', onclick: create }, 'Новая кампания')),
    table(
      [
        { t: 'Название', f: (o) => h('a', { class: 'row-link', href: '#/campaigns/' + o.id }, o.name) },
        { t: 'Статус', f: (o) => h('span', { class: 'chip ' + (o.status === 'active' ? 'ok' : 'warn') }, o.status === 'active' ? 'Активна' : 'На паузе') },
        { t: 'Канал', f: (o) => o.channel?.title || (o.channel ? o.channel.chat_id : '—') },
        { t: 'Пиксель', f: (o) => o.pixel?.pixel_id || '—' },
        { t: 'Лендинг', f: (o) => (o.landing_type === 'custom' ? 'Свой HTML' : 'Встроенный') },
        {
          t: 'Готовность',
          f: (o) => {
            const i = readiness(o);
            return i.length ? h('span', { class: 'chip warn', title: i.join(', ') }, 'Не готова: ' + i[0]) : h('span', { class: 'chip ok' }, 'Готова');
          },
        },
        { t: '', f: (o) => h('button', { class: 'btn sm', onclick: () => copy(o.landing_url) }, 'Копировать ссылку') },
      ],
      offers,
      { emptyTitle: 'Кампаний пока нет', emptyText: 'Нажмите «Новая кампания», чтобы создать первую.' },
    ),
  );
}

// ───────────────────────── Редактор кампании ─────────────────────────

const DEFAULT_EVENTS = { page_view: 'PageView', click: 'Contact', join_request: 'Lead', member_joined: 'Subscribe' };
const EVENT_ROWS = [
  ['page_view', 'Просмотр страницы'],
  ['click', 'Клик по кнопке'],
  ['join_request', 'Заявка в канал'],
  ['member_joined', 'Подписка на канал'],
];

function stepFromApi(s) {
  let unit = 's';
  let value = s.delay_sec || 0;
  if (value >= 3600 && value % 3600 === 0) (unit = 'h'), (value /= 3600);
  else if (value >= 60 && value % 60 === 0) (unit = 'm'), (value /= 60);
  return { text: s.text, photo_url: s.photo_url || '', buttons: (s.buttons || []).map((b) => ({ ...b })), value, unit };
}

function toEditor(o) {
  const L = { ...(o.landing || {}) };
  L.bulletsText = (L.bullets || []).join('\n');
  L.accent = L.accent || '#2AABEE';
  L.theme = L.theme || 'dark';
  const em = {};
  for (const [k] of EVENT_ROWS) {
    const v = o.event_map?.[k];
    em[k] = v === null ? { mode: 'off', value: '' } : v ? { mode: 'custom', value: v } : { mode: 'default', value: '' };
  }
  return {
    id: o.id,
    slug: o.slug,
    name: o.name,
    status: o.status,
    domain: o.domain || '',
    channel_id: o.channel?.id || '',
    auto_approve: o.auto_approve,
    landing_type: o.landing_type,
    landing: L,
    landing_html: o.landing_html || '',
    has_assets: o.has_assets,
    welcome: (o.welcome || []).map(stepFromApi),
    event_map: em,
    pixel: o.pixel,
  };
}

function cleanLanding(L) {
  const out = {};
  for (const k of ['title', 'subtitle', 'text', 'avatar_url', 'count_text', 'image_url', 'button_text', 'accent', 'theme', 'footer', 'custom_css', 'head_html', 'body_html']) {
    if (L[k] && String(L[k]).trim() !== '') out[k] = L[k];
  }
  const bullets = (L.bulletsText || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 6);
  if (bullets.length) out.bullets = bullets;
  return out;
}

function toPayload(o) {
  const mult = { s: 1, m: 60, h: 3600 };
  const event_map = {};
  for (const [k] of EVENT_ROWS) {
    const e = o.event_map[k];
    if (e.mode === 'off') event_map[k] = null;
    else if (e.mode === 'custom' && e.value.trim()) event_map[k] = e.value.trim();
  }
  return {
    name: o.name.trim(),
    status: o.status,
    channel_id: o.channel_id || null,
    domain: o.domain.trim() ? o.domain.trim().toLowerCase() : null,
    auto_approve: o.auto_approve,
    landing_type: o.landing_type,
    landing: cleanLanding(o.landing),
    landing_html: o.landing_html.trim() ? o.landing_html : null,
    welcome: o.welcome.map((s) => ({
      text: s.text,
      delay_sec: Math.max(0, Math.round(Number(s.value) || 0) * mult[s.unit]),
      ...(s.photo_url.trim() ? { photo_url: s.photo_url.trim() } : {}),
      ...(s.buttons.filter((b) => b.text.trim() && b.url.trim()).length ? { buttons: s.buttons.filter((b) => b.text.trim() && b.url.trim()).map((b) => ({ text: b.text.trim(), url: b.url.trim() })) } : {}),
    })),
    event_map,
  };
}

const ctaIn = (html) => (html.match(/data-tg-link|\{\{\s*tg_link\s*\}\}|href=(["'])#tg\1/g) || []).length;

async function pageCampaign(id) {
  const [offer, channels, pixels, domainData] = await Promise.all([api('GET', '/offers/' + id), api('GET', '/channels'), api('GET', '/pixels'), api('GET', '/domains')]);
  const o = toEditor(offer);
  let tab = sessionStorage.getItem('tab:' + id) || 'main';
  let dirty = false;
  const body = h('div');
  const title = h('h1', null, o.name);
  const saveBtn = h('button', { class: 'btn primary', onclick: guard(save) }, 'Сохранить');
  const dirtyNote = h('span', { class: 'muted hide' }, 'Есть несохранённые изменения');
  const tabsEl = h('div', { class: 'tabs', role: 'tablist' });

  const touch = () => {
    dirty = true;
    dirtyNote.classList.remove('hide');
  };
  const on = (obj, key, post) => (e) => {
    obj[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    touch();
    if (post) post();
  };

  async function save() {
    if (!o.name.trim()) throw new Error('Введите название кампании');
    if (o.welcome.some((s) => !s.text.trim())) throw new Error('В приветствии есть пустое сообщение — заполните или удалите его');
    saveBtn.disabled = true;
    try {
      const res = await api('PATCH', '/offers/' + id, toPayload(o));
      o.has_assets = res.has_assets;
      dirty = false;
      dirtyNote.classList.add('hide');
      title.textContent = res.name;
      toast('Сохранено');
    } finally {
      saveBtn.disabled = false;
    }
  }

  const tabs = [
    ['main', 'Основное'],
    ['landing', 'Лендинг'],
    ['welcome', 'Приветствия'],
    ['link', 'Ссылка для рекламы'],
  ];
  function drawTabs() {
    tabsEl.replaceChildren(
      ...tabs.map(([k, t]) =>
        h(
          'button',
          {
            role: 'tab',
            class: tab === k ? 'on' : '',
            onclick: () => {
              tab = k;
              sessionStorage.setItem('tab:' + id, k);
              drawTabs();
              drawBody();
            },
          },
          t,
        ),
      ),
    );
  }
  function drawBody() {
    const fn = { main: tabMain, landing: tabLanding, welcome: tabWelcome, link: tabLink }[tab];
    body.replaceChildren(fn());
  }

  // ── Основное
  function tabMain() {
    const chanSel = h(
      'select',
      { value: o.channel_id, onchange: on(o, 'channel_id') },
      h('option', { value: '' }, '— не выбран —'),
      channels.map((c) => h('option', { value: c.id }, (c.title || c.chat_id) + (c.username ? ' (@' + c.username + ')' : ''))),
    );
    const domainField = () => {
      const list = domainData.domains;
      const cur = list.find((d) => d.host === o.domain);
      const hintBox = h('div', { class: 'hint' });
      const sel = h(
        'select',
        { value: o.domain || '', onchange: on(o, 'domain', () => drawHint()) },
        h('option', { value: '' }, '— без своего домена (адрес сервиса) —'),
        list.map((d) => h('option', { value: d.host }, d.host + (d.status === 'active' ? '' : '  (ещё не настроен)'))),
        o.domain && !cur ? h('option', { value: o.domain }, o.domain) : null,
      );
      sel.value = o.domain || '';
      const drawHint = () => {
        const d = list.find((x) => x.host === o.domain);
        hintBox.replaceChildren(
          !o.domain
            ? 'Ссылки будут вести на адрес сервиса. Свой домен выглядит надёжнее для рекламы — подключите его кнопкой справа.'
            : d && d.status !== 'active'
              ? h('span', { style: 'color:var(--warn)' }, 'Этот домен ещё не проверен — лендинг по нему может не открываться. Откройте «Домены» и нажмите «Проверить».')
              : `Лендинг откроется по адресу https://${o.domain}/ (также https://${o.domain}/l/${o.slug}).`,
        );
      };
      drawHint();
      return h(
        'div',
        { class: 'field' },
        h('label', null, 'Домен лендинга'),
        h(
          'div',
          { class: 'inline' },
          sel,
          h('button', { class: 'btn', type: 'button', onclick: () => addDomainModal(async (host) => {
            const fresh = await api('GET', '/domains');
            domainData.domains = fresh.domains;
            o.domain = host;
            touch();
            drawBody();
            toast('Домен добавлен и выбран. Не забудьте нажать «Сохранить».');
          }) }, 'Добавить домен'),
        ),
        hintBox,
      );
    };
    const pixBox = h('div');
    const drawPixel = () =>
      pixBox.replaceChildren(
        o.pixel
          ? h(
              'div',
              { class: 'note ' + (o.pixel.has_capi_token ? 'ok' : 'warn') },
              `Пиксель ${o.pixel.pixel_id} (${o.pixel.name}). `,
              o.pixel.has_capi_token ? 'Токен Conversions API задан.' : 'Токена Conversions API нет — события Lead и Subscribe в Facebook не попадут.',
            )
          : h('div', { class: 'note warn' }, 'Пиксель не привязан.'),
        h(
          'div',
          { class: 'actions' },
          pixels.length
            ? h(
                'select',
                {
                  style: 'width:auto',
                  value: '',
                  onchange: guard(async (e) => {
                    if (!e.target.value) return;
                    const res = await api('PATCH', '/offers/' + id, { pixel_id: e.target.value });
                    o.pixel = res.pixel;
                    drawPixel();
                    toast('Пиксель привязан');
                  }),
                },
                h('option', { value: '' }, 'Выбрать из добавленных…'),
                pixels.map((p) => h('option', { value: p.id }, `${p.name} — ${p.pixel_id}`)),
              )
            : null,
          h('button', { class: 'btn sm', onclick: addPixelModal }, 'Добавить новый пиксель'),
        ),
      );
    function addPixelModal() {
      const f = {
        pixel: h('input', { type: 'text', inputmode: 'numeric', placeholder: '123456789012345' }),
        token: h('input', { type: 'text', placeholder: 'EAAB…' }),
        test: h('input', { type: 'text', placeholder: 'TEST12345' }),
        name: h('input', { type: 'text', placeholder: 'Необязательно' }),
      };
      modal(
        'Привязать пиксель',
        h(
          'div',
          null,
          field('ID пикселя', f.pixel, 'Events Manager → Источники данных → ваш пиксель.'),
          field('Токен Conversions API', f.token, 'Events Manager → Настройки → Conversions API → Сгенерировать токен доступа.'),
          field('Код тестовых событий', f.test, 'Нужен только для проверки на вкладке «Ссылка для рекламы».'),
          field('Название', f.name),
        ),
        (close) => [
          h('button', { class: 'btn', onclick: close }, 'Отмена'),
          h(
            'button',
            {
              class: 'btn primary',
              onclick: guard(async () => {
                const res = await api('PUT', `/offers/${id}/pixel`, {
                  fb_pixel_id: f.pixel.value.trim(),
                  ...(f.token.value.trim() ? { capi_token: f.token.value.trim() } : {}),
                  ...(f.test.value.trim() ? { test_event_code: f.test.value.trim() } : {}),
                  ...(f.name.value.trim() ? { name: f.name.value.trim() } : {}),
                });
                o.pixel = res.offer.pixel;
                if (!pixels.some((p) => p.id === o.pixel.id)) pixels.push(o.pixel);
                close();
                drawPixel();
                toast('Пиксель привязан');
              }),
            },
            'Привязать',
          ),
        ],
      );
    }
    drawPixel();

    const evRows = EVENT_ROWS.map(([k, label]) => {
      const e = o.event_map[k];
      const inp = h('input', { type: 'text', value: e.value, placeholder: DEFAULT_EVENTS[k], oninput: on(e, 'value'), class: e.mode === 'custom' ? '' : 'hide' });
      const sel = h(
        'select',
        {
          value: e.mode,
          style: 'width:auto',
          onchange: (ev) => {
            e.mode = ev.target.value;
            inp.classList.toggle('hide', e.mode !== 'custom');
            touch();
          },
        },
        h('option', { value: 'default' }, 'По умолчанию: ' + DEFAULT_EVENTS[k]),
        h('option', { value: 'custom' }, 'Своё название'),
        h('option', { value: 'off' }, 'Не отправлять'),
      );
      return h('div', { class: 'field' }, h('label', null, label), h('div', { class: 'inline' }, sel, inp));
    });

    return h(
      'div',
      { style: 'max-width:640px' },
      field('Название', h('input', { type: 'text', value: o.name, maxlength: 100, oninput: on(o, 'name') })),
      h('div', { class: 'grid2' }, field('Статус', h('select', { value: o.status, onchange: on(o, 'status') }, h('option', { value: 'active' }, 'Активна'), h('option', { value: 'paused' }, 'На паузе — лендинг не открывается'))), field('Адрес в ссылке (slug)', h('input', { type: 'text', value: o.slug, disabled: true }), 'Менять нельзя: он уже может быть в рекламе.')),
      field('Канал Telegram', chanSel, channels.length ? 'Канал и бот подключаются в разделе «Боты и каналы».' : 'Пока нет каналов — подключите бота и канал в разделе «Боты и каналы».'),
      h('label', { class: 'check', style: 'margin-bottom:16px' }, h('input', { type: 'checkbox', checked: o.auto_approve, onchange: on(o, 'auto_approve') }), 'Автоматически принимать заявки на вступление'),
      domainField(),
      h('h2', { style: 'margin-top:26px' }, 'Пиксель Facebook'),
      h('p', { class: 'muted', style: 'margin-top:-6px' }, 'Применяется сразу, без кнопки «Сохранить».'),
      pixBox,
      h('h2', { style: 'margin-top:26px' }, 'События для Facebook'),
      h('p', { class: 'muted', style: 'margin-top:-6px' }, 'Какими именно событиями отправлять этапы воронки. Обычно ничего менять не нужно.'),
      evRows,
    );
  }

  // ── Лендинг
  function tabLanding() {
    const frame = h('iframe', { sandbox: 'allow-scripts', title: 'Предпросмотр лендинга' });
    const previewErr = h('div', { class: 'note bad hide' });
    const updatePreview = debounce(async () => {
      try {
        const r = await api('POST', '/landing/preview', {
          offer: id,
          name: o.name,
          landing_type: o.landing_type,
          landing: cleanLanding(o.landing),
          landing_html: o.landing_html.trim() ? o.landing_html : null,
        });
        frame.srcdoc = r.html;
        previewErr.classList.add('hide');
      } catch (e) {
        previewErr.textContent = e.message;
        previewErr.classList.remove('hide');
      }
    }, 350);
    const L = o.landing;
    const t = (k, label, hint, extra = {}) => field(label, h('input', { type: 'text', value: L[k] || '', oninput: on(L, k, updatePreview), ...extra }), hint);

    const typeSwitch = h(
      'div',
      { class: 'inline', style: 'margin-bottom:18px;gap:18px' },
      ['default', 'custom'].map((v) =>
        h(
          'label',
          { class: 'check' },
          h('input', { type: 'radio', name: 'ltype', checked: o.landing_type === v, onchange: () => ((o.landing_type = v), touch(), drawBody()) }),
          v === 'default' ? 'Встроенный шаблон' : 'Свой HTML или ZIP',
        ),
      ),
    );

    let editor;
    if (o.landing_type === 'default') {
      editor = h(
        'div',
        null,
        t('title', 'Заголовок', 'Если пусто — название кампании.', { maxlength: 120 }),
        t('subtitle', 'Описание под заголовком', null, { maxlength: 400 }),
        field('Текст', h('textarea', { oninput: on(L, 'text', updatePreview), maxlength: 2000 }, L.text || ''), 'Переносы строк сохраняются.'),
        h('div', { class: 'grid2' }, t('avatar_url', 'Аватарка (ссылка на картинку)', null, { placeholder: 'https://…' }), t('count_text', 'Число подписчиков', 'Любой текст, например «12 480 подписчиков».')),
        t('image_url', 'Большая картинка (ссылка)', 'Показывается над заголовком.', { placeholder: 'https://…' }),
        field('Пункты списка', h('textarea', { oninput: on(L, 'bulletsText', updatePreview), style: 'min-height:96px' }, L.bulletsText), 'По одному в строке, не больше шести.'),
        h('div', { class: 'grid3' }, t('button_text', 'Текст кнопки', null, { placeholder: 'Перейти в Telegram', maxlength: 40 }), field('Цвет кнопки', h('input', { type: 'color', value: L.accent, oninput: on(L, 'accent', updatePreview) })), field('Тема', h('select', { value: L.theme, onchange: on(L, 'theme', updatePreview) }, h('option', { value: 'dark' }, 'Тёмная'), h('option', { value: 'light' }, 'Светлая')))),
        t('footer', 'Мелкий текст внизу', null, { maxlength: 300 }),
        h(
          'details',
          { class: 'more' },
          h('summary', null, 'Свой код (CSS и скрипты)'),
          field('CSS', h('textarea', { class: 'code', style: 'min-height:110px', oninput: on(L, 'custom_css', updatePreview) }, L.custom_css || '')),
          field('Код в <head>', h('textarea', { class: 'code', style: 'min-height:110px', oninput: on(L, 'head_html', updatePreview) }, L.head_html || ''), 'Например, дополнительные пиксели или счётчики.'),
          field('Код в конце <body>', h('textarea', { class: 'code', style: 'min-height:110px', oninput: on(L, 'body_html', updatePreview) }, L.body_html || '')),
        ),
      );
    } else {
      const status = h('div');
      const drawStatus = () => {
        const n = ctaIn(o.landing_html);
        status.replaceChildren(
          !o.landing_html.trim()
            ? h('div', { class: 'note warn' }, 'HTML пока не загружен — вставьте код ниже или загрузите ZIP.')
            : n
              ? h('div', { class: 'note ok' }, `Кнопок перехода в Telegram найдено: ${n}.`)
              : h('div', { class: 'note bad' }, 'Не найдено ни одной кнопки перехода. Добавьте к ссылке или кнопке атрибут data-tg-link либо укажите href="{{tg_link}}".'),
        );
      };
      const ta = h('textarea', { class: 'code', spellcheck: 'false', oninput: (e) => ((o.landing_html = e.target.value), touch(), drawStatus(), updatePreview()) });
      ta.value = o.landing_html;
      const file = h('input', { type: 'file', accept: '.zip,application/zip', class: 'hide', onchange: guard(async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        const r = await api('PUT', `/offers/${id}/landing-zip`, await f.arrayBuffer(), { raw: true, headers: { 'content-type': 'application/zip' } });
        const fresh = await api('GET', '/offers/' + id);
        o.landing_type = 'custom';
        o.landing_html = fresh.landing_html || '';
        o.has_assets = fresh.has_assets;
        toast(`Загружено файлов: ${r.files}` + (r.skipped.length ? `, пропущено: ${r.skipped.length}` : ''), false);
        if (r.skipped.length) toast('Пропущены неподдерживаемые файлы: ' + r.skipped.slice(0, 4).join(', '), true);
        e.target.value = '';
        drawBody();
      }) });
      drawStatus();
      editor = h(
        'div',
        null,
        status,
        h('div', { class: 'actions', style: 'margin-bottom:12px' }, h('button', { class: 'btn', onclick: () => file.click() }, 'Загрузить ZIP'), file, o.has_assets ? h('span', { class: 'chip ok' }, 'Файлы из ZIP загружены') : h('span', { class: 'muted' }, 'В архиве должен быть index.html в корне; картинки, CSS и JS — рядом.')),
        field('HTML страницы', ta, 'Пиксель и отслеживание добавятся автоматически. Кнопка перехода — любой элемент с атрибутом data-tg-link или ссылка href="{{tg_link}}". Загрузка ZIP сразу сохраняет страницу.'),
      );
    }
    updatePreview();
    return h('div', { class: 'split' }, h('div', null, typeSwitch, editor), h('div', { class: 'preview' }, h('h3', null, 'Предпросмотр'), previewErr, h('div', { class: 'phone' }, frame), h('p', { class: 'muted', style: 'text-align:center;font-size:13px' }, 'Кнопка в предпросмотре не работает — это нормально.')));
  }

  // ── Приветствия
  function tabWelcome() {
    const list = h('div');
    const draw = () => {
      list.replaceChildren(
        ...o.welcome.map((s, i) => {
          const btns = h('div');
          const drawBtns = () =>
            btns.replaceChildren(
              ...s.buttons.map((b, j) =>
                h(
                  'div',
                  { class: 'btnrow' },
                  h('input', { type: 'text', placeholder: 'Текст кнопки', value: b.text, oninput: on(b, 'text') }),
                  h('input', { type: 'url', placeholder: 'https://…', value: b.url, oninput: on(b, 'url') }),
                  h('button', { class: 'btn sm', onclick: () => (s.buttons.splice(j, 1), touch(), drawBtns()) }, 'Убрать'),
                ),
              ),
            );
          drawBtns();
          return h(
            'div',
            { class: 'stepcard' },
            h(
              'div',
              { class: 'top' },
              h('b', null, `Сообщение ${i + 1}`),
              h(
                'div',
                { class: 'actions' },
                i > 0 ? h('button', { class: 'btn sm', onclick: () => (([o.welcome[i - 1], o.welcome[i]] = [o.welcome[i], o.welcome[i - 1]]), touch(), draw()) }, 'Выше') : null,
                h('button', { class: 'btn sm danger', onclick: () => (o.welcome.splice(i, 1), touch(), draw()) }, 'Удалить'),
              ),
            ),
            field('Текст', h('textarea', { oninput: on(s, 'text'), maxlength: 4000 }, s.text), 'Можно <b>жирный</b>, <i>курсив</i> и <a href="…">ссылки</a>. Подстановки: {first_name}, {username}.'),
            h('div', { class: 'field' }, h('label', null, 'Отправить через'), h('div', { class: 'inline' }, h('input', { type: 'number', min: 0, value: s.value, oninput: on(s, 'value') }), h('select', { value: s.unit, onchange: on(s, 'unit') }, h('option', { value: 's' }, 'сек.'), h('option', { value: 'm' }, 'мин.'), h('option', { value: 'h' }, 'ч.'))), h('div', { class: 'hint' }, i === 0 || Number(s.value) === 0 ? '0 — сразу, ещё до одобрения заявки.' : 'Доставится, только если человек успел нажать Start у бота.')),
            field('Картинка (ссылка)', h('input', { type: 'url', value: s.photo_url, placeholder: 'https://…', oninput: on(s, 'photo_url') }), 'С картинкой текст не длиннее 1024 символов.'),
            h('div', { class: 'field' }, h('label', null, 'Кнопки под сообщением'), btns, s.buttons.length < 4 ? h('div', null, h('button', { class: 'btn sm', onclick: () => (s.buttons.push({ text: '', url: '' }), touch(), drawBtns()) }, 'Добавить кнопку')) : null),
          );
        }),
        o.welcome.length ? null : h('div', { class: 'note' }, 'Приветствий пока нет. Человек просто попадёт в канал без сообщения от бота.'),
        o.welcome.length < 10 ? h('button', { class: 'btn', onclick: () => (o.welcome.push({ text: '', photo_url: '', buttons: [], value: 0, unit: 's' }), touch(), draw()) }, 'Добавить сообщение') : null,
      );
    };
    draw();
    return h('div', { style: 'max-width:680px' }, h('p', { class: 'muted' }, 'Бот пишет человеку в личные сообщения, когда тот подаёт заявку в канал.'), list);
  }

  // ── Ссылка
  function tabLink() {
    const box = h('div', null, h('p', { class: 'muted' }, 'Загрузка…'));
    api('GET', `/offers/${id}/link`)
      .then((l) => {
        const row = (label, val, hint) => field(label, h('div', { class: 'copyrow' }, h('input', { type: 'text', readonly: true, value: val, onfocus: (e) => e.target.select() }), h('button', { class: 'btn', onclick: () => copy(val) }, 'Копировать')), hint);
        const testOut = h('div');
        box.replaceChildren(...[
          dirty ? h('div', { class: 'note warn' }, 'Есть несохранённые изменения — сначала нажмите «Сохранить», иначе ссылка и проверка покажут старое состояние.') : null,
          l.ready ? h('div', { class: 'note ok' }, 'Кампания готова к запуску.') : h('div', { class: 'note bad' }, 'Кампания пока не готова:', h('ul', null, l.blocking_issues.map((t) => h('li', null, t)))),
          l.warnings.length ? h('div', { class: 'note warn' }, h('ul', { style: 'margin:0' }, l.warnings.map((t) => h('li', null, t)))) : null,
          h('div', { style: 'max-width:760px' },
            row('Ссылка на лендинг', l.landing_url, 'Её вставляют в поле «Веб-сайт» объявления.'),
            row('Ссылка с параметрами для Facebook', l.ad_url, 'Те же параметры с макросами — кампания, адсет и объявление подставятся автоматически.'),
            row('Только параметры URL', l.url_tags, 'Если вставляете в отдельное поле «Параметры URL» в Ads Manager.'),
            h('h2', { style: 'margin-top:26px' }, 'Проверка пикселя'),
            h('p', { class: 'muted' }, 'Отправит тестовое событие Lead через Conversions API. Результат смотрите в Events Manager → Тестовые события. Нужны токен и код тестовых событий.'),
            h('button', { class: 'btn', onclick: guard(async (e) => {
              e.target.disabled = true;
              try {
                const r = await api('POST', `/offers/${id}/test-capi`);
                testOut.replaceChildren(r.ok ? h('div', { class: 'note ok' }, 'Facebook принял тестовое событие.') : h('div', { class: 'note bad' }, 'Facebook не принял событие: ' + (r.response?.error?.message || r.error || r.skipped || r.status)));
              } finally {
                e.target.disabled = false;
              }
            }) }, 'Отправить тестовое событие'),
            testOut,
          ),
        ].filter(Boolean));
      })
      .catch((e) => box.replaceChildren(h('div', { class: 'note bad' }, e.message)));
    return box;
  }

  const del = h('button', { class: 'btn danger', onclick: guard(async () => {
    if (!confirm(`Удалить кампанию «${o.name}» вместе со всей статистикой? Это нельзя отменить.`)) return;
    await api('DELETE', '/offers/' + id);
    location.hash = '#/campaigns';
  }) }, 'Удалить');

  drawTabs();
  drawBody();
  const bar = h('div', { class: 'savebar' }, saveBtn, dirtyNote, h('span', { style: 'flex:1' }), del);
  window.onbeforeunload = () => (dirty ? 'Есть несохранённые изменения' : undefined);
  return h('div', null, h('p', { style: 'margin:0 0 10px' }, h('a', { href: '#/campaigns' }, '← Все кампании')), h('div', { class: 'head' }, title), tabsEl, body, bar);
}

// ───────────────────────── Боты и каналы ─────────────────────────

async function pageBots() {
  const [bots, channels] = await Promise.all([api('GET', '/bots'), api('GET', '/channels')]);
  const reload = () => route();
  const token = h('input', { type: 'text', placeholder: '123456789:AAH…', autocomplete: 'off' });
  const botName = h('input', { type: 'text', placeholder: 'Необязательно' });
  const chat = h('input', { type: 'text', placeholder: '@my_channel или -1001234567890' });
  const chName = h('input', { type: 'text', placeholder: 'Необязательно' });
  const botSel = h('select', null, bots.map((b) => h('option', { value: b.id }, '@' + b.username)));
  const warnBox = h('div');
  const showWarn = (w) => warnBox.replaceChildren(...(w.length ? [h('div', { class: 'note warn' }, h('ul', { style: 'margin:0' }, w.map((t) => h('li', null, t))))] : []));

  return h(
    'div',
    null,
    pageHead('Боты и каналы', 'Бота вы создаёте сами в @BotFather. Он должен быть администратором канала с правом «Приглашение пользователей».'),
    h(
      'section',
      { class: 'block' },
      h('h2', null, 'Боты'),
      table(
        [
          { t: 'Бот', f: (b) => '@' + b.username },
          { t: 'Название', f: (b) => b.name },
          { t: 'Токен', f: (b) => b.token_masked },
          {
            t: '',
            f: (b) =>
              h(
                'div',
                { class: 'actions' },
                h('button', { class: 'btn sm', onclick: guard(async () => (await api('POST', `/bots/${b.id}/webhook`), toast('Вебхук обновлён'))) }, 'Обновить вебхук'),
                h('button', { class: 'btn sm danger', onclick: guard(async () => {
                  if (!confirm(`Отключить @${b.username}? Его каналы пропадут из панели, кампании останутся без канала.`)) return;
                  await api('DELETE', '/bots/' + b.id);
                  reload();
                }) }, 'Отключить'),
              ),
          },
        ],
        bots,
        { emptyTitle: 'Ботов пока нет', emptyText: 'Подключите первого ниже.' },
      ),
      h('div', { style: 'max-width:520px;margin-top:18px' },
        h('h3', null, 'Подключить бота'),
        field('Токен от @BotFather', token),
        field('Название', botName),
        h('button', { class: 'btn primary', onclick: guard(async (e) => {
          e.target.disabled = true;
          try {
            const r = await api('POST', '/bots', { token: token.value.trim(), ...(botName.value.trim() ? { name: botName.value.trim() } : {}) });
            toast('Бот @' + r.bot.username + ' подключён');
            if (r.warnings.length) toast(r.warnings[0], true);
            reload();
          } finally {
            e.target.disabled = false;
          }
        }) }, 'Подключить'),
      ),
    ),
    h(
      'section',
      { class: 'block' },
      h('h2', null, 'Каналы'),
      table(
        [
          { t: 'Канал', f: (c) => c.title || c.name },
          { t: 'Адрес', f: (c) => (c.username ? '@' + c.username : '—') },
          { t: 'ID чата', f: (c) => c.chat_id },
          { t: 'Бот', f: (c) => '@' + (bots.find((b) => b.id === c.bot_id)?.username ?? '?') },
          { t: '', f: (c) => h('button', { class: 'btn sm danger', onclick: guard(async () => {
            if (!confirm(`Убрать канал «${c.title || c.name}» из панели? Сам канал в Telegram не изменится.`)) return;
            await api('DELETE', '/channels/' + c.id);
            reload();
          }) }, 'Убрать') },
        ],
        channels,
        { emptyTitle: 'Каналов пока нет', emptyText: bots.length ? 'Подключите канал ниже.' : 'Сначала подключите бота.' },
      ),
      bots.length
        ? h('div', { style: 'max-width:520px;margin-top:18px' },
            h('h3', null, 'Подключить канал'),
            field('Канал', chat, 'Для публичного канала — @username, для закрытого — числовой ID (-100…).'),
            bots.length > 1 ? field('Через какого бота', botSel) : null,
            field('Название', chName),
            h('button', { class: 'btn primary', onclick: guard(async (e) => {
              e.target.disabled = true;
              try {
                const r = await api('POST', '/channels', { chat: chat.value.trim(), ...(bots.length > 1 ? { bot: botSel.value } : { bot: bots[0].id }), ...(chName.value.trim() ? { name: chName.value.trim() } : {}) });
                if (r.warnings.length) {
                  showWarn(r.warnings);
                  toast('Канал подключён, но есть замечания', true);
                } else {
                  toast('Канал подключён');
                  reload();
                }
              } finally {
                e.target.disabled = false;
              }
            }) }, 'Подключить'),
            warnBox,
          )
        : null,
    ),
  );
}

// ───────────────────────── Домены ─────────────────────────

function addDomainModal(onDone) {
  const inp = h('input', { type: 'text', placeholder: 'go.example.com', autocapitalize: 'off', autocomplete: 'off', spellcheck: false });
  modal(
    'Добавить домен',
    h(
      'div',
      null,
      h(
        'ol',
        { class: 'steps' },
        h('li', null, 'Купите домен у любого регистратора (например Namecheap, Porkbun, Cloudflare). Если домен уже куплен — сразу к шагу 2.'),
        h('li', null, 'Впишите его в поле ниже. Лучше поддомен вида go.example.com — основной сайт останется свободным. Можно и корень: example.com.'),
        h('li', null, 'Нажмите «Добавить». Панель покажет, какие DNS-записи создать у регистратора, и проверит, когда всё заработает.'),
      ),
      field('Домен', inp, 'Без https:// и без слэшей. Например: go.example.com'),
    ),
    (close) => [
      h('button', { class: 'btn', onclick: close }, 'Отмена'),
      h('button', { class: 'btn primary', onclick: guard(async (e) => {
        if (!inp.value.trim()) throw new Error('Впишите домен, например go.example.com');
        e.target.disabled = true;
        try {
          const d = await api('POST', '/domains', { host: inp.value });
          close();
          if (d.render_error) toast('Домен добавлен, но в Render автоматически не добавился — см. подсказку в карточке домена', true);
          await onDone(d.host);
        } finally {
          e.target.disabled = false;
        }
      }) }, 'Добавить'),
    ],
  );
  inp.addEventListener('keydown', (e) => e.key === 'Enter' && inp.closest('.modal').querySelector('.btn.primary').click());
}

async function pageDomains() {
  const data = await api('GET', '/domains');
  const cards = data.domains.map((d) => {
    const active = d.status === 'active';
    const steps = [];
    if (!active) {
      steps.push(
        h('li', null, data.auto_render
          ? 'Домен уже отправлен в хостинг (Render) автоматически — делать ничего не нужно.'
          : h('span', null, 'Добавьте домен в хостинге. На Render: откройте ваш сервис → ', h('b', null, 'Settings'), ' → ', h('b', null, 'Custom Domains'), ' → ', h('b', null, 'Add Custom Domain'), ' → впишите ', h('b', null, d.host), ' → нажмите ', h('b', null, 'Save'), '. Дальше Render покажет свои записи — они такие же, как ниже.')),
        h('li', null,
          h('div', null, 'У регистратора откройте настройки домена → раздел ', h('b', null, 'DNS'), ' (может называться DNS Records, Advanced DNS, Управление DNS) и нажмите ', h('b', null, 'Add record'), '. Создайте записи:'),
          table(
            [
              { t: 'Тип', f: (r) => h('b', null, r.type) },
              { t: 'Имя (Host)', f: (r) => h('span', null, r.name, ' ', h('button', { class: 'btn sm', onclick: () => copy(r.name) }, 'Копировать')) },
              { t: 'Значение (Target / Value)', f: (r) => h('span', null, r.value, ' ', h('button', { class: 'btn sm', onclick: () => copy(r.value) }, 'Копировать')) },
              { t: 'Комментарий', f: (r) => r.note || '' },
            ],
            d.setup.records,
          ),
          h('ul', { class: 'tips' }, d.setup.tips.map((t) => h('li', null, t))),
        ),
        h('li', null, 'Подождите 5–30 минут (иногда до 24 часов) и нажмите «Проверить». Когда статус станет «Готов» — домен можно выбирать в кампании.'),
      );
    }
    return h(
      'div',
      { class: 'dcard' },
      h('div', { class: 'dhead' },
        h('div', null, h('b', { class: 'dhost' }, d.host), ' ', active ? h('span', { class: 'chip ok' }, 'Готов') : h('span', { class: 'chip warn' }, 'Ждёт настройки')),
        h('div', { class: 'actions' },
          h('button', { class: 'btn sm', onclick: guard(async (e) => {
            e.target.disabled = true;
            try {
              const r = await api('POST', '/domains/' + d.id + '/check');
              toast(r.status === 'active' ? 'Домен готов к работе' : 'Пока не готов — причина в карточке домена', r.status !== 'active');
            } finally {
              route();
            }
          }) }, 'Проверить'),
          h('button', { class: 'btn sm danger', onclick: guard(async () => {
            if (!confirm(`Удалить домен ${d.host}?`)) return;
            await api('DELETE', '/domains/' + d.id);
            route();
          }) }, 'Удалить'),
        ),
      ),
      d.problem && !active ? h('div', { class: 'note warn' }, d.problem) : null,
      d.checked_at ? h('div', { class: 'hint' }, 'Последняя проверка: ' + fmtDate(d.checked_at)) : null,
      h('div', { class: 'hint' }, d.offers.length ? 'Используется в кампаниях: ' + d.offers.map((x) => x.name).join(', ') : 'Пока не выбран ни в одной кампании. Выберите: Кампании → кампания → вкладка «Основное» → «Домен лендинга».'),
      steps.length ? h('ol', { class: 'steps' }, steps) : null,
    );
  });
  return h(
    'div',
    null,
    pageHead('Домены', 'Свой домен для лендингов: выглядит надёжнее в рекламе, чем адрес сервиса. Один домен — одна кампания.', h('button', { class: 'btn primary', onclick: () => addDomainModal(() => route()) }, 'Добавить домен')),
    data.domains.length
      ? h('div', { class: 'dlist' }, cards)
      : h('div', { class: 'note' }, h('b', null, 'Доменов пока нет. '), 'Нажмите «Добавить домен» справа вверху — панель проведёт по шагам: что купить, что вписать и какие DNS-записи создать у регистратора.'),
    h('div', { class: 'note', style: 'margin-top:18px' }, h('b', null, 'Важно. '), 'Сама панель открывается только по адресу ', h('b', null, data.panel_host), ' — это защита от чужого кода на лендингах. Свои домены нужны только для лендингов.'),
  );
}

// ───────────────────────── Пиксели ─────────────────────────

async function pagePixels() {
  const pixels = await api('GET', '/pixels');
  const edit = (p) => {
    const f = {
      name: h('input', { type: 'text', value: p?.name || '' }),
      pixel: h('input', { type: 'text', inputmode: 'numeric', value: p?.pixel_id || '', placeholder: '123456789012345' }),
      token: h('input', { type: 'text', placeholder: p?.has_capi_token ? 'Задан: ' + p.capi_token_masked + ' — оставьте пустым, чтобы не менять' : 'EAAB…' }),
      test: h('input', { type: 'text', value: p?.test_event_code || '' }),
    };
    const clear = p?.has_capi_token ? h('input', { type: 'checkbox' }) : null;
    modal(
      p ? 'Изменить пиксель' : 'Новый пиксель',
      h('div', null, field('Название', f.name), field('ID пикселя', f.pixel), field('Токен Conversions API', f.token), clear ? h('label', { class: 'check', style: 'margin:-6px 0 14px' }, clear, 'Удалить сохранённый токен') : null, field('Код тестовых событий', f.test)),
      (close) => [
        h('button', { class: 'btn', onclick: close }, 'Отмена'),
        h('button', { class: 'btn primary', onclick: guard(async () => {
          const body = { name: f.name.value.trim() || `Pixel ${f.pixel.value.trim()}`, pixel_id: f.pixel.value.trim(), test_event_code: f.test.value.trim() || (p ? null : undefined) };
          if (f.token.value.trim()) body.capi_token = f.token.value.trim();
          else if (clear?.checked) body.capi_token = null;
          if (p) await api('PATCH', '/pixels/' + p.id, body);
          else await api('POST', '/pixels', body);
          close();
          route();
        }) }, 'Сохранить'),
      ],
    );
  };
  return h(
    'div',
    null,
    pageHead('Пиксели', 'Пиксель привязывается к кампании. Токен Conversions API нужен, чтобы заявки и подписки (они происходят в Telegram) попадали в Facebook.', h('button', { class: 'btn primary', onclick: () => edit(null) }, 'Добавить пиксель')),
    table(
      [
        { t: 'Название', f: (p) => p.name },
        { t: 'ID пикселя', f: (p) => p.pixel_id },
        { t: 'Токен CAPI', f: (p) => (p.has_capi_token ? h('span', { class: 'chip ok' }, p.capi_token_masked) : h('span', { class: 'chip warn' }, 'не задан')) },
        { t: 'Тестовый код', f: (p) => p.test_event_code || '—' },
        { t: '', f: (p) => h('div', { class: 'actions' }, h('button', { class: 'btn sm', onclick: () => edit(p) }, 'Изменить'), h('button', { class: 'btn sm danger', onclick: guard(async () => {
          if (!confirm(`Удалить пиксель «${p.name}»? У кампаний он отвяжется.`)) return;
          await api('DELETE', '/pixels/' + p.id);
          route();
        }) }, 'Удалить')) },
      ],
      pixels,
      { emptyTitle: 'Пикселей пока нет', emptyText: 'Добавьте пиксель здесь или прямо в кампании.' },
    ),
  );
}

// ───────────────────────── Подписчики и события ─────────────────────────

async function pageSubscribers() {
  const offers = await api('GET', '/offers');
  const st = { offer: '', status: '', offset: 0 };
  const LIMIT = 50;
  const out = h('div');
  const load = guard(async () => {
    const rows = await api('GET', '/subscribers' + qs({ offer: st.offer, status: st.status, limit: LIMIT, offset: st.offset }));
    const statusChip = (s) => h('span', { class: 'chip ' + (s === 'member' ? 'ok' : s === 'left' ? 'bad' : 'warn') }, { member: 'Подписан', left: 'Отписался', requested: 'Заявка' }[s] || s);
    out.replaceChildren(
      table(
        [
          { t: 'Заявка', f: (r) => fmtDate(r.requested_at) },
          { t: 'Пользователь', f: (r) => [r.first_name || '—', r.username ? ' @' + r.username : ''].join('') },
          { t: 'Telegram ID', f: (r) => r.tg_user_id },
          { t: 'Статус', f: (r) => statusChip(r.status) },
          { t: 'Кампания', f: (r) => r.offer },
          { t: 'utm_campaign', wrap: 1, f: (r) => r.utm?.utm_campaign || '—' },
          { t: 'Объявление', wrap: 1, f: (r) => r.utm?.utm_content || r.params?.ad_id || '—' },
        ],
        rows,
        { emptyTitle: 'Подписчиков не найдено', emptyText: 'Они появятся, когда люди начнут подавать заявки в канал.' },
      ),
      h('div', { class: 'pager' }, h('button', { class: 'btn sm', disabled: st.offset === 0, onclick: () => ((st.offset = Math.max(0, st.offset - LIMIT)), load()) }, 'Назад'), h('button', { class: 'btn sm', disabled: rows.length < LIMIT, onclick: () => ((st.offset += LIMIT), load()) }, 'Дальше')),
    );
  });
  const sel = (key, opts) => h('select', { onchange: (e) => ((st[key] = e.target.value), (st.offset = 0), load()) }, opts.map(([v, t]) => h('option', { value: v }, t)));
  const view = h('div', null, pageHead('Подписчики', 'Кто подал заявку, подписался или отписался — и из какой рекламы пришёл.'), h('div', { class: 'filters' }, field('Кампания', sel('offer', [['', 'Все'], ...offers.map((o) => [o.id, o.name])])), field('Статус', sel('status', [['', 'Любой'], ['member', 'Подписан'], ['requested', 'Заявка'], ['left', 'Отписался']]))), out);
  load();
  return view;
}

async function pageEvents() {
  const offers = await api('GET', '/offers');
  const st = { offer: '', type: '' };
  const out = h('div');
  const load = guard(async () => {
    const rows = await api('GET', '/events' + qs({ offer: st.offer, type: st.type, limit: 100 }));
    const capi = (r) => {
      const c = r.capi;
      if (!c) return h('span', { class: 'muted' }, '—');
      if (c.pending) return h('span', { class: 'chip warn' }, 'отправляется');
      if (c.ok) return h('span', { class: 'chip ok' }, 'отправлено');
      if (c.skipped) return h('span', { class: 'chip warn', title: c.skipped }, { no_pixel: 'нет пикселя', no_capi_token: 'нет токена', unmapped: 'отключено', no_visit: 'нет визита' }[c.skipped] || c.skipped);
      return h('span', { class: 'chip bad', title: c.response?.error?.message || c.error || '' }, 'ошибка ' + (c.status || ''));
    };
    out.replaceChildren(
      table(
        [
          { t: 'Время', f: (r) => fmtDate(r.created_at) },
          { t: 'Событие', f: (r) => EVENT_LABELS[r.type] || r.type },
          { t: 'Кампания', f: (r) => r.offer || '—' },
          { t: 'Telegram ID', f: (r) => r.tg_user_id || '—' },
          { t: 'Отправка в Facebook', f: capi },
          { t: 'Подробности', wrap: 1, f: (r) => (r.meta?.error ? r.meta.error : r.capi?.response?.error?.message || '') },
        ],
        rows,
        { emptyTitle: 'Событий пока нет', emptyText: 'Откройте ссылку лендинга — первое событие появится здесь.' },
      ),
    );
  });
  const sel = (key, opts) => h('select', { onchange: (e) => ((st[key] = e.target.value), load()) }, opts.map(([v, t]) => h('option', { value: v }, t)));
  const view = h('div', null, pageHead('События', 'Последние 100 событий и статус их отправки в Facebook — удобно для отладки.', h('button', { class: 'btn', onclick: load }, 'Обновить')), h('div', { class: 'filters' }, field('Кампания', sel('offer', [['', 'Все'], ...offers.map((o) => [o.id, o.name])])), field('Событие', sel('type', [['', 'Все'], ...['page_view', 'click', 'join_request', 'member_joined', 'left'].map((k) => [k, EVENT_LABELS[k]])]))), out);
  load();
  return view;
}

// ───────────────────────── Подключение нейросети ─────────────────────────

async function pageConnect() {
  const m = state.meta;
  const cmd = `claude mcp add --transport http fb-tg-crm ${m.mcp_url} --header "Authorization: Bearer ВАШ_API_КЛЮЧ"`;
  const block = (text) => h('div', { class: 'copyrow', style: 'align-items:flex-start' }, h('pre', { class: 'cmd', style: 'flex:1;margin:0' }, text), h('button', { class: 'btn', onclick: () => copy(text) }, 'Копировать'));
  return h(
    'div',
    { style: 'max-width:760px' },
    pageHead('Подключение нейросети', 'Всё, что можно сделать в панели, нейросеть может сделать сама через MCP или REST API — кроме удаления кампаний.'),
    h('section', { class: 'block' }, h('h2', null, 'MCP-сервер'), h('p', { class: 'muted' }, 'Адрес для любого клиента с поддержкой MCP (Streamable HTTP). Авторизация — заголовок Authorization: Bearer с вашим API-ключом.'), block(m.mcp_url), h('p', { class: 'muted' }, 'Для Claude Code:'), block(cmd)),
    h('section', { class: 'block' }, h('h2', null, 'API-ключ'), h('p', null, 'Ключ задаётся на сервере в переменной окружения API_KEYS (можно несколько через запятую). В панели он не показывается. Чтобы выдать нейросети отдельный ключ, добавьте второй и при необходимости удалите его позже.')),
    h('section', { class: 'block' }, h('h2', null, 'REST API'), h('p', { class: 'muted' }, 'Тот же ключ работает и для обычных запросов:'), block(`curl ${m.public_url}/api/v1/offers -H "Authorization: Bearer ВАШ_API_КЛЮЧ"`), h('p', { class: 'muted' }, 'Список всех операций: GET /api/v1/ops.')),
    h('section', { class: 'block' }, h('h2', null, 'Что попросить у нейросети'), h('p', null, 'Например: «Подключи канал @my_channel, создай кампанию „Сигналы“ с приветствием „Привет, {first_name}!“, привяжи пиксель 123456789012345 с токеном … и дай ссылку для залива».')),
  );
}

// ───────────────────────── запуск ─────────────────────────

async function boot() {
  const me = await fetch('/admin/me', { credentials: 'same-origin' });
  if (!me.ok) return showLogin();
  state.meta = await api('GET', '/meta');
  shell();
  route();
}

window.addEventListener('hashchange', () => {
  window.onbeforeunload = null;
  route();
});
boot();
