// Чистые функции разбора данных МойСклад — без сети и без побочных эффектов,
// чтобы их можно было покрыть тестами отдельно от запуска всего сервера.

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

// Размер из названия: "402183L-BBLM (32, BLUE BLACK LIME)" -> "32"
function sizeFromName(r) {
  const m = String(r.name || '').match(/\(([^)]*)\)/);
  return m ? m[1].split(',')[0].trim() : '';
}

function msPrice(it) {
  return Array.isArray(it.salePrices) && it.salePrices[0]
    ? it.salePrices[0].value / 100 : null;
}

// МойСклад отдаёт штрихкоды товара/модификации как массив объектов вида
// [{ean13:"4820022500048"}, {code128:"..."}] — тип может быть любой (ean13/ean8/code128/...),
// нас интересует само значение. Возвращает плоский список строк-кодов (без пустых).
function parseBarcodes(rawBarcodes) {
  if (!Array.isArray(rawBarcodes)) return [];
  const out = [];
  for (const b of rawBarcodes) {
    if (!b || typeof b !== 'object') continue;
    for (const v of Object.values(b)) {
      if (typeof v === 'string' && v.trim()) out.push(v.trim());
    }
  }
  return out;
}

// Строит индекс «штрихкод -> карточка товара» из уже собранного каталога МойСклад
// (Map id -> info, где у info есть base/model/color и barcodes из parseBarcodes выше).
// У разных размеров одного артикула/цвета разные штрихкоды — все они ведут на одну
// и ту же карточку (артикул+модель+цвет), поэтому отсканировать можно любой размер.
function buildBarcodeIndex(infoValues) {
  const index = new Map();
  for (const inf of infoValues) {
    for (const code of (inf.barcodes || [])) {
      if (!index.has(code)) {
        index.set(code, { article: inf.base, model: inf.model, color: inf.color });
      }
    }
  }
  return index;
}

// Разбирает MOYSKLAD_STORE_MAP вида "Основной склад=Овир,Скечерс Ашан=Ашан" в карту переименования
function parseStoreRenameMap(envValue) {
  const map = {};
  (envValue || '').split(',').forEach(pair => {
    const [from, to] = pair.split('=').map(s => (s || '').trim());
    if (from && to) map[from.toLowerCase()] = to;
  });
  return map;
}

function makeStoreDisplay(renameMap) {
  return function storeDisplay(name) {
    return renameMap[String(name || '').trim().toLowerCase()] || name;
  };
}

// Снимок каталога МойСклад для кэша в Postgres (переживает рестарт сервера при деплое).
// Map нельзя сохранить в JSON напрямую — переводим в массивы пар [key, value] и обратно.

function serializeMsSnapshot({ storeNames, publicData, models, groups, info }) {
  return {
    storeNames,
    public: publicData,
    models: [...models.entries()].map(([key, m]) => [key, {
      model: m.model, stock: m.stock, byStore: m.byStore,
      colors: [...m.colors.entries()].map(([ck, c]) => [ck, {
        article: c.article, color: c.color, stock: c.stock, byStore: c.byStore, price: c.price,
        sizes: [...c.sizes.entries()]
      }])
    }]),
    groups: [...groups.entries()],
    info: [...info.entries()]
  };
}

function deserializeMsSnapshot(snap) {
  const models = new Map((snap.models || []).map(([key, m]) => [key, {
    model: m.model, stock: m.stock, byStore: m.byStore,
    colors: new Map((m.colors || []).map(([ck, c]) => [ck, { ...c, sizes: new Map(c.sizes || []) }]))
  }]));
  return {
    storeNames: snap.storeNames || [],
    publicData: snap.public || null,
    models,
    groups: new Map(snap.groups || []),
    info: new Map(snap.info || [])
  };
}

// Нужно ли запускать полную ресинхронизацию прямо сейчас, или кэш ещё достаточно свежий?
// Смысл: тяжёлая раскладка по складам занимает несколько минут — если деплоить часто
// (несколько раз подряд за пару минут), процесс перезапускается раньше, чем она успевает
// закончиться и сохраниться в кэш, и сайт вечно видит только частично готовые данные.
// Пока кэш свежий, не запускаем немедленный ресинк при старте — дождёмся планового.
function isMsCacheStale(updatedAt, now = Date.now(), staleMs = 20 * 60 * 1000) {
  if (!updatedAt) return true;
  const t = new Date(updatedAt).getTime();
  if (Number.isNaN(t)) return true;
  return (now - t) >= staleMs;
}

// --- Раздельный синк «только остатки» (см. server.js msSyncAllInner) ----------------

// Сумма остатков позиции по всем складам. В режиме «только остатки» из неё берётся Итого,
// т.к. ассортимент (с его totalStock) в этом цикле не тянется.
function sumByStore(byStore) {
  let t = 0;
  for (const k in (byStore || {})) t += Number(byStore[k]) || 0;
  return t;
}

// Клон каталога для цикла «только остатки»: те же карточки (названия/цены/штрихкоды),
// но с обнулёнными остатками — их зальёт свежая раскладка bystore. ВАЖНО: работаем на
// копии, а не на живом msInfoAll — при сбое bystore живой поиск/каталог не обнулится
// (замена произойдёт атомарно). Оригинальные карточки и их массив barcodes не мутируются.
function cloneCatalogForStockRefresh(infoMap) {
  return new Map(
    [...infoMap.entries()].map(([id, inf]) => [id, { ...inf, byStore: {}, totalStock: 0 }])
  );
}

// Разложить одну строку отчёта /report/stock/bystore по складам в inf.byStore.
// join по id модификации; склады из skipStores пропускаем; имя склада переименовываем
// через storeDisplay; берём только положительный остаток. Возвращает true, если позиция
// нашлась в каталоге (иначе строка не от нашего товара — например, из другого прохода).
function applyStockByStoreRow(info, row, { skipStores = [], storeDisplay = (x) => x } = {}) {
  const id = String((row && row.meta && row.meta.href) || '').split('?')[0].split('/').pop();
  const inf = info.get(id);
  if (!inf) return false;
  for (const sb of ((row && row.stockByStore) || [])) {
    const sName = (sb && sb.name) || '';
    if (!sName || skipStores.includes(sName.toLowerCase())) continue;
    const st = Number(sb.stock) || 0;
    if (st > 0) { const disp = storeDisplay(sName); inf.byStore[disp] = (inf.byStore[disp] || 0) + st; }
  }
  return true;
}

module.exports = {
  baseArticle, modelKey, colorFromName, sizeFromName, msPrice, parseStoreRenameMap, makeStoreDisplay,
  serializeMsSnapshot, deserializeMsSnapshot, isMsCacheStale, parseBarcodes, buildBarcodeIndex,
  sumByStore, cloneCatalogForStockRefresh, applyStockByStoreRow
};
