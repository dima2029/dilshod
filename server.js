const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Конфигурация (всё из переменных окружения Railway) ----------
// База Postgres в Railway. Railway сам подставляет DATABASE_URL.
const DATABASE_URL = process.env.DATABASE_URL;

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const NOTIFY_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // куда слать уведомления
const TG_ADMINS = (process.env.TELEGRAM_ADMINS || NOTIFY_CHAT_ID || '')
  .split(',').map(s => s.trim()).filter(Boolean); // кому разрешены команды

// МойСклад
const MS_API = process.env.MOYSKLAD_API_URL || 'https://api.moysklad.ru/api/remap/1.2';
const MS_TOKEN = process.env.MOYSKLAD_TOKEN;
const MS_LOGIN = process.env.MOYSKLAD_LOGIN;
const MS_PASSWORD = process.env.MOYSKLAD_PASSWORD;
const MS_MATCH_FIELD = process.env.MOYSKLAD_MATCH_FIELD || 'article'; // article | code

const TG = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false
});

async function initDB() {
  if (!DATABASE_URL) throw new Error('Не задана переменная окружения DATABASE_URL (добавь базу Postgres в Railway)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      article    TEXT PRIMARY KEY,
      name       TEXT,
      warehouse  TEXT DEFAULT '1',
      floor      TEXT,
      "row"      TEXT,
      cell       TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  console.log('✅ Postgres подключён, таблица items готова');
}

// ======================================================================
//  REST API (сайт)
// ======================================================================
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Получить все товары
app.get('/api/items', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM items ORDER BY created_at');
  res.json(rows);
});

