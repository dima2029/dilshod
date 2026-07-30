const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const {
  modelKey, colorFromName, sizeFromName, msPrice,
  parseStoreRenameMap, makeStoreDisplay,
  serializeMsSnapshot, deserializeMsSnapshot, isMsCacheStale
} = require('./lib/moysklad-parse');
const { OVIR_FLOOR_BY_LETTER, parseBulkPlaceBlocks, splitCompoundArticle, looksLikeBulkPlace } = require('./lib/warehouse-place');

// Не даём процессу упасть из-за необработанной ошибки (иначе Railway перезапускает
// сервер, каталог МойСклад теряется и данные «пропадают» с экрана).
process.on('unhandledRejection', (e) => console.error('⚠️ unhandledRejection:', e && e.message ? e.message : e));
process.on('uncaughtException',  (e) => console.error('⚠️ uncaughtException:', e && e.message ? e.message : e));

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

// Публичный адрес сайта — для кнопки «Войти в сайт» в Telegram.
// Railway сам подставляет RAILWAY_PUBLIC_DOMAIN, если у сервиса есть публичный домен.
const SITE_URL = process.env.SITE_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);

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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_users (
      chat_id    TEXT PRIMARY KEY,
      store      TEXT,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  // Учёт использования бота: сколько запросов и от кого — добавляем колонки
  // на существующую таблицу (ALTER ... IF NOT EXISTS безопасен при повторном запуске).
  await pool.query(`
    ALTER TABLE bot_users
      ADD COLUMN IF NOT EXISTS request_count BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS first_seen TIMESTAMPTZ DEFAULT now(),
      ADD COLUMN IF NOT EXISTS username TEXT,
      ADD COLUMN IF NOT EXISTS first_name TEXT;
  `);
  // Кэш последнего успешного снимка каталога МойСклад — переживает перезапуск
  // сервера при деплое (см. saveMsCache/loadMsCacheFromDB).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ms_cache (
      id         INTEGER PRIMARY KEY DEFAULT 1,
      payload    JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  console.log('✅ Postgres подключён, таблицы готовы');
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
  // Отдаём заранее собранный каталог (см. rebuild) — без тяжёлой сборки на каждый запрос
  res.json({ updatedAt: msPublic.updatedAt, sync: msSyncState, stores: msPublic.stores, count: msPublic.count, rows: msPublic.rows });
});

// Список складов МойСклад — чтобы связать их со складами на сайте
app.get('/api/moysklad/stores', (req, res) => {
  res.json({ stores: msStores });
});

// Сырой ответ МойСклад по артикулу — чтобы увидеть реальную структуру и остаток
app.get('/api/moysklad/raw', async (req, res) => {
  const art = String(req.query.article || '').trim();
  const auth = msAuthHeader();
  if (!auth) return res.json({ error: 'МойСклад не настроен' });
  if (!art) return res.json({ error: 'нет ?article=' });
  const headers = { 'Authorization': auth, 'Accept': 'application/json;charset=utf-8' };
  const out = {};
  try {
    const r = await fetch(`${MS_API}/entity/assortment?filter=article=${encodeURIComponent(art)}&limit=100`, { headers });
    const data = await r.json();
    out.assortment = {
      status: r.status, size: data.meta && data.meta.size,
      rows: (data.rows || []).map(it => ({
        type: it.meta && it.meta.type, name: it.name, code: it.code, article: it.article,
        stock: it.stock, reserve: it.reserve, inTransit: it.inTransit, quantity: it.quantity,
        variantsCount: it.variantsCount, id: String(it.meta && it.meta.href || '').split('?')[0].split('/').pop()
      }))
    };
  } catch (e) { out.assortmentError = e.message; }
  res.json(out);
});

// Группировка списка товаров в модель -> цвета -> размеры (с остатком по складам)
function groupInfos(infos) {
  const models = new Map();
  for (const inf of infos) {
    const mU = inf.model.toUpperCase();
    let m = models.get(mU);
    if (!m) { m = { model: inf.model, stock: 0, byStore: {}, colors: new Map() }; models.set(mU, m); }
    let c = m.colors.get(inf.baseU);
    if (!c) { c = { article: inf.base, color: inf.color, stock: 0, byStore: {}, price: inf.price, sizes: new Map() }; m.colors.set(inf.baseU, c); }
    const sz = inf.size || '—';
    let s = c.sizes.get(sz);
    if (!s) { s = { size: sz, article: inf.variantArticle || '', stock: 0, byStore: {} }; c.sizes.set(sz, s); }
    const total = Number(inf.totalStock) || 0;
    m.stock += total; c.stock += total; s.stock += total;
    for (const [store, q] of Object.entries(inf.byStore || {})) {
      m.byStore[store] = (m.byStore[store] || 0) + q;
      c.byStore[store] = (c.byStore[store] || 0) + q;
      s.byStore[store] = (s.byStore[store] || 0) + q;
    }
  }
  return [...models.values()].map(m => ({
    model: m.model, stock: m.stock, byStore: m.byStore,
    colors: [...m.colors.values()].map(c => ({
      article: c.article, color: c.color, stock: c.stock, byStore: c.byStore, price: c.price,
      sizes: [...c.sizes.values()].filter(s => (s.stock || 0) > 0).sort((a, b) => (parseFloat(a.size) || 999) - (parseFloat(b.size) || 999))
    }))
  }));
}

