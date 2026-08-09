// Тесты раздельного синка «только остатки» (см. server.js msSyncAllInner).
// Проверяем чистые функции из lib/moysklad-parse.js, на которые server.js реально опирается.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sumByStore, cloneCatalogForStockRefresh, applyStockByStoreRow, makeStoreDisplay, parseStoreRenameMap
} = require('../lib/moysklad-parse');

// Хелпер: строка отчёта /report/stock/bystore
const bystoreRow = (id, stockByStore) => ({
  meta: { href: `https://api.moysklad.ru/api/remap/1.2/entity/variant/${id}?expand=x` },
  stockByStore
});
// Хелпер: карточка каталога, как в server.js info
const card = (over = {}) => ({
  base: '216301-NVY', baseU: '216301-NVY', model: '216301', color: 'NAVY', size: '42',
  variantArticle: '88890024', price: 2199.9, totalStock: 0, byStore: {}, barcodes: ['4820022500048'],
  ...over
});

// ---------- sumByStore ----------
test('sumByStore: суммирует все склады', () => {
  assert.equal(sumByStore({ 'Овир': 11, 'Ашан': 3 }), 14);
});
test('sumByStore: пустой/undefined/null → 0', () => {
  assert.equal(sumByStore({}), 0);
  assert.equal(sumByStore(undefined), 0);
  assert.equal(sumByStore(null), 0);
});
test('sumByStore: нечисловые значения игнорируются', () => {
  assert.equal(sumByStore({ 'Овир': 5, 'X': 'abc', 'Ашан': 2 }), 7);
});

// ---------- cloneCatalogForStockRefresh ----------
test('cloneCatalogForStockRefresh: обнуляет остатки, но сохраняет карточку', () => {
  const orig = new Map([['id1', card({ totalStock: 9, byStore: { 'Овир': 9 } })]]);
  const clone = cloneCatalogForStockRefresh(orig);
  const c = clone.get('id1');
  assert.deepEqual(c.byStore, {}, 'byStore обнулён');
  assert.equal(c.totalStock, 0, 'totalStock обнулён');
  assert.equal(c.base, '216301-NVY', 'название/артикул сохранены');
  assert.equal(c.price, 2199.9, 'цена сохранена');
  assert.deepEqual(c.barcodes, ['4820022500048'], 'штрихкоды сохранены');
});
test('cloneCatalogForStockRefresh: НЕ мутирует оригинал (атомарная замена)', () => {
  const origCard = card({ totalStock: 9, byStore: { 'Овир': 9 } });
  const orig = new Map([['id1', origCard]]);
  const clone = cloneCatalogForStockRefresh(orig);
  // мутируем клон
  clone.get('id1').byStore['Ашан'] = 3;
  clone.get('id1').totalStock = 3;
  // оригинал не тронут
  assert.deepEqual(origCard.byStore, { 'Овир': 9 }, 'byStore оригинала не изменился');
  assert.equal(origCard.totalStock, 9, 'totalStock оригинала не изменился');
});
test('cloneCatalogForStockRefresh: новый Map с теми же id', () => {
  const orig = new Map([['a', card()], ['b', card({ base: 'X' })]]);
  const clone = cloneCatalogForStockRefresh(orig);
  assert.notEqual(clone, orig);
  assert.deepEqual([...clone.keys()].sort(), ['a', 'b']);
});