// Добавить товар
app.post('/api/items', async (req, res) => {
  const { article, name, warehouse, floor, row, cell } = req.body;
  if (!article) return res.status(400).json({ error: 'Артикул обязателен' });

  const key = article.toUpperCase();
  const exists = await pool.query('SELECT 1 FROM items WHERE article = $1', [key]);
  if (exists.rowCount) return res.status(400).json({ error: 'Товар уже существует' });

  await pool.query(
    `INSERT INTO items (article, name, warehouse, floor, "row", cell)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [key, name || key, warehouse || '1', floor || null, row || null, cell || null]
  );
  notify(`➕ Добавлен товар\nАртикул: <b>${esc(key)}</b>\nНазвание: ${esc(name || key)}`);
  res.json({ success: true });
});

// Обновить товар
app.patch('/api/items/:article', async (req, res) => {
  const allowed = ['name', 'warehouse', 'floor', 'row', 'cell'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (k in req.body) {
      vals.push(req.body[k]);
      sets.push(`"${k}" = $${vals.length}`);
    }
  }
  if (sets.length) {
    vals.push(req.params.article);
    await pool.query(`UPDATE items SET ${sets.join(', ')} WHERE article = $${vals.length}`, vals);
  }
  notify(`✏️ Изменён товар <b>${esc(req.params.article)}</b>`);
  res.json({ success: true });
});

// Удалить товар
app.delete('/api/items/:article', async (req, res) => {
  await pool.query('DELETE FROM items WHERE article = $1', [req.params.article]);
  notify(`🗑 Удалён товар <b>${esc(req.params.article)}</b>`);
  res.json({ success: true });
});

// Удалить все
app.delete('/api/items', async (req, res) => {
  await pool.query('DELETE FROM items');
  notify('⚠️ Удалены <b>все</b> товары');
  res.json({ success: true });
});

// Импорт
app.post('/api/items/import', async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'Нет данных' });

  let added = 0;
  for (const item of items) {
    const key = item.article.toUpperCase();
    const r = await pool.query(
      `INSERT INTO items (article, name)
       VALUES ($1, $2)
       ON CONFLICT (article) DO NOTHING`,
      [key, item.name || key]
    );
    added += r.rowCount;
  }

  notify(`📥 Импорт: добавлено <b>${added}</b>, пропущено ${items.length - added}`);
  res.json({ success: true, added, skipped: items.length - added });
});

// Остаток по артикулу (для сайта) — группа/размер из каталога, иначе живой запрос
app.get('/api/stock/:article', async (req, res) => {
  try {
    const stock = await getStock(req.params.article);
    if (!stock) return res.status(404).json({ error: 'Не найдено в МойСклад' });
    res.json(stock);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Каталог МойСклад — сгруппирован по артикулу (сумма остатков по размерам),
// только товары с остатком > 0. Обновляется синхронизацией каждые 20 минут.
app.get('/api/moysklad', (req, res) => {
  const rows = [...msModels.values()]
    .map(m => ({ model: m.model, stock: m.stock, byStore: m.byStore, colors: [...m.colors.values()] }))
    .filter(m => m.stock > 0)
    .sort((a, b) => b.stock - a.stock);
  res.json({ updatedAt: msCatalog.updatedAt, stores: msStoreNames, count: rows.length, rows });
});

// Список складов МойСклад — чтобы связать их со складами на сайте
app.get('/api/moysklad/stores', (req, res) => {
  res.json({ stores: msStores });
});

// Диагностика синхронизации (что пошло не так)
app.get('/api/moysklad/debug', (req, res) => {
  res.json({
    configured: msConfigured(),
    updatedAt: msCatalog.updatedAt,
    models: msModels.size,
    storeNames: msStoreNames,
    debug: msDebug
  });
});

// ======================================================================
//  Интеграция с МойСклад (остатки)
// ======================================================================
function msAuthHeader() {
  if (MS_TOKEN) return `Bearer ${MS_TOKEN}`;
  if (MS_LOGIN && MS_PASSWORD) {
    return 'Basic ' + Buffer.from(`${MS_LOGIN}:${MS_PASSWORD}`).toString('base64');
  }
  return null;
}

function msConfigured() {
  return Boolean(msAuthHeader());
}

// Возвращает { name, article, stock, reserve, inTransit, quantity, price } или null
async function fetchStock(article) {
  const auth = msAuthHeader();
  if (!auth) throw new Error('МойСклад не настроен (нет токена или логина/пароля)');

  const field = MS_MATCH_FIELD === 'code' ? 'code' : 'article';
  const url = `${MS_API}/entity/assortment?filter=${field}=${encodeURIComponent(article)}&limit=1`;

  const r = await fetch(url, {
    headers: {
      'Authorization': auth,
      'Accept': 'application/json;charset=utf-8',
      'Content-Type': 'application/json'
    }
  });

  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`МойСклад ответил ${r.status}. ${body.slice(0, 200)}`);
  }

  const data = await r.json();
  const rowItem = data.rows && data.rows[0];
  if (!rowItem) return null;

  const price = Array.isArray(rowItem.salePrices) && rowItem.salePrices[0]
    ? rowItem.salePrices[0].value / 100
    : null;

  return {
    name: rowItem.name || article,
    article: rowItem.article || rowItem.code || article,
    stock: rowItem.stock ?? 0,        // физический остаток
    reserve: rowItem.reserve ?? 0,    // в резерве
    inTransit: rowItem.inTransit ?? 0,// ожидается
    quantity: rowItem.quantity ?? 0,  // доступно
    price
  };
}

// ---- Полная синхронизация каталога МойСклад (каждые 20 минут) ----
let msCatalog = { updatedAt: null, count: 0 };
let msStoreNames = [];    // порядок складов для колонок на сайте
let msModels = new Map(); // МОДЕЛЬ(upper) -> { model, stock, byStore, colors:Map }
let msGroups = new Map(); // базовый артикул 402183L-BBLM (upper) -> цветовая группа

// Склады МойСклад, которые не показывать (по умолчанию «Резерв 2023»)
const MS_SKIP_STORES = (process.env.MOYSKLAD_SKIP_STORES || 'Резерв 2023')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function msPrice(it) {
  return Array.isArray(it.salePrices) && it.salePrices[0]
    ? it.salePrices[0].value / 100 : null;
}

// Базовый артикул: "402183L-BBLM (32, BLUE BLACK LIME)" -> "402183L-BBLM"
function baseArticle(r) {
  const src = r.code || r.name || r.article || '';
  return String(src).split(/\s*\(/)[0].trim();
}

// Модель из артикула: "402183L-BBLM" -> "402183L"
function modelKey(base) {
  return String(base).split('-')[0].trim() || base;
}

// Цвет из названия: "402183L-BBLM (32, BLUE BLACK LIME)" -> "BLUE BLACK LIME"
function colorFromName(r) {
  const m = String(r.name || '').match(/\(([^)]*)\)/);
  if (!m) return '';
  const parts = m[1].split(',');
  return (parts.length > 1 ? parts.slice(1).join(',') : m[1]).trim();
}

// Остаток по артикулу: цветовая группа, затем модель, затем живой запрос
async function getStock(article) {
  const key = String(article).toUpperCase();
  if (msGroups.has(key)) {
    const g = msGroups.get(key);
    return { article: g.article, name: g.color, stock: g.stock, quantity: g.stock,
             reserve: 0, inTransit: 0, price: g.price, byStore: g.byStore };
  }
  if (msModels.has(key)) {
    const m = msModels.get(key);
    return { article: m.model, name: m.model, stock: m.stock, quantity: m.stock,
             reserve: 0, inTransit: 0, price: null, byStore: m.byStore };
  }
  return await fetchStock(article);
}

// Список складов МойСклад (без скрытых, напр. «Резерв 2023»)
let msStores = [];
async function msFetchStores() {
  const auth = msAuthHeader();
  if (!auth) return;
  try {
    const r = await fetch(`${MS_API}/entity/store?limit=100`, {
      headers: { 'Authorization': auth, 'Accept': 'application/json;charset=utf-8' }
    });
    if (!r.ok) { console.error(`⚠️ МойСклад stores ${r.status}`); return; }
    const data = await r.json();
    msStores = (data.rows || [])
      .map(s => ({ id: String(s.meta && s.meta.href || '').split('/').pop(), name: s.name || '' }))
      .filter(s => s.name && !MS_SKIP_STORES.includes(s.name.toLowerCase()));
    console.log(`🏬 МойСклад склады: ${msStores.map(s => s.name).join(', ')}`);
  } catch (e) {
    console.error('ms stores', e.message);
  }
}

let msDebug = { lastRun: null, storesFetched: [], perStore: [], errors: [] };

async function msSyncAll() {
  const auth = msAuthHeader();
  if (!auth) return;
  msDebug = { lastRun: new Date().toISOString(), storesFetched: [], perStore: [], errors: [] };
  await msFetchStores();
  msDebug.storesFetched = msStores.map(s => s.name);
  const headers = { 'Authorization': auth, 'Accept': 'application/json;charset=utf-8' };
  const storeById = new Map(msStores.map(s => [s.id, s.name])); // только видимые склады

  const models = new Map();
  const groups = new Map();

  function addStock(inf, storeName, st) {
    if (st <= 0) return;
    let g = groups.get(inf.baseU);
    if (!g) { g = { article: inf.base, model: inf.model, color: inf.color, stock: 0, byStore: {}, price: inf.price }; groups.set(inf.baseU, g); }
    g.stock += st; g.byStore[storeName] = (g.byStore[storeName] || 0) + st;
    if (g.price == null && inf.price != null) g.price = inf.price;

    const mU = inf.model.toUpperCase();
    let m = models.get(mU);
    if (!m) { m = { model: inf.model, stock: 0, byStore: {}, colors: new Map() }; models.set(mU, m); }
    m.stock += st; m.byStore[storeName] = (m.byStore[storeName] || 0) + st;
    let c = m.colors.get(inf.baseU);
    if (!c) { c = { article: inf.base, color: inf.color, stock: 0, byStore: {}, price: inf.price }; m.colors.set(inf.baseU, c); }
    c.stock += st; c.byStore[storeName] = (c.byStore[storeName] || 0) + st;
    if (c.price == null && inf.price != null) c.price = inf.price;
  }

  // 1) Один проход по каталогу: id -> инфо (артикул/модель/цвет/цена/общий остаток)
  const info = new Map();
  try {
    let offset = 0;
    for (let page = 0; page < 200; page++) {
      const r = await fetch(`${MS_API}/entity/assortment?limit=1000&offset=${offset}`, { headers });
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        msDebug.errors.push(`assortment HTTP ${r.status} ${body.slice(0, 100)}`);
        break;
      }
      const data = await r.json();
      const batch = data.rows || [];
      for (const it of batch) {
        const id = String(it.meta && it.meta.href || '').split('?')[0].split('/').pop();
        const base = baseArticle({ code: it.code, name: it.name, article: it.article });
        if (!id || !base) continue;
        info.set(id, {
          base, baseU: base.toUpperCase(), model: modelKey(base),
          color: colorFromName({ name: it.name }) || base,
          price: msPrice(it), totalStock: Number(it.stock) || 0
        });
      }
      offset += batch.length;
      const size = data.meta && data.meta.size ? data.meta.size : offset;
      if (batch.length < 1000 || offset >= size) break;
    }
  } catch (e) { msDebug.errors.push('assortment ' + e.message); }

  // 2) Лёгкий отчёт остатков по складам
  let bystore = null;
  try {
    const r = await fetch(`${MS_API}/report/stock/bystore/current?stockType=stock`, { headers });
    if (r.ok) bystore = await r.json();
    else { const b = await r.text().catch(()=> ''); msDebug.errors.push(`bystore/current HTTP ${r.status} ${b.slice(0,100)}`); }
  } catch (e) { msDebug.errors.push('bystore/current ' + e.message); }

  if (Array.isArray(bystore) && bystore.length) {
    msDebug.perStore.push({ sample: bystore[0] }); // образец формата для диагностики
    for (const e of bystore) {
      const inf = info.get(e.assortmentId);
      if (!inf) continue;
      if (!storeById.has(e.storeId)) continue; // скрытый склад (напр. Резерв 2023)
      addStock(inf, storeById.get(e.storeId), Number(e.stock) || 0);
    }
    msStoreNames = msStores.map(s => s.name);
  } else {
    // Резерв: если отчёт по складам недоступен — показываем общий остаток
    for (const inf of info.values()) addStock(inf, 'Всего', inf.totalStock);
    msStoreNames = ['Всего'];
  }

  msModels = models;
  msGroups = groups;
  msCatalog = { updatedAt: new Date().toISOString(), count: models.size };
  console.log(`🔄 МойСклад: складов ${msStoreNames.length}, моделей ${models.size}, цветов ${groups.size}`);
}

// ======================================================================
//  Telegram-бот (long polling, без вебхука и без доп. зависимостей)
// ======================================================================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Экранирование для parse_mode=HTML
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function tgCall(method, payload) {
  if (!TG) return null;
  const r = await fetch(`${TG}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return r.json();
}

async function tgSend(chatId, text, extra = {}) {
  return tgCall('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra
  });
}

// Отправка файла (экспорт)
async function tgSendDocument(chatId, filename, content, caption) {
  if (!TG) return null;
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption);
  form.append('document', new Blob([content], { type: 'text/csv' }), filename);
  const r = await fetch(`${TG}/sendDocument`, { method: 'POST', body: form });
  return r.json();
}

