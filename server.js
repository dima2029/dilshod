const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const QRCode = require('qrcode');
const {
  modelKey, colorFromName, sizeFromName, msPrice,
  parseStoreRenameMap, makeStoreDisplay,
  serializeMsSnapshot, deserializeMsSnapshot, isMsCacheStale,
  parseBarcodes, buildBarcodeIndex,
  sumByStore, cloneCatalogForStockRefresh, applyStockByStoreRow
} = require('./lib/moysklad-parse');
const { OVIR_FLOOR_BY_LETTER, parseBulkPlaceBlocks, splitCompoundArticle, looksLikeBulkPlace } = require('./lib/warehouse-place');
const { buildColinsCatalog } = require('./lib/colins-parse');
const { mapDashboardProductToRawItem } = require('./lib/colins-dashboard');
const { encodeCellCode, decodeCellCode, isCellCode } = require('./lib/cell-qr');

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
// Пауза между страницами пагинации при синхронизации — без неё все запросы одного
// прохода улетают пачкой за секунды, и даже один нормальный цикл синхронизации может
// кратковременно превысить лимит МойСклад (блокировки 1, 4 авг 2026).
// Официальный лимит (dev.moysklad.ru/doc/api/remap/1.2/#/restrictions) — «корзинка»
// 45 ЕДИНИЦ/3с, но разные эндпоинты списывают разный «вес» за один запрос:
//  - /entity/assortment — вес 1 (стандартный, растёт по расписанию авторизации по
//    логину/паролю: 2 с 12 мая 2026, 3 с 1 сен, 4 с 1 дек — т.е. минимум 11 запр/3с
//    даже в конце года). 300мс = ~3.3 запр/с — с запасом на весь 2026 год.
//  - /report/stock/bystore и /report/stock/all — вес ВСЕГДА 5, независимо от способа
//    авторизации. Лимит для них = 45÷5 = 9 запросов/3с (~333мс минимум) — это
//    отдельная, более жёсткая пауза, см. MS_BYSTORE_DELAY_MS ниже.
// Также действует лимит «не более 200 запросов/мин с ошибкой 429 за последний час» —
// именно он, а не «400/мин» из письма-уведомления, реально отключает доступ.
const MS_PAGE_DELAY_MS = Number(process.env.MOYSKLAD_PAGE_DELAY_MS) || 300;
const MS_BYSTORE_DELAY_MS = Number(process.env.MOYSKLAD_BYSTORE_DELAY_MS) || 600;
// Как часто гонять полную синхронизацию каталога. Каждый цикл тянет весь ассортимент
// (~37 стр.) + тяжёлую раскладку bystore (вес 5) — это основной источник запросов к
// МойСкладу. Реже цикл = меньше запросов = меньше риск блокировки за «много запросов».
// По умолчанию 30 мин; при блокировках можно поднять до 60 через переменную в Railway.
const MS_SYNC_INTERVAL_MS = Math.max(5, Number(process.env.MOYSKLAD_SYNC_INTERVAL_MIN) || 30) * 60 * 1000;

// Colin's (365trends.tj) — публичный API (витрина), токен не нужен
const COLINS_API_URL = process.env.COLINS_API_URL || 'https://api.365trends.tj/api/products/sidebar-filter';
const COLINS_BRAND_ID = process.env.COLINS_BRAND_ID || 'colins';

