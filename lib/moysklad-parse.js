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

module.exports = {
  baseArticle, modelKey, colorFromName, sizeFromName, msPrice, parseStoreRenameMap, makeStoreDisplay,
  serializeMsSnapshot, deserializeMsSnapshot
};