// Уведомление владельцу
function notify(text) {
  if (!TG || !NOTIFY_CHAT_ID) return;
  tgSend(NOTIFY_CHAT_ID, text).catch(e => console.error('notify error', e.message));
}

function isAllowed(chatId) {
  if (TG_ADMINS.length === 0) return true; // если список пуст — доступ всем
  return TG_ADMINS.includes(String(chatId));
}

function itemLine(it) {
  const place = [
    it.warehouse ? `склад ${it.warehouse}` : null,
    it.floor ? `этаж ${it.floor}` : null,
    it.row ? `ряд ${it.row}` : null,
    it.cell ? `ячейка ${it.cell}` : null
  ].filter(Boolean).join(', ') || 'место не указано';
  return `📦 <b>${esc(it.article)}</b> — ${esc(it.name)}\n    ${esc(place)}`;
}

const HELP = [
  '<b>Команды склада Skechers</b>',
  '',
  '/list — все товары',
  '/find АРТИКУЛ — найти товар и его место',
  '/add АРТИКУЛ Название — добавить товар',
  '/del АРТИКУЛ — удалить товар',
  '/count — количество товаров',
  '/export — выгрузить весь список файлом',
  '/ostatki АРТИКУЛ — остаток в МойСклад'
].join('\n');

async function handleCommand(chatId, text) {
  const [rawCmd, ...rest] = text.trim().split(/\s+/);
  const cmd = rawCmd.split('@')[0].toLowerCase(); // убрать @botname
  const article = (rest[0] || '').toUpperCase();

  switch (cmd) {
    case '/start':
    case '/help':
      return tgSend(chatId, HELP);

    case '/count': {
      const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM items');
      return tgSend(chatId, `Всего товаров: <b>${rows[0].n}</b>`);
    }

    case '/list': {
      const { rows: items } = await pool.query('SELECT * FROM items ORDER BY created_at LIMIT 50');
      if (!items.length) return tgSend(chatId, 'Список пуст.');
      const { rows: c } = await pool.query('SELECT COUNT(*)::int AS n FROM items');
      const total = c[0].n;
      let msg = items.map(itemLine).join('\n\n');
      if (total > items.length) msg += `\n\n…и ещё ${total - items.length}. Используй /export для полного списка.`;
      return tgSend(chatId, msg);
    }

    case '/find': {
      if (!article) return tgSend(chatId, 'Укажи артикул: /find SK-12345');
      const { rows } = await pool.query('SELECT * FROM items WHERE article = $1', [article]);
      if (!rows.length) return tgSend(chatId, `Товар <b>${esc(article)}</b> не найден.`);
      return tgSend(chatId, itemLine(rows[0]));
    }

    case '/add': {
      if (!article) return tgSend(chatId, 'Формат: /add АРТИКУЛ Название');
      const name = rest.slice(1).join(' ') || article;
      const r = await pool.query(
        `INSERT INTO items (article, name) VALUES ($1, $2)
         ON CONFLICT (article) DO NOTHING`,
        [article, name]
      );
      return tgSend(chatId, r.rowCount
        ? `✅ Добавлен <b>${esc(article)}</b> — ${esc(name)}`
        : `Товар <b>${esc(article)}</b> уже существует.`);
    }

    case '/del': {
      if (!article) return tgSend(chatId, 'Укажи артикул: /del SK-12345');
      const r = await pool.query('DELETE FROM items WHERE article = $1', [article]);
      return tgSend(chatId, r.rowCount
        ? `🗑 Удалён <b>${esc(article)}</b>`
        : `Товар <b>${esc(article)}</b> не найден.`);
    }

    case '/export': {
      const { rows: items } = await pool.query('SELECT * FROM items ORDER BY created_at');
      if (!items.length) return tgSend(chatId, 'Список пуст — экспортировать нечего.');
      const header = 'Артикул;Название;Склад;Этаж;Ряд;Ячейка;Дата\n';
      const body = items.map(it => [
        it.article, it.name, it.warehouse, it.floor, it.row, it.cell, it.created_at
      ].map(v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(';')).join('\n');
      const csv = '﻿' + header + body; // BOM для корректной кириллицы в Excel
      return tgSendDocument(chatId, 'sklad.csv', csv, `Товаров: ${items.length}`);
    }

    case '/ostatki': {
      if (!msConfigured()) return tgSend(chatId, 'Интеграция с МойСклад не настроена. Задай MOYSKLAD_TOKEN (или MOYSKLAD_LOGIN и MOYSKLAD_PASSWORD) в Railway.');
      if (!article) return tgSend(chatId, 'Укажи артикул: /ostatki SK-12345');
      await tgSend(chatId, '⏳ Запрашиваю остаток…');
      try {
        const s = await getStock(article);
        if (!s) return tgSend(chatId, `В МойСклад ничего не найдено по <b>${esc(article)}</b>.`);
        const lines = [
          `📊 <b>${esc(s.name)}</b> (${esc(s.article)})`,
          `Остаток: <b>${s.stock}</b>`,
          `Доступно: <b>${s.quantity}</b>`,
          `В резерве: ${s.reserve}`,
          `Ожидается: ${s.inTransit}`
        ];
        if (s.price != null) lines.push(`Цена: ${s.price}`);
        return tgSend(chatId, lines.join('\n'));
      } catch (e) {
        return tgSend(chatId, `⚠️ Ошибка МойСклад: ${esc(e.message)}`);
      }
    }

    default:
      return tgSend(chatId, 'Неизвестная команда. /help — список команд.');
  }
}

async function handleUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;

  if (!isAllowed(chatId)) {
    await tgSend(chatId, `⛔ Нет доступа. Ваш chat_id: <code>${chatId}</code>`);
    return;
  }
  if (msg.text.startsWith('/')) {
    await handleCommand(chatId, msg.text);
  } else {
    await tgSend(chatId, 'Отправь команду. /help — список.');
  }
}