// Colin's — полные данные напрямую из админ-панели (Dashboard-Products), а не только
// то, что опубликовано на витрине. Нужны логин/пароль админки; если их нет — просто
// продолжаем работать по публичному API, как раньше.
const COLINS_DASHBOARD_URL = process.env.COLINS_DASHBOARD_URL || 'https://dashboard.365trends.tj';
const COLINS_DASHBOARD_API_URL = process.env.COLINS_DASHBOARD_API_URL || 'https://api.365trends.tj';
const COLINS_DASHBOARD_USERNAME = process.env.COLINS_DASHBOARD_USERNAME || '';
const COLINS_DASHBOARD_PASSWORD = process.env.COLINS_DASHBOARD_PASSWORD || '';
const COLINS_DASHBOARD_CONCURRENCY = Number(process.env.COLINS_DASHBOARD_CONCURRENCY) || 5;

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
  // Кэш каталога Colin's (365trends.tj) — тот же смысл, что и ms_cache.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS colins_cache (
      id         INTEGER PRIMARY KEY DEFAULT 1,
      payload    JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  // Метка «когда последний раз ПОПЫТАЛИСЬ запустить синхронизацию» (в отличие от
  // ms_cache/colins_cache, где пишется только УСПЕШНЫЙ результат). Живёт в Postgres,
  // а не в памяти процесса — при частых деплоях подряд (несколько рестартов за
  // 10–15 минут) каждый новый процесс иначе не видит, что предыдущий уже начал
  // тяжёлую пересинхронизацию, и запускает её заново поверх — так 1-2 авг 2026
  // МойСклад заблокировал доступ за всплеск запросов. См. recentSyncAttempt().
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sync_attempts (
      name       TEXT PRIMARY KEY,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now()
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

// Размещение товара со сканера (сначала сканируется QR ячейки, потом штрихкод товара) —
// в отличие от POST /api/items, не отказывает, если артикул уже есть, а ПЕРЕМЕЩАЕТ его
// в новую ячейку (в т.ч. на другой склад). Возвращает предыдущее место — для кнопки
// «Отменить последний скан» на сайте.
app.post('/api/items/place', async (req, res) => {
  const { article, name, warehouse, floor, row, cell } = req.body;
  if (!article) return res.status(400).json({ error: 'Артикул обязателен' });
  const key = String(article).toUpperCase();

  const prevRes = await pool.query('SELECT * FROM items WHERE article = $1', [key]);
  const previous = prevRes.rows[0] || null;

  await pool.query(
    `INSERT INTO items (article, name, warehouse, floor, "row", cell)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (article) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, items.name),
       warehouse = EXCLUDED.warehouse, floor = EXCLUDED.floor, "row" = EXCLUDED."row", cell = EXCLUDED.cell`,
    [key, name || (previous && previous.name) || key, warehouse || '1', floor || null, row || null, cell || null]
  );
  notify(`📷 Скан: <b>${esc(key)}</b> → ${esc(WH_NAMES[warehouse] || warehouse)}, эт.${esc(floor || '—')} ряд ${esc(row || '—')} ${esc(cell || '—')}`);
  res.json({ success: true, previous, wasNew: !previous });
});

// Отмена последнего скана: либо вернуть товар на предыдущее место, либо удалить,
// если до этого скана его не существовало вовсе.
app.post('/api/items/undo-place', async (req, res) => {
  const { article, previous } = req.body;
  if (!article) return res.status(400).json({ error: 'Артикул обязателен' });
  const key = String(article).toUpperCase();
  if (previous) {
    await pool.query(
      `UPDATE items SET name=$2, warehouse=$3, floor=$4, "row"=$5, cell=$6 WHERE article=$1`,
      [key, previous.name, previous.warehouse, previous.floor, previous.row, previous.cell]
    );
  } else {
    await pool.query('DELETE FROM items WHERE article = $1', [key]);
  }
  res.json({ success: true });
});

// Поиск товара по штрихкоду (для сканера на сайте) — данные из штрихкодов МойСклад,
// собираются при обычной синхронизации, без отдельных запросов к API.
app.get('/api/barcode/:code', (req, res) => {
  const info = msBarcodeMap.get(String(req.params.code).trim());
  if (!info) return res.status(404).json({ found: false });
  res.json({ found: true, ...info });
});

// Картинка QR-кода для печати на ячейку — генерируется на лету, ничего не хранится.
app.get('/api/qr.png', async (req, res) => {
  const text = String(req.query.text || '');
  if (!text) return res.status(400).json({ error: 'Нет text' });
  try {
    const buf = await QRCode.toBuffer(text, { type: 'png', width: 260, margin: 1 });
    res.set('Content-Type', 'image/png');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

// Диагностика последней синхронизации МойСклад — без этого при повторной блокировке
// API приходится гадать, что именно пошло не так (см. блокировки 1, 4 авг 2026).
app.get('/api/moysklad/debug', (req, res) => {
  // authMode: чем реально авторизуется бот — 'token' (Bearer, приоритет), иначе 'login', иначе 'none'.
  const authMode = MS_TOKEN ? 'token' : ((MS_LOGIN && MS_PASSWORD) ? 'login' : 'none');
  res.json({ authMode, sync: msSyncState, pageDelayMs: MS_PAGE_DELAY_MS, bystoreDelayMs: MS_BYSTORE_DELAY_MS, ...msDebug });
});

// Ручной запуск синхронизации Colin's, не дожидаясь плановых 20 минут (например, сразу
// после деплоя, чтобы проверить результат). colinsSyncAll() сам не даёт запустить
// вторую синхронизацию, пока идёт текущая, так что повторные вызовы безопасны.
app.post('/api/colins/resync', (req, res) => {
  colinsSyncAll().catch(e => console.error('colins resync', e.message));
  res.json({ started: true, sync: colinsSyncState });
});

// Ручной ПОЛНЫЙ пересбор каталога МойСклад — кнопка «Новый приход» на сайте. Тянет весь
// ассортимент (названия/цены/штрихкоды/новые артикулы) — самый тяжёлый запрос к API.
// Плановые циклы обновляют ТОЛЬКО остатки, поэтому полный пересбор запускаем вручную,
// когда реально пришёл новый товар — так резко меньше запросов к МойСкладу.
app.post('/api/moysklad/resync-full', (req, res) => {
  if (!msConfigured()) return res.status(400).json({ error: 'МойСклад не настроен' });
  if (msSyncState.status === 'running') return res.json({ started: false, already: true, sync: msSyncState });
  msSyncAll({ full: true }).catch(e => console.error('ms resync-full', e.message));
  res.json({ started: true, sync: msSyncState });
});

// Каталог Colin's (365trends.tj) — модель -> цвета -> размеры, только остаток > 0.
app.get('/api/colins', (req, res) => {
  res.json({
    updatedAt: colinsPublic.updatedAt,
    sync: colinsSyncState,
    count: colinsPublic.count,
    rows: colinsPublic.rows,
    dashboard: {
      configured: Boolean(COLINS_DASHBOARD_USERNAME && COLINS_DASHBOARD_PASSWORD),
      lastError: colinsDashboardLastError
    }
  });
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
    // Чем реально авторизуется бот: 'token' (Bearer) в приоритете, иначе 'login', иначе 'none'.
    // Помогает убедиться, что перешли именно на токен, а не молча остались на логине/пароле.
    authMode: MS_TOKEN ? 'token' : ((MS_LOGIN && MS_PASSWORD) ? 'login' : 'none'),
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
let msBarcodeMap = new Map(); // штрихкод -> { article, model, color } — для сканера на сайте

// Каталог МойСклад живёт только в памяти процесса — при каждом деплое Railway
// перезапускает сервер, и без кэша сайт/бот несколько минут показывают пусто,
// пока идёт полная пересинхронизация. Сохраняем последний успешный снимок в
// Postgres и подхватываем его при старте, чтобы не ждать вхолостую.
async function saveMsCache() {
  try {
    const snap = {
      ...serializeMsSnapshot({
        storeNames: msStoreNames, publicData: msPublic,
        models: msModels, groups: msGroups, info: msInfoAll
      }),
      barcodes: [...msBarcodeMap.entries()]
    };
    await pool.query(
      `INSERT INTO ms_cache (id, payload, updated_at) VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET payload = $1, updated_at = now()`,
      [JSON.stringify(snap)]
    );
  } catch (e) { console.error('⚠️ saveMsCache:', e.message); }
}

// Не запускать тяжёлую полную пересинхронизацию, если попытка (даже неудачная/
// прерванная) уже стартовала совсем недавно — защита от всплеска запросов при
// нескольких деплоях подряд (каждый рестарт иначе честно видел «кэш устарел» и
// запускал новый проход поверх ещё не завершившегося предыдущего).
const SYNC_ATTEMPT_COOLDOWN_MS = 10 * 60 * 1000;

async function recordSyncAttempt(name) {
  try {
    await pool.query(
      `INSERT INTO sync_attempts (name, started_at) VALUES ($1, now())
       ON CONFLICT (name) DO UPDATE SET started_at = now()`,
      [name]
    );
  } catch (e) { console.error('⚠️ recordSyncAttempt:', e.message); }
}

async function recentSyncAttempt(name, cooldownMs = SYNC_ATTEMPT_COOLDOWN_MS) {
  try {
    const { rows } = await pool.query('SELECT started_at FROM sync_attempts WHERE name = $1', [name]);
    if (!rows.length) return false;
    return (Date.now() - new Date(rows[0].started_at).getTime()) < cooldownMs;
  } catch (e) { console.error('⚠️ recentSyncAttempt:', e.message); return false; }
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
    msBarcodeMap = new Map(rows[0].payload.barcodes || []);
    msCatalog = { updatedAt: rows[0].updated_at, count: msModels.size };
    console.log(`♻️  МойСклад: восстановлен кэш из Postgres (${msModels.size} моделей, обновлён ${rows[0].updated_at})`);
    return true;
  } catch (e) { console.error('⚠️ loadMsCacheFromDB:', e.message); return false; }
}

// ======================================================================
//  Colin's (365trends.tj) — отдельный каталог остатков/цен, публичный API
// ======================================================================
let colinsPublic = { updatedAt: null, count: 0, rows: [] };
let colinsSyncState = { status: 'idle', startedAt: null, finishedAt: null, lastError: null };

async function colinsFetch(url, opts = {}, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function colinsSyncAll() {
  if (colinsSyncState.status === 'running') { console.log('⏳ Colin\'s: синхронизация уже идёт, пропускаю запуск'); return; }
  colinsSyncState = { status: 'running', startedAt: new Date().toISOString(), finishedAt: null, lastError: null };
  await recordSyncAttempt('colins');
  try {
    await colinsSyncAllInner();
    colinsSyncState.status = 'done';
  } catch (e) {
    colinsSyncState.status = 'error';
    colinsSyncState.lastError = e.message;
    console.error('❌ Colin\'s синхронизация:', e.message);
  } finally {
    colinsSyncState.finishedAt = new Date().toISOString();
  }
}

// Ошибка последней попытки зайти в админку — отдельно от colinsSyncState.lastError,
// потому что сама синхронизация в целом при этом всё равно завершается успешно
// (падаем обратно на публичный API), и общий lastError её не увидит.
let colinsDashboardLastError = null;

async function colinsSyncAllInner() {
  let raw = null;
  if (COLINS_DASHBOARD_USERNAME && COLINS_DASHBOARD_PASSWORD) {
    try {
      raw = await colinsDashboardFetchAll();
      colinsDashboardLastError = null;
      console.log(`✅ Colin's: полные данные из админ-панели (${raw.length} товаров)`);
    } catch (e) {
      colinsDashboardLastError = { message: e.message, at: new Date().toISOString() };
      console.error('⚠️ Colin\'s: синхронизация из админ-панели не удалась, использую публичный API:', e.message);
      raw = null;
    }
  }
  if (!raw) raw = await colinsFetchPublicAll();

  const rows = buildColinsCatalog(raw);
  // Не затираем ранее собранный каталог пустышкой, если проход неожиданно вернул пусто.
  if (!rows.length && colinsPublic.rows.length) {
    console.warn('⚠️ Colin\'s: новый проход пуст — сохраняю прошлые данные');
    return;
  }
  colinsPublic = { updatedAt: new Date().toISOString(), count: rows.length, rows };
  saveColinsCache();
}

// Публичная витрина (sidebar-filter) — только опубликованные товары. Используется,
// если админ-доступ не настроен или временно недоступен.
async function colinsFetchPublicAll() {
  const headers = { 'Content-Type': 'application/json' };
  const body = JSON.stringify({ brendIds: [COLINS_BRAND_ID] });
  const take = 100;

  const firstRes = await colinsFetch(`${COLINS_API_URL}?take=1&skip=0`, { method: 'POST', headers, body });
  if (!firstRes.ok) throw new Error(`Colin's API HTTP ${firstRes.status}`);
  const total = Number((await firstRes.json()).total) || 0;

  const raw = [];
  const maxPages = Math.ceil(total / take) + 5; // страховка от «бесконечной» пагинации
  for (let p = 0, skip = 0; p < maxPages && skip < total; p++, skip += take) {
    const r = await colinsFetch(`${COLINS_API_URL}?take=${take}&skip=${skip}`, { method: 'POST', headers, body });
    if (!r.ok) throw new Error(`Colin's API HTTP ${r.status} (skip=${skip})`);
    const items = (await r.json()).items || [];
    if (!items.length) break;
    raw.push(...items);
  }
  return raw;
}

// ---- Полная выгрузка из закрытой админ-панели (Dashboard-Products) ----

function colinsGetSetCookies(res) {
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
  const raw = res.headers.get('set-cookie');
  return raw ? [raw] : [];
}

// Ищем нужный cookie по имени внутри каждой Set-Cookie строки БЕЗ привязки к началу
// строки: на Node без Headers.getSetCookie() несколько Set-Cookie из одного ответа
// (например, session-token и callback-url в ответе логина) склеиваются в одну строку
// через ", ", и нужный cookie может оказаться не первым.
function colinsPickCookie(cookies, name) {
  const re = new RegExp(`(?:^|[,\\s])${name}=[^;]+`);
  for (const c of cookies) {
    const m = c.match(re);
    if (m) return m[0].replace(/^[,\s]+/, '');
  }
  return '';
}

// Логин в админку 365trends.tj через NextAuth (credentials provider) и получение
// JWT accessToken, которым дальше подписываются запросы к api.365trends.tj/api/dashboard/*.
async function colinsDashboardLogin() {
  const csrfRes = await colinsFetch(`${COLINS_DASHBOARD_URL}/api/auth/csrf`);
  if (!csrfRes.ok) throw new Error(`csrf HTTP ${csrfRes.status}`);
  const csrfCookie = colinsPickCookie(colinsGetSetCookies(csrfRes), '__Host-next-auth.csrf-token');
  const { csrfToken } = await csrfRes.json();
  if (!csrfToken) throw new Error('не удалось получить csrfToken');

  const params = new URLSearchParams({
    csrfToken,
    username: COLINS_DASHBOARD_USERNAME,
    password: COLINS_DASHBOARD_PASSWORD,
    callbackUrl: '/',
    json: 'true'
  });
  const loginRes = await colinsFetch(`${COLINS_DASHBOARD_URL}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: csrfCookie },
    body: params.toString()
  });
  if (!loginRes.ok) throw new Error(`логин HTTP ${loginRes.status}`);
  const sessionCookie = colinsPickCookie(colinsGetSetCookies(loginRes), '__Secure-next-auth.session-token');
  if (!sessionCookie) throw new Error('логин не удался — неверные учётные данные?');

  const sessionRes = await colinsFetch(`${COLINS_DASHBOARD_URL}/api/auth/session`, {
    headers: { Cookie: sessionCookie }
  });
  if (!sessionRes.ok) throw new Error(`session HTTP ${sessionRes.status}`);
  const sessionData = await sessionRes.json();
  const accessToken = sessionData && sessionData.user && sessionData.user.accessToken;
  if (!accessToken) throw new Error('не удалось получить accessToken из сессии');
  return accessToken;
}

// Выполняет fn для каждого элемента items с не более чем limit одновременными вызовами —
// чтобы не создавать 5000+ параллельных запросов к чужому серверу разом.
async function colinsMapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, worker));
  return results;
}

async function colinsDashboardFetchAll() {
  const token = await colinsDashboardLogin();
  const authHeaders = { Authorization: `Bearer ${token}` };
  const take = 1000;

  const list = [];
  for (let skip = 0, total = Infinity; skip < total; skip += take) {
    const r = await colinsFetch(`${COLINS_DASHBOARD_API_URL}/api/dashboard/products?take=${take}&skip=${skip}`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ brendIds: [COLINS_BRAND_ID] })
    }, 30000);
    if (!r.ok) throw new Error(`dashboard/products HTTP ${r.status} (skip=${skip})`);
    const data = await r.json();
    total = Number(data.total) || 0;
    const items = data.items || [];
    if (!items.length) break;
    list.push(...items);
  }

  const details = await colinsMapWithConcurrency(list, COLINS_DASHBOARD_CONCURRENCY, async (item) => {
    try {
      const r = await colinsFetch(`${COLINS_DASHBOARD_API_URL}/api/dashboard/products/${item.id}`, { headers: authHeaders }, 20000);
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      return null;
    }
  });

  return details.filter(Boolean).map(mapDashboardProductToRawItem);
}

async function saveColinsCache() {
  try {
    await pool.query(
      `INSERT INTO colins_cache (id, payload, updated_at) VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET payload = $1, updated_at = now()`,
      [JSON.stringify(colinsPublic)]
    );
  } catch (e) { console.error('⚠️ saveColinsCache:', e.message); }
}

async function loadColinsCacheFromDB() {
  try {
    const { rows } = await pool.query('SELECT payload, updated_at FROM colins_cache WHERE id = 1');
    if (!rows.length) return false;
    colinsPublic = rows[0].payload || colinsPublic;
    console.log(`♻️  Colin's: восстановлен кэш из Postgres (${colinsPublic.count} моделей, обновлён ${rows[0].updated_at})`);
    return true;
  } catch (e) { console.error('⚠️ loadColinsCacheFromDB:', e.message); return false; }
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

async function msSyncAll(opts = {}) {
  const auth = msAuthHeader();
  if (!auth) { msSyncState = { status: 'error', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), lastError: 'МойСклад не настроен: нет MOYSKLAD_TOKEN или MOYSKLAD_LOGIN/MOYSKLAD_PASSWORD в Railway' }; return; }
  if (msSyncState.status === 'running') { console.log('⏳ МойСклад: синхронизация уже идёт, пропускаю запуск'); return; }
  msSyncState = { status: 'running', startedAt: new Date().toISOString(), finishedAt: null, lastError: null, mode: opts.full ? 'full' : 'stock-only' };
  await recordSyncAttempt('moysklad');
  try {
    await msSyncAllInner(auth, opts);
    msSyncState.status = 'done';
  } catch (e) {
    msSyncState.status = 'error';
    msSyncState.lastError = e.message;
    console.error('❌ МойСклад синхронизация:', e.message);
  } finally {
    msSyncState.finishedAt = new Date().toISOString();
  }
}

async function msSyncAllInner(auth, { full = false } = {}) {
  // На «холодном» старте (каталога в памяти ещё нет) полный проход обязателен — даже
  // если попросили только остатки, брать их не к чему привязывать.
  const doFull = full || msInfoAll.size === 0;
  msDebug = { lastRun: new Date().toISOString(), mode: doFull ? 'full' : 'stock-only', storesFetched: [], perStore: [], errors: [] };
  const headers = { 'Authorization': auth, 'Accept': 'application/json;charset=utf-8' };

  // Список складов освежаем только при полном проходе (это тоже запрос к API). В режиме
  // «только остатки» переиспользуем прошлый список — склады меняются крайне редко.
  if (doFull) await msFetchStores();
  msDebug.storesFetched = msStores.map(s => s.name);
  const stores = msStores.length ? msStores
    : (msStoreNames.length ? msStoreNames.map(n => ({ id: null, name: n, display: n }))
      : [{ id: null, name: 'Всего' }]);

  // Полный проход — строим каталог заново из ассортимента.
  // «Только остатки» — берём КОПИЮ прошлого каталога (названия/цены/штрихкоды не трогаем),
  // с обнулёнными остатками: заполним их свежими из bystore. Копия, а не сам msInfoAll —
  // чтобы при сбое bystore живой каталог/поиск не обнулился (замена атомарна в rebuild()).
  const info = doFull ? new Map() : cloneCatalogForStockRefresh(msInfoAll); // id -> инфо

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

  // 1) Полный ассортимент (товары + модификации) — ТОЛЬКО в полном проходе (кнопка
  //    «Новый приход» или холодный старт). Самый тяжёлый запрос; в обычном цикле «только
  //    остатки» его НЕ делаем — названия/цены/штрихкоды берём из кэша.
  //    Остаток лежит на МОДИФИКАЦИЯХ (у товара с модификациями stock = 0). База
  //    модификации берётся из НАЗВАНИЯ, т.к. code у модификации = штрихкод.
  if (doFull) {
  try {
    let offset = 0;
    for (let page = 0; page < 400; page++) {
      if (page > 0) await sleep(MS_PAGE_DELAY_MS); // не бить по API пачкой без пауз — см. блокировку 1-2 авг 2026
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
          price: msPrice(it), totalStock: Number(it.stock) || 0, byStore: {},
          barcodes: parseBarcodes(it.barcodes)
        });
      }
      offset += batch.length;
    }
    msDebug.infoCount = info.size;
    msBarcodeMap = buildBarcodeIndex(info.values());
  } catch (e) { msDebug.errors.push('assortment ' + e.message); }

  // Ранняя публикация (после ассортимента, но ДО раскладки по складам) — только на
  // «холодном» старте, когда каталога ещё нет вообще. В этот момент byStore пустой,
  // поэтому колонки складов (Овир/Ашан/…) = 0. Если опубликовать это поверх уже
  // готового каталога, то на все ~7 минут тяжёлой раскладки bystore на экране будет
  // «Итого верное, а склады по нулям» — ровно тот баг, что ловили в отчёте бота.
  // Каталог и так восстанавливается из Postgres при старте, так что почти всегда
  // msModels уже заполнен — в этом случае оставляем на экране прошлый ПОЛНЫЙ каталог
  // (с колонками) и заменяем его финальным rebuild() уже с раскладкой по складам.
  if (msModels.size === 0) {
    rebuild();
    console.log(`🔄 МойСклад [full]: ассортимент ${info.size} — холодный старт, итоги опубликованы, идёт раскладка по складам…`);
  } else {
    console.log(`🔄 МойСклад [full]: ассортимент ${info.size} — идёт раскладка по складам, до её готовности показываю прошлый каталог…`);
  }
  } else {
    // Обычный цикл «только остатки»: каталог уже в info (копия из кэша) с обнулёнными
    // остатками — распроданные позиции уйдут в 0 (positiveOnly их не вернёт), затем
    // bystore зальёт свежие. Ассортимент не трогаем.
    msDebug.infoCount = info.size;
    console.log(`🔄 МойСклад [stock-only]: каталог из кэша (${info.size} поз.) — тяну только остатки bystore…`);
  }

  // 2) /report/stock/bystore — раскладка по складам (join по id модификации).
  //    stockMode=positiveOnly резко уменьшает выборку (только позиции с остатком > 0) —
  //    без него отчёт по всему ассортименту очень тяжёлый и долгий.
  async function runByStore(mode) {
    let matched = 0, offset = 0, firstErr = null;
    const maxPages = Math.ceil(info.size / 1000) + 5; // страховка от «бесконечной» пагинации
    const q = mode ? `&stockMode=${mode}` : '';
    for (let p = 0; p < maxPages; p++) {
      if (p > 0) await sleep(MS_BYSTORE_DELAY_MS); // вес этого эндпоинта = 5 единиц — своя, более строгая пауза
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
        if (applyStockByStoreRow(info, row, { skipStores: MS_SKIP_STORES, storeDisplay })) matched++;
      }
      offset += rows.length;
    }
    return { matched, firstErr };
  }

  let matched = 0;
  try {
    // Быстрый проход только по позициям с остатком; полный проход по всему
    // ассортименту — тяжёлый (см. комментарий выше), включаем его резервом ТОЛЬКО
    // если positiveOnly сам отработал, но вернул пусто (похоже, режим не поддержан).
    // Если же positiveOnly упал с ошибкой (429/403 — признак лимита/блокировки API) —
    // НЕ включаем тяжёлый резерв поверх уже проблемного запроса, просто пропускаем
    // раскладку по складам в этом цикле и пробуем на следующем плановом проходе.
    let res = await runByStore('positiveOnly');
    if (res.firstErr) {
      msDebug.errors.push('positiveOnly: ' + res.firstErr + ' — пропускаю резервный проход в этом цикле');
    } else if (res.matched === 0) {
      msDebug.errors.push('positiveOnly вернул пусто — полный проход');
      await sleep(MS_BYSTORE_DELAY_MS);
      res = await runByStore('');
      if (res.firstErr) msDebug.errors.push(res.firstErr);
    }
    matched = res.matched;
    msDebug.bystoreMatched = matched;
  } catch (e) { msDebug.errors.push('bystore ' + e.message); }

  // В режиме «только остатки» Итого берём из суммы по складам (ассортимент не тянули,
  // его totalStock устарел бы). В полном проходе totalStock уже задан из ассортимента.
  if (!doFull) {
    for (const inf of info.values()) inf.totalStock = sumByStore(inf.byStore);
  }

  // 3) финальная пересборка — теперь с раскладкой по складам (byStore)
  rebuild();
  console.log(`🔄 МойСклад готов [${doFull ? 'full' : 'stock-only'}]: складов ${msStoreNames.length}, моделей ${msModels.size}, раскладка по ${matched} позициям`);
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

const COLINS_STORE_NAME = 'Colin\'s';
function storeList() {
  const names = msStoreNames.length ? msStoreNames.filter(n => n !== 'Всего') : [];
  return [...names, COLINS_STORE_NAME, ALL_STORES];
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
// store передаём, чтобы показать разное меню для Colin's: у него нет ни складов
// МойСклад (кнопка «Остаток по всем складам» тут бессмысленна), ни физической
// раскладки по полкам — только поиск по каталогу Colin's.
function mainMenu(store) {
  if (store === COLINS_STORE_NAME) {
    const rows = [
      [{ text: '🔎 Найти остаток (Colin\'s)', callback_data: 'menu:colins' }],
      [{ text: '🏬 Сменить магазин', callback_data: 'menu:store' }]
    ];
    if (SITE_URL) rows.push([{ text: '🌐 Войти в сайт', url: SITE_URL }]);
    return { inline_keyboard: rows };
  }
  const rows = [
    [{ text: '🔎 Найти остаток (МойСклад)', callback_data: 'menu:ms' }],
    [{ text: '🌍 Остаток по всем складам', callback_data: 'menu:ms-all' }],
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

// Ответ по остаткам — сразу по всем складам, с разбивкой (не только свой магазин)
function formatMsAllResult(query) {
  const found = searchMsColors(query);
  const stores = (msStoreNames || []).filter(n => n !== ALL_STORES);
  const blocks = [];
  for (const { c } of found) {
    const perStore = stores.map(s => `${esc(s)}: <b>${c.byStore[s] || 0}</b>`).join('   ') || '—';
    blocks.push(`📦 <b>${esc(c.article)}</b> — ${esc(c.color)}\n${perStore}\nИтого: <b>${c.stock}</b>`);
    if (blocks.length >= 12) break;
  }
  if (!blocks.length) return `По «${esc(query)}» ничего не найдено.`;
  return '🌍 Остатки по всем складам:\n\n' + blocks.join('\n\n');
}

// Поиск по каталогу Colin's (365trends.tj) — модель/цвет/артикул
function searchColins(query) {
  const q = query.trim().toUpperCase();
  if (!q) return [];
  const res = [];
  for (const m of (colinsPublic.rows || [])) {
    const modelHit = String(m.model || '').toUpperCase().includes(q);
    for (const c of (m.colors || [])) {
      if (modelHit || String(c.color || '').toUpperCase().includes(q) || String(c.article || '').toUpperCase().includes(q)) {
        res.push({ model: m.model, c });
        if (res.length >= 800) return res;
      }
    }
  }
  return res;
}

function formatColinsResult(query) {
  const found = searchColins(query);
  const blocks = [];
  for (const { model, c } of found) {
    const sizeStr = (c.sizes || []).map(s => `${esc(s.size)}=${s.stock}`).join('  ') || '—';
    const priceStr = c.oldPrice != null ? `${esc(c.oldPrice)} → <b>${esc(c.price)}</b>` : (c.price != null ? `<b>${esc(c.price)}</b>` : '—');
    blocks.push(`👖 <b>${esc(model)}</b> — ${esc(c.color)} (${esc(c.article)})\nОстаток: <b>${c.stock}</b> шт\nразмеры: ${sizeStr}\nЦена: ${priceStr}`);
    if (blocks.length >= 12) break;
  }
  if (!blocks.length) return `По «${esc(query)}» у Colin's ничего не найдено.`;
  return '👖 Colin\'s:\n\n' + blocks.join('\n\n');
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
    if (name === COLINS_STORE_NAME) {
      botMode.set(chatId, 'colins');
      return tgSend(chatId, `✅ Твой магазин: <b>${esc(name)}</b>\n\nТеперь просто набирай артикул или модель — покажу остаток и цену у Colin's.`, { reply_markup: mainMenu(name) });
    }
    botMode.set(chatId, 'ms');
    return tgSend(chatId, `✅ Твой магазин: <b>${esc(name)}</b>\n\nТеперь просто набирай артикул — покажу остаток по твоему магазину.`, { reply_markup: mainMenu(name) });
  }
  if (data === 'menu:ms') {
    botMode.set(chatId, 'ms');
    return tgSend(chatId, '🔎 Набирай артикул или модель (можно несколько подряд) — покажу остаток и размеры по твоему магазину.');
  }
  if (data === 'menu:colins') {
    botMode.set(chatId, 'colins');
    return tgSend(chatId, '👖 Набирай артикул или модель — покажу остаток и цену у Colin\'s.');
  }
  if (data === 'menu:ms-all') {
    botMode.set(chatId, 'ms-all');
    return tgSend(chatId, '🌍 Набирай артикул или модель — покажу остаток сразу по всем складам.');
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
      return tgSend(chatId, `Твой магазин: <b>${esc(store)}</b>\nВыбери действие или просто набери артикул:`, { reply_markup: mainMenu(store) });
    }
    // Управляющие/старые команды — только администратору
    if (!isAllowed(chatId)) return tgSend(chatId, '⛔ Эта команда только для администратора. Нажми /start для меню.');
    return handleCommand(chatId, text);
  }

  // Массовая расстановка по ячейкам Овира (список «Ряд N Буква» или просто «N Буква» + артикулы) —
  // доступно всем сотрудникам, не только админу, чтобы распределять товар мог любой участник.
  if (looksLikeBulkPlace(text)) {
    return handleBulkPlace(chatId, text);
  }

  // Не выбран магазин — просим выбрать
  if (!store) {
    return tgSend(chatId, '👋 Сначала выбери свой магазин:', { reply_markup: storeKeyboard() });
  }

  // Обычный текст = поисковый запрос (режим по умолчанию — остатки МойСклад)
  const mode = botMode.get(chatId) || 'ms';
  if (mode === 'local') {
    return tgSend(chatId, await formatLocalResult(text), { reply_markup: mainMenu(store) });
  }
  if (mode === 'ms-all') {
    return tgSend(chatId, formatMsAllResult(text), { reply_markup: mainMenu(store) });
  }
  if (mode === 'colins') {
    return tgSend(chatId, formatColinsResult(text), { reply_markup: mainMenu(store) });
  }
  return tgSend(chatId, formatMsResult(text, store), { reply_markup: mainMenu(store) });
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
    if (await recentSyncAttempt('moysklad')) {
      console.log('ℹ️ МойСклад: попытка синхронизации уже была совсем недавно (другой процесс/деплой) — не запускаю сразу, жду планового обновления');
    } else if (isMsCacheStale(msCatalog.updatedAt)) {
      msSyncAll().catch(e => console.error('ms sync', e.message));
    } else {
      console.log(`ℹ️ МойСклад: кэш ещё свежий (обновлён ${msCatalog.updatedAt}) — жду планового обновления`);
    }
    console.log(`⏱️ МойСклад: синхронизация каждые ${MS_SYNC_INTERVAL_MS / 60000} мин`);
    setInterval(() => msSyncAll().catch(e => console.error('ms sync', e.message)), MS_SYNC_INTERVAL_MS);
  } else {
    console.log('ℹ️ Синхронизация МойСклад выключена (нет доступа)');
  }

  // Colin's (365trends.tj): тот же принцип кэша и «не дёргать ресинк, если свежий»,
  // плюс та же защита от повторных попыток при частых деплоях подряд.
  await loadColinsCacheFromDB();
  if (await recentSyncAttempt('colins')) {
    console.log('ℹ️ Colin\'s: попытка синхронизации уже была совсем недавно (другой процесс/деплой) — не запускаю сразу, жду планового обновления');
  } else if (isMsCacheStale(colinsPublic.updatedAt)) {
    colinsSyncAll().catch(e => console.error('colins sync', e.message));
  } else {
    console.log(`ℹ️ Colin's: кэш ещё свежий (обновлён ${colinsPublic.updatedAt}) — жду планового обновления`);
  }
  setInterval(() => colinsSyncAll().catch(e => console.error('colins sync', e.message)), 20 * 60 * 1000);
}).catch(err => {
  console.error('❌ Ошибка запуска:', err.message);
  process.exit(1);
});