// ---------- applyStockByStoreRow ----------
test('applyStockByStoreRow: join по id, заполняет byStore', () => {
  const info = new Map([['v1', card()]]);
  const ok = applyStockByStoreRow(info, bystoreRow('v1', [
    { name: 'Овир', stock: 11 }, { name: 'Ашан', stock: 3 }
  ]));
  assert.equal(ok, true);
  assert.deepEqual(info.get('v1').byStore, { 'Овир': 11, 'Ашан': 3 });
});
test('applyStockByStoreRow: неизвестный id → false, без мутаций', () => {
  const info = new Map([['v1', card()]]);
  const ok = applyStockByStoreRow(info, bystoreRow('other', [{ name: 'Овир', stock: 5 }]));
  assert.equal(ok, false);
  assert.deepEqual(info.get('v1').byStore, {});
});
test('applyStockByStoreRow: нулевой/отрицательный остаток не пишется', () => {
  const info = new Map([['v1', card()]]);
  applyStockByStoreRow(info, bystoreRow('v1', [
    { name: 'Овир', stock: 0 }, { name: 'Ашан', stock: -2 }, { name: 'Фаровон', stock: 4 }
  ]));
  assert.deepEqual(info.get('v1').byStore, { 'Фаровон': 4 });
});
test('applyStockByStoreRow: skipStores пропускаются (по нижнему регистру)', () => {
  const info = new Map([['v1', card()]]);
  applyStockByStoreRow(info, bystoreRow('v1', [
    { name: 'Овир', stock: 11 }, { name: 'Резерв 2023', stock: 99 }
  ]), { skipStores: ['резерв 2023'] });
  assert.deepEqual(info.get('v1').byStore, { 'Овир': 11 });
});
test('applyStockByStoreRow: storeDisplay переименовывает склад', () => {
  const info = new Map([['v1', card()]]);
  const storeDisplay = makeStoreDisplay(parseStoreRenameMap('Основной склад=Овир'));
  applyStockByStoreRow(info, bystoreRow('v1', [{ name: 'Основной склад', stock: 7 }]), { storeDisplay });
  assert.deepEqual(info.get('v1').byStore, { 'Овир': 7 });
});
test('applyStockByStoreRow: несколько строк одного товара накапливаются', () => {
  const info = new Map([['v1', card()]]);
  applyStockByStoreRow(info, bystoreRow('v1', [{ name: 'Овир', stock: 5 }]));
  applyStockByStoreRow(info, bystoreRow('v1', [{ name: 'Овир', stock: 2 }, { name: 'Ашан', stock: 3 }]));
  assert.deepEqual(info.get('v1').byStore, { 'Овир': 7, 'Ашан': 3 });
});

// ---------- Интеграция: полный цикл «только остатки» ----------
test('цикл stock-only: Итого = сумме колонок, распроданное уходит в 0, оригинал цел', () => {
  // Прошлый каталог (в памяти) — как после полного синка
  const live = new Map([
    ['nvy42', card({ base: '216301-NVY', baseU: '216301-NVY', size: '42', totalStock: 5, byStore: { 'Овир': 5 } })],
    ['char44', card({ base: '216301-CHAR', baseU: '216301-CHAR', color: 'CHAR', size: '44', totalStock: 8, byStore: { 'Овир': 8 } })],
    ['sold', card({ base: '216301-GRY', baseU: '216301-GRY', color: 'GRY', size: '43', totalStock: 4, byStore: { 'Ашан': 4 } })],
  ]);

  // 1) клон
  const info = cloneCatalogForStockRefresh(live);
  // 2) свежая раскладка bystore (nvy и char есть, gry распродан — его строки нет)
  applyStockByStoreRow(info, bystoreRow('nvy42', [{ name: 'Овир', stock: 11 }, { name: 'Ашан', stock: 3 }]));
  applyStockByStoreRow(info, bystoreRow('char44', [{ name: 'Овир', stock: 22 }, { name: 'Ашан', stock: 6 }]));
  // 3) пересчёт Итого из суммы по складам
  for (const inf of info.values()) inf.totalStock = sumByStore(inf.byStore);

  // Итого == сумме колонок (тот самый инвариант из бага)
  assert.equal(info.get('nvy42').totalStock, 14);
  assert.equal(sumByStore(info.get('nvy42').byStore), info.get('nvy42').totalStock);
  assert.equal(info.get('char44').totalStock, 28);
  assert.equal(sumByStore(info.get('char44').byStore), info.get('char44').totalStock);

  // Распроданная позиция ушла в 0 и с пустыми складами
  assert.equal(info.get('sold').totalStock, 0);
  assert.deepEqual(info.get('sold').byStore, {});

  // Живой каталог (оригинал) не тронут до атомарной замены
  assert.equal(live.get('nvy42').totalStock, 5);
  assert.deepEqual(live.get('nvy42').byStore, { 'Овир': 5 });
  assert.equal(live.get('sold').totalStock, 4);
});