async function startBot() {
  // Убираем возможный вебхук, чтобы работал polling
  await tgCall('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
  const me = await tgCall('getMe').catch(() => null);
  if (me && me.ok) console.log(`🤖 Telegram-бот запущен: @${me.result.username}`);
  else { console.error('❌ Не удалось запустить бота — проверь TELEGRAM_BOT_TOKEN'); return; }

  let offset = 0;
  while (true) {
    try {
      const r = await fetch(`${TG}/getUpdates?timeout=30&offset=${offset}`);
      const data = await r.json();
      if (data.ok) {
        for (const upd of data.result) {
          offset = upd.update_id + 1;
          handleUpdate(upd).catch(e => console.error('handleUpdate', e.message));
        }
      }
    } catch (e) {
      console.error('poll error', e.message);
      await sleep(3000);
    }
  }
}

// ======================================================================
//  Старт
// ======================================================================
initDB().then(() => {
  app.listen(PORT, () => console.log(`✅ Сервер запущен на порту ${PORT}`));
  if (TG) startBot();
  else console.log('ℹ️ Telegram-бот выключен (нет TELEGRAM_BOT_TOKEN)');

  // Синхронизация каталога МойСклад: сразу при старте и далее каждые 20 минут
  if (msConfigured()) {
    msSyncAll().catch(e => console.error('ms sync', e.message));
    setInterval(() => msSyncAll().catch(e => console.error('ms sync', e.message)), 20 * 60 * 1000);
  } else {
    console.log('ℹ️ Синхронизация МойСклад выключена (нет доступа)');
  }
}).catch(err => {
  console.error('❌ Ошибка запуска:', err.message);
  process.exit(1);
});