// Поиск по ВСЕМУ каталогу (в т.ч. нулевые остатки) — по артикулу/коду/модели/цвету
app.get('/api/moysklad/find', (req, res) => {
  const q = String(req.query.q || '').trim().toUpperCase();
  if (!q) return res.json({ stores: msStoreNames, rows: [] });
  const matched = [];
  for (const inf of msInfoAll.values()) {
    if ((inf.variantArticle || '').toUpperCase().includes(q) ||
        inf.baseU.includes(q) ||
        (inf.model || '').toUpperCase().includes(q) ||
        (inf.color || '').toUpperCase().includes(q)) {
      matched.push(inf);
      if (matched.length >= 800) break;
    }
  }
  res.json({ stores: msStoreNames.length ? msStoreNames : ['Всего'], rows: groupInfos(matched) });
});

// Диагностика синхронизации (что пошло не так)
app.get('/api/moysklad/debug', (req, res) => {
  const art = String(req.query.article || '').trim().toUpperCase();
  if (art) {
    const hits = [];
    for (const [id, inf] of msInfoAll) {
      if ((inf.variantArticle || '').toUpperCase().includes(art) ||
          inf.baseU.includes(art) || (inf.model || '').toUpperCase().includes(art)) {
        hits.push({ id, base: inf.base, size: inf.size, variantArticle: inf.variantArticle, byStore: inf.byStore });
        if (hits.length >= 40) break;
      }
    }
    return res.json({ article: art, foundInInfo: hits.length, hits });
  }
  res.json({
    configured: msConfigured(),
    updatedAt: msCatalog.updatedAt,
    sync: msSyncState,
    models: msModels.size,
    infoAll: msInfoAll ? msInfoAll.size : 0,
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

// fetch с таймаутом — иначе зависший запрос к МойСклад навсегда останавливает синхронизацию
async function msFetch(url, opts = {}, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Состояние синхронизации каталога (видно на сайте, чтобы не гадать)
let msSyncState = { status: 'idle', startedAt: null, finishedAt: null, lastError: null };

// Возвращает { name, article, stock, reserve, inTransit, quantity, price } или null
async function fetchStock(article) {
  const auth = msAuthHeader();
  if (!auth) throw new Error('МойСклад не настроен (нет токена или логина/пароля)');

  const field = MS_MATCH_FIELD === 'code' ? 'code' : 'article';
  const url = `${MS_API}/entity/assortment?filter=${field}=${encodeURIComponent(article)}&limit=1`;

  const r = await msFetch(url, {
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
// Готовый ответ для /api/moysklad — собирается ОДИН раз при синхронизации,
// а не на каждый запрос (иначе тяжёлая сборка на каждый опрос раз в 60с грузит память).
let msPublic = { updatedAt: null, stores: [], count: 0, rows: [] };
let msStoreNames = [];    // порядок складов для колонок на сайте
let msModels = new Map(); // МОДЕЛЬ(upper) -> { model, stock, byStore, colors:Map }
let msGroups = new Map(); // базовый артикул 402183L-BBLM (upper) -> цветовая группа
let msInfoAll = new Map();// assortmentId -> инфо ВСЕХ товаров (в т.ч. с нулём) для поиска

// Каталог МойСклад живёт только в памяти процесса — при каждом деплое Railway
// перезапускает сервер, и без кэша сайт/бот несколько минут показывают пусто,
// пока идёт полная пересинхронизация. Сохраняем последний успешный снимок в
// Postgres и подхватываем его при старте, чтобы не ждать вхолостую.
async function saveMsCache() {
  try {
    const snap = serializeMsSnapshot({
      storeNames: msStoreNames, publicData: msPublic,
      models: msModels, groups: msGroups, info: msInfoAll
    });
    await pool.query(
      `INSERT INTO ms_cache (id, payload, updated_at) VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET payload = $1, updated_at = now()`,
      [JSON.stringify(snap)]
    );
  } catch (e) { console.error('⚠️ saveMsCache:', e.message); }
}

async function loadMsCacheFromDB() {
  try {
    const { rows } = await pool.query('SELECT payload, updated_at FROM ms_cache WHERE id = 1');
    if (!rows.length) return false;
    const restored = deserializeMsSnapshot(rows[0].payload);
    msStoreNames = restored.storeNames;
    msPublic = restored.publicData || msPublic;
    msModels = restored.models;
    msGroups = restored.groups;
    msInfoAll = restored.info;
    msCatalog = { updatedAt: rows[0].updated_at, count: msModels.size };
    console.log(`♻️  МойСклад: восстановлен кэш из Postgres (${msModels.size} моделей, обновлён ${rows[0].updated_at})`);
    return true;
  } catch (e) { console.error('⚠️ loadMsCacheFromDB:', e.message); return false; }
}

// Склады МойСклад, которые не показывать (по умолчанию показываем все)
const MS_SKIP_STORES = (process.env.MOYSKLAD_SKIP_STORES || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// Переименование складов МойСклад (если названия отличаются от сайта).
// Сейчас в МойСклад склады уже названы как на сайте — карта пустая.
const MS_STORE_RENAME = parseStoreRenameMap(process.env.MOYSKLAD_STORE_MAP);
const storeDisplay = makeStoreDisplay(MS_STORE_RENAME);

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
    const r = await msFetch(`${MS_API}/entity/store?limit=100`, {
      headers: { 'Authorization': auth, 'Accept': 'application/json;charset=utf-8' }
    });
    if (!r.ok) { console.error(`⚠️ МойСклад stores ${r.status}`); return; }
    const data = await r.json();
    msStores = (data.rows || [])
      .map(s => ({ id: String(s.meta && s.meta.href || '').split('/').pop(), name: s.name || '', display: storeDisplay(s.name || '') }))
      .filter(s => s.name && !MS_SKIP_STORES.includes(s.name.toLowerCase()));
    console.log(`🏬 МойСклад склады: ${msStores.map(s => s.name).join(', ')}`);
  } catch (e) {
    console.error('ms stores', e.message);
  }
}

let msDebug = { lastRun: null, storesFetched: [], perStore: [], errors: [] };

async function msSyncAll() {
  const auth = msAuthHeader();
  if (!auth) { msSyncState = { status: 'error', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), lastError: 'МойСклад не настроен: нет MOYSKLAD_TOKEN или MOYSKLAD_LOGIN/MOYSKLAD_PASSWORD в Railway' }; return; }
  if (msSyncState.status === 'running') { console.log('⏳ МойСклад: синхронизация уже идёт, пропускаю запуск'); return; }
  msSyncState = { status: 'running', startedAt: new Date().toISOString(), finishedAt: null, lastError: null };
  try {
    await msSyncAllInner(auth);
    msSyncState.status = 'done';
  } catch (e) {
    msSyncState.status = 'error';
    msSyncState.lastError = e.message;
    console.error('❌ МойСклад синхронизация:', e.message);
  } finally {
    msSyncState.finishedAt = new Date().toISOString();
  }
}

async function msSyncAllInner(auth) {
  msDebug = { lastRun: new Date().toISOString(), storesFetched: [], perStore: [], errors: [] };
  await msFetchStores();
  msDebug.storesFetched = msStores.map(s => s.name);
  const headers = { 'Authorization': auth, 'Accept': 'application/json;charset=utf-8' };
  const stores = msStores.length ? msStores : [{ id: null, name: 'Всего' }];

  const info = new Map(); // id -> инфо

  // Построить модели -> цвета -> размеры из info и опубликовать в глобальные переменные.
  // Вызывается дважды: после ассортимента (видны итоги) и после раскладки по складам (видны колонки).
  function rebuild() {
    const models = new Map();
    const groups = new Map();
    const mergeStore = (dst, src) => { for (const k in src) dst[k] = (dst[k] || 0) + src[k]; };
    const addItem = (inf) => {
      const total = Number(inf.totalStock) || 0;
      let g = groups.get(inf.baseU);
      if (!g) { g = { article: inf.base, model: inf.model, color: inf.color, stock: 0, byStore: {}, price: inf.price }; groups.set(inf.baseU, g); }
      g.stock += total; mergeStore(g.byStore, inf.byStore);
      if (g.price == null && inf.price != null) g.price = inf.price;

      const mU = inf.model.toUpperCase();
      let m = models.get(mU);
      if (!m) { m = { model: inf.model, stock: 0, byStore: {}, colors: new Map() }; models.set(mU, m); }
      m.stock += total; mergeStore(m.byStore, inf.byStore);
      let c = m.colors.get(inf.baseU);
      if (!c) { c = { article: inf.base, color: inf.color, stock: 0, byStore: {}, price: inf.price, sizes: new Map() }; m.colors.set(inf.baseU, c); }
      c.stock += total; mergeStore(c.byStore, inf.byStore);
      if (c.price == null && inf.price != null) c.price = inf.price;

      const sz = inf.size || '—';
      let s = c.sizes.get(sz);
      if (!s) { s = { size: sz, article: inf.variantArticle || '', stock: 0, byStore: {} }; c.sizes.set(sz, s); }
      s.stock += total; mergeStore(s.byStore, inf.byStore);
    };
    for (const inf of info.values()) {
      if ((Number(inf.totalStock) || 0) > 0) addItem(inf);
    }
    // Не затираем ранее собранный каталог пустышкой (например, если очередной
    // проход к МойСклад вернул ошибку/пусто) — оставляем прошлые данные на экране.
    if (models.size === 0 && msModels.size > 0) {
      console.warn('⚠️ МойСклад: новый проход пуст — сохраняю прошлые данные');
      return;
    }
    msStoreNames = stores.map(s => s.display || s.name);
    msInfoAll = info; // полный каталог для поиска по любому артикулу
    msModels = models;
    msGroups = groups;
    const updatedAt = new Date().toISOString();
    msCatalog = { updatedAt, count: models.size };
    // Собираем готовый ответ для сайта один раз
    const rows = [...models.values()]
      .map(m => ({
        model: m.model, stock: m.stock, byStore: m.byStore,
        colors: [...m.colors.values()].map(c => ({
          article: c.article, color: c.color, stock: c.stock, byStore: c.byStore, price: c.price,
          sizes: [...c.sizes.values()].filter(s => (s.stock || 0) > 0).sort((a, b) => (parseFloat(a.size) || 999) - (parseFloat(b.size) || 999))
        }))
      }))
      .filter(m => m.stock > 0)
      .sort((a, b) => b.stock - a.stock);
    msPublic = { updatedAt, stores: msStoreNames, count: rows.length, rows };
    saveMsCache(); // фоново, не блокирует — переживёт следующий рестарт сервера
  }

  // 1) Полный ассортимент (товары + модификации). Остаток лежит на МОДИФИКАЦИЯХ
  //    (у товара с модификациями stock = 0). База модификации берётся из НАЗВАНИЯ,
  //    т.к. code у модификации = штрихкод.
  try {
    let offset = 0;
    for (let page = 0; page < 400; page++) {
      const r = await msFetch(`${MS_API}/entity/assortment?limit=1000&offset=${offset}`, { headers });
      if (!r.ok) { const b = await r.text().catch(() => ''); msDebug.errors.push(`assortment HTTP ${r.status} ${b.slice(0, 120)}`); break; }
      const data = await r.json();
      const batch = data.rows || [];
      if (!batch.length) break;
      for (const it of batch) {
        const id = String(it.meta && it.meta.href || '').split('?')[0].split('/').pop();
        const isVariant = it.meta && it.meta.type === 'variant';
        const src = isVariant ? (it.name || it.code) : (it.code || it.name);
        const base = String(src || it.article || '').split(/\s*\(/)[0].trim();
        if (!id || !base) continue;
        info.set(id, {
          base, baseU: base.toUpperCase(), model: modelKey(base),
          color: colorFromName({ name: it.name }) || base,
          size: sizeFromName({ name: it.name }),
          variantArticle: it.article || it.code || '',
          price: msPrice(it), totalStock: Number(it.stock) || 0, byStore: {}
        });
      }
      offset += batch.length;
    }
    msDebug.infoCount = info.size;
  } catch (e) { msDebug.errors.push('assortment ' + e.message); }

  // Итоги видны сразу (вкладка «Остатки» с общими остатками), не дожидаясь раскладки по складам
  rebuild();
  console.log(`🔄 МойСклад: ассортимент ${info.size}, моделей ${msModels.size} — итоги опубликованы, идёт раскладка по складам…`);

  // 2) /report/stock/bystore — раскладка по складам (join по id модификации).
  //    stockMode=positiveOnly резко уменьшает выборку (только позиции с остатком > 0) —
  //    без него отчёт по всему ассортименту очень тяжёлый и долгий.
  async function runByStore(mode) {
    let matched = 0, offset = 0, firstErr = null;
    const maxPages = Math.ceil(info.size / 1000) + 5; // страховка от «бесконечной» пагинации
    const q = mode ? `&stockMode=${mode}` : '';
    for (let p = 0; p < maxPages; p++) {
      const r = await msFetch(`${MS_API}/report/stock/bystore?limit=1000&offset=${offset}${q}`, { headers });
      if (!r.ok) {
        const b = await r.text().catch(() => '');
        if (p === 0) { firstErr = `bystore HTTP ${r.status} ${b.slice(0, 120)}`; }
        else { msDebug.errors.push(`bystore HTTP ${r.status} ${b.slice(0, 120)}`); }
        break;
      }
      const data = await r.json();
      const rows = data.rows || [];
      if (!rows.length) break;
      for (const row of rows) {
        const id = String(row.meta && row.meta.href || '').split('?')[0].split('/').pop();
        const inf = info.get(id);
        if (!inf) continue;
        matched++;
        for (const sb of (row.stockByStore || [])) {
          const sName = sb.name || '';
          if (!sName || MS_SKIP_STORES.includes(sName.toLowerCase())) continue;
          const st = Number(sb.stock) || 0;
          if (st > 0) { const disp = storeDisplay(sName); inf.byStore[disp] = (inf.byStore[disp] || 0) + st; }
        }
      }
      offset += rows.length;
    }
    return { matched, firstErr };
  }

  let matched = 0;
  try {
    // Быстрый проход только по позициям с остатком; если параметр не сработал
    // (ошибка ИЛИ пустой ответ) — надёжный полный проход по всему ассортименту.
    let res = await runByStore('positiveOnly');
    if (res.firstErr || res.matched === 0) {
      if (res.firstErr) msDebug.errors.push('positiveOnly: ' + res.firstErr);
      else msDebug.errors.push('positiveOnly вернул пусто — полный проход');
      res = await runByStore('');
      if (res.firstErr) msDebug.errors.push(res.firstErr);
    }
    matched = res.matched;
    msDebug.bystoreMatched = matched;
  } catch (e) { msDebug.errors.push('bystore ' + e.message); }

  // 3) финальная пересборка — теперь с раскладкой по складам (byStore)
  rebuild();
  console.log(`🔄 МойСклад готов: складов ${msStoreNames.length}, моделей ${msModels.size}, раскладка по ${matched} позициям`);
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

const WH_NAMES = { '1': 'Фаровон', '2': 'Овир', '3': 'Ашан', '4': 'Валаматзода' };

// Массовая расстановка по ячейкам склада Овир (только администратор).
async function handleBulkPlace(chatId, text) {
  const { blocks, ignored } = parseBulkPlaceBlocks(text);
  if (!blocks.length) {
    return tgSend(chatId,
      'Не понял формат. Пример:\n<code>Ряд 8 Б\n310197-CRL\n310561-BKLD</code>\nСлово «Ряд» можно не писать — просто «8 Б» тоже подойдёт, если это первая строка целиком.');
  }

  let placed = 0, created = 0, moved = 0, split = 0;
  const skipped = [];
  for (const b of blocks) {
    const floor = OVIR_FLOOR_BY_LETTER[b.letter];
    if (!floor) { skipped.push(`Ряд ${esc(b.row)} ${esc(b.letter)} — неизвестная буква для Овира`); continue; }
    for (const rawArticle of b.articles) {
      if (!rawArticle) continue;
      // «405638-BLBK-LGW», «403988-BLU-BLK» и т.п. — это НЕСКОЛЬКО цветов одной модели,
      // слитых через дефис; разбиваем всегда, без сверки с каталогом МойСклад (там эти
      // цвета часто не значатся отдельными SKU, хотя на полке это разные товары).
      const parts = splitCompoundArticle(rawArticle);
      if (parts.length > 1) split++;
      for (const article of parts) {
        const { rows } = await pool.query('SELECT warehouse FROM items WHERE article = $1', [article]);
        let name = article;
        const g = msGroups.get(article);
        if (g) name = `${g.model} ${g.color}`.trim();

        if (rows.length) {
          if (rows[0].warehouse !== '2') moved++;
          await pool.query(
            `UPDATE items SET warehouse = '2', floor = $2, "row" = $3, cell = $4 WHERE article = $1`,
            [article, floor, b.row, b.letter]
          );
        } else {
          await pool.query(
            `INSERT INTO items (article, name, warehouse, floor, "row", cell) VALUES ($1, $2, '2', $3, $4, $5)`,
            [article, name, floor, b.row, b.letter]
          );
          created++;
        }
        placed++;
      }
    }
  }

  const lines = [`✅ Расставлено в Овире: <b>${placed}</b> (новых: ${created}, перемещено с других складов: ${moved})`];
  if (split) lines.push(`✂️ Составных артикулов разбито на отдельные товары: ${split}`);
  if (ignored) lines.push(`ℹ️ Пропущено строк, не похожих на артикул (комментарии и т.п.): ${ignored}`);
  if (skipped.length) lines.push('', '⚠️ Пропущено:', ...skipped);
  return tgSend(chatId, lines.join('\n'));
}

function itemLine(it) {
  const place = [
    it.warehouse ? `склад ${WH_NAMES[it.warehouse] || it.warehouse}` : null,
    it.floor ? `этаж ${it.floor}` : null,
    it.row ? `ряд ${it.row}` : null,
    it.cell ? `ячейка ${it.cell}` : null
  ].filter(Boolean).join(', ') || 'место не указано';
  return `📦 <b>${esc(it.article)}</b> — ${esc(it.name)}\n    ${esc(place)}`;
}

// ---------- Состояние и клавиатуры бота ----------
const botMode = new Map();       // chatId -> 'ms' | 'local'
const botStoreCache = new Map(); // chatId -> магазин
const ALL_STORES = 'Все склады';

async function getUserStore(chatId) {
  if (botStoreCache.has(chatId)) return botStoreCache.get(chatId);
  const { rows } = await pool.query('SELECT store FROM bot_users WHERE chat_id = $1', [String(chatId)]);
  const store = rows.length ? rows[0].store : null;
  botStoreCache.set(chatId, store);
  return store;
}
async function setUserStore(chatId, store) {
  await pool.query(
    `INSERT INTO bot_users (chat_id, store, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (chat_id) DO UPDATE SET store = $2, updated_at = now()`,
    [String(chatId), store]
  );
  botStoreCache.set(chatId, store);
}

// Учёт активности: +1 запрос на каждое сообщение/нажатие кнопки от пользователя.
// Не трогает поле store — им управляет только setUserStore.
async function trackBotActivity(chatId, from) {
  const username = (from && from.username) || null;
  const firstName = (from && from.first_name) || null;
  try {
    await pool.query(
      `INSERT INTO bot_users (chat_id, request_count, first_seen, updated_at, username, first_name)
       VALUES ($1, 1, now(), now(), $2, $3)
       ON CONFLICT (chat_id) DO UPDATE SET
         request_count = bot_users.request_count + 1,
         updated_at = now(),
         username = COALESCE($2, bot_users.username),
         first_name = COALESCE($3, bot_users.first_name)`,
      [String(chatId), username, firstName]
    );
  } catch (e) { console.error('trackBotActivity', e.message); }
}

function storeList() {
  const names = msStoreNames.length ? msStoreNames.filter(n => n !== 'Всего') : [];
  return [...names, ALL_STORES];
}
function storeKeyboard() {
  const rows = storeList().map((n, i) => [{ text: '🏬 ' + n, callback_data: 'store:' + i }]);
  if (SITE_URL) rows.push([{ text: '🌐 Войти в сайт', url: SITE_URL }]);
  return { inline_keyboard: rows };
}
function storeByIndex(i) {
  const list = storeList();
  return list[i] != null ? list[i] : ALL_STORES;
}
function mainMenu() {
  const rows = [
    [{ text: '🔎 Найти остаток (МойСклад)', callback_data: 'menu:ms' }],
    [{ text: '📦 Найти на складе (где лежит)', callback_data: 'menu:local' }],
    [{ text: '🏬 Сменить магазин', callback_data: 'menu:store' }]
  ];
  if (SITE_URL) rows.push([{ text: '🌐 Войти в сайт', url: SITE_URL }]);
  return { inline_keyboard: rows };
}

// Поиск по ВСЕМУ каталогу МойСклад (артикул/код размера/модель/цвет)
function searchMsColors(query) {
  const q = query.trim().toUpperCase();
  if (!q) return [];
  const matched = [];
  for (const inf of msInfoAll.values()) {
    if ((inf.variantArticle || '').toUpperCase().includes(q) ||
        inf.baseU.includes(q) ||
        (inf.model || '').toUpperCase().includes(q) ||
        (inf.color || '').toUpperCase().includes(q)) {
      matched.push(inf);
      if (matched.length >= 800) break;
    }
  }
  const res = [];
  for (const m of groupInfos(matched)) for (const c of m.colors) res.push({ model: m.model, c });
  return res;
}

// Ответ по остаткам МойСклад — только по магазину сотрудника
function formatMsResult(query, store) {
  const found = searchMsColors(query);
  const all = !store || store === ALL_STORES;
  const blocks = [];
  for (const { c } of found) {
    const total = all ? c.stock : (c.byStore[store] || 0);
    const sizes = (c.sizes || [])
      .map(s => ({ size: s.size, n: all ? s.stock : (s.byStore[store] || 0) }))
      .filter(s => s.n > 0)
      .sort((a, b) => (parseFloat(a.size) || 999) - (parseFloat(b.size) || 999));
    const sizeStr = sizes.map(s => `${esc(s.size)}=${s.n}`).join('  ') || '—';
    const line = total > 0 ? `Остаток: <b>${total}</b> шт\nразмеры: ${sizeStr}` : 'Остаток: <b>0</b> (нет в твоём магазине)';
    blocks.push(`📦 <b>${esc(c.article)}</b> — ${esc(c.color)}\n${line}`);
    if (blocks.length >= 15) break;
  }
  if (!blocks.length) {
    return all
      ? `По «${esc(query)}» ничего не найдено.`
      : `По «${esc(query)}» в магазине «${esc(store)}» товара нет.`;
  }
  const head = all ? '🔎 Остатки:' : `🔎 Остатки — <b>${esc(store)}</b>:`;
  return head + '\n\n' + blocks.join('\n\n');
}

// Ответ по своей базе — где лежит на складе
async function formatLocalResult(query) {
  const { rows } = await pool.query(
    `SELECT * FROM items WHERE article ILIKE $1 OR name ILIKE $1 ORDER BY article LIMIT 20`,
    ['%' + query + '%']
  );
  if (!rows.length) return `В своей базе по «${esc(query)}» ничего не найдено.`;
  return '📦 На складе:\n\n' + rows.map(itemLine).join('\n\n');
}

async function handleCallback(cq) {
  const chatId = cq.message ? cq.message.chat.id : (cq.from && cq.from.id);
  const data = cq.data || '';
  await tgCall('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
  if (data.startsWith('store:')) {
    const name = storeByIndex(parseInt(data.slice(6), 10));
    await setUserStore(chatId, name);
    botMode.set(chatId, 'ms');
    return tgSend(chatId, `✅ Твой магазин: <b>${esc(name)}</b>\n\nТеперь просто набирай артикул — покажу остаток по твоему магазину.`, { reply_markup: mainMenu() });
  }
  if (data === 'menu:ms') {
    botMode.set(chatId, 'ms');
    return tgSend(chatId, '🔎 Набирай артикул или модель (можно несколько подряд) — покажу остаток и размеры по твоему магазину.');
  }
  if (data === 'menu:local') {
    botMode.set(chatId, 'local');
    return tgSend(chatId, '📦 Набирай артикул — покажу, на каком складе он лежит (ряд/ячейка).');
  }
  if (data === 'menu:store') {
    return tgSend(chatId, 'Выбери свой магазин:', { reply_markup: storeKeyboard() });
  }
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
  '/ostatki АРТИКУЛ — остаток в МойСклад',
  '/stats — статистика по пользователям бота',
  '/fixcompound — найти и разбить в Овире все слитые через дефис артикулы (405638-BLBK-LGW → 2 товара)',
  '',
  'Массовая расстановка по складу Овир — пришли сообщение вида:',
  '<code>Ряд 8 Б\n310197-CRL\n310561-BKLD</code>',
  '(этаж определится по букве автоматически, слово «Ряд» можно не писать)'
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

    case '/stats': {
      const { rows: totalRows } = await pool.query(
        'SELECT COUNT(*)::int AS users, COALESCE(SUM(request_count),0)::bigint AS requests FROM bot_users'
      );
      const { rows: byStore } = await pool.query(
        `SELECT COALESCE(store, '— не выбрал магазин') AS store,
                COUNT(*)::int AS users,
                COALESCE(SUM(request_count),0)::bigint AS requests
         FROM bot_users
         GROUP BY store
         ORDER BY requests DESC`
      );
      const lines = [
        '📊 <b>Статистика Telegram-бота</b>',
        '',
        `Всего пользователей: <b>${totalRows[0].users}</b>`,
        `Всего запросов: <b>${totalRows[0].requests}</b>`,
        '',
        '<b>По складам:</b>'
      ];
      for (const r of byStore) {
        lines.push(`🏬 ${esc(r.store)} — ${r.users} польз. · ${r.requests} запросов`);
      }
      return tgSend(chatId, lines.join('\n'));
    }

    case '/fixcompound': {
      // Находит в Овире все уже сохранённые артикулы, слитые через дефис из нескольких
      // цветов (например «405638-BLBK-LGW»), и разбивает каждый на отдельные товары
      // на том же месте — без ручного /del + повторной отправки по одному.
      const { rows } = await pool.query(
        `SELECT article, warehouse, floor, "row", cell FROM items WHERE warehouse = '2'`
      );
      const fixes = [];
      for (const it of rows) {
        const parts = splitCompoundArticle(it.article);
        if (parts.length < 2) continue;
        await pool.query('DELETE FROM items WHERE article = $1', [it.article]);
        for (const article of parts) {
          let name = article;
          const g = msGroups.get(article);
          if (g) name = `${g.model} ${g.color}`.trim();
          await pool.query(
            `INSERT INTO items (article, name, warehouse, floor, "row", cell) VALUES ($1, $2, '2', $3, $4, $5)
             ON CONFLICT (article) DO UPDATE SET warehouse = '2', floor = $3, "row" = $4, cell = $5`,
            [article, name, it.floor, it.row, it.cell]
          );
        }
        fixes.push({ from: it.article, to: parts, floor: it.floor, row: it.row, cell: it.cell });
      }
      if (!fixes.length) {
        return tgSend(chatId, '✅ Составных артикулов, которые нужно разбить, в Овире не найдено — всё чисто.');
      }
      const lines = [`🔧 Исправлено составных позиций: <b>${fixes.length}</b>`, ''];
      for (const f of fixes) {
        lines.push(`${esc(f.from)} → ${f.to.map(esc).join(', ')} (этаж ${esc(f.floor)}, ряд ${esc(f.row)}, ячейка ${esc(f.cell)})`);
      }
      return tgSend(chatId, lines.join('\n'));
    }

    default:
      return tgSend(chatId, 'Неизвестная команда. /help — список команд.');
  }
}

async function handleUpdate(update) {
  const cq = update.callback_query;
  const msg = update.message || update.edited_message;
  const trackChatId = cq ? (cq.message ? cq.message.chat.id : (cq.from && cq.from.id)) : (msg && msg.chat.id);
  const trackFrom = cq ? cq.from : (msg && msg.from);
  if (trackChatId) trackBotActivity(trackChatId, trackFrom);

  if (cq) return handleCallback(cq);

  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const store = await getUserStore(chatId);

  // Команды
  if (text.startsWith('/')) {
    const cmd = text.split(/\s+/)[0].split('@')[0].toLowerCase();
    if (cmd === '/start' || cmd === '/menu' || cmd === '/help') {
      if (!store) return tgSend(chatId, '👋 Добро пожаловать в склад Skechers!\n\nТы сотрудник какого магазина?', { reply_markup: storeKeyboard() });
      return tgSend(chatId, `Твой магазин: <b>${esc(store)}</b>\nВыбери действие или просто набери артикул:`, { reply_markup: mainMenu() });
    }
    // Управляющие/старые команды — только администратору
    if (!isAllowed(chatId)) return tgSend(chatId, '⛔ Эта команда только для администратора. Нажми /start для меню.');
    return handleCommand(chatId, text);
  }

  // Массовая расстановка по ячейкам Овира (список «Ряд N Буква» или просто «N Буква» + артикулы) — только админ
  if (isAllowed(chatId) && looksLikeBulkPlace(text)) {
    return handleBulkPlace(chatId, text);
  }

  // Не выбран магазин — просим выбрать
  if (!store) {
    return tgSend(chatId, '👋 Сначала выбери свой магазин:', { reply_markup: storeKeyboard() });
  }

  // Обычный текст = поисковый запрос (режим по умолчанию — остатки МойСклад)
  const mode = botMode.get(chatId) || 'ms';
  if (mode === 'local') {
    return tgSend(chatId, await formatLocalResult(text), { reply_markup: mainMenu() });
  }
  return tgSend(chatId, formatMsResult(text, store), { reply_markup: mainMenu() });
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
initDB().then(async () => {
  app.listen(PORT, () => console.log(`✅ Сервер запущен на порту ${PORT}`));
  if (TG) startBot();
  else console.log('ℹ️ Telegram-бот выключен (нет TELEGRAM_BOT_TOKEN)');

  // Подхватываем последний сохранённый снимок каталога МойСклад — чтобы после
  // рестарта (любой деплой) сайт и бот сразу показывали данные, а не пусто,
  // пока идёт свежая пересинхронизация (она запустится следом, ниже).
  await loadMsCacheFromDB();

  // Синхронизация каталога МойСклад: каждые 20 минут, плюс сразу при старте —
  // но только если подхваченный кэш уже устарел. Тяжёлая раскладка по складам
  // занимает несколько минут; если деплоить часто (несколько раз подряд), каждый
  // рестарт обрывал её на середине, и сайт вечно видел только частичные данные.
  // Раз кэш свежий — ждём планового обновления, а не запускаем ресинк заново.
  if (msConfigured()) {
    if (isMsCacheStale(msCatalog.updatedAt)) {
      msSyncAll().catch(e => console.error('ms sync', e.message));
    } else {
      console.log(`ℹ️ МойСклад: кэш ещё свежий (обновлён ${msCatalog.updatedAt}) — жду планового обновления`);
    }
    setInterval(() => msSyncAll().catch(e => console.error('ms sync', e.message)), 20 * 60 * 1000);
  } else {
    console.log('ℹ️ Синхронизация МойСклад выключена (нет доступа)');
  }
}).catch(err => {
  console.error('❌ Ошибка запуска:', err.message);
  process.exit(1);
});
