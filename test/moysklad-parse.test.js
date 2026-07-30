const test = require('node:test');
const assert = require('node:assert/strict');
const {
  baseArticle, modelKey, colorFromName, sizeFromName, msPrice,
  parseStoreRenameMap, makeStoreDisplay,
  serializeMsSnapshot, deserializeMsSnapshot, isMsCacheStale
} = require('../lib/moysklad-parse');

test('baseArticle отрезает размер/цвет в скобках', () => {
  assert.equal(baseArticle({ name: '402183L-BBLM (32, BLUE BLACK LIME)' }), '402183L-BBLM');
  assert.equal(baseArticle({ code: '216301-CHAR (44, CHARCOAL)' }), '216301-CHAR');
  assert.equal(baseArticle({ article: '303552L-NVY' }), '303552L-NVY');
});

test('modelKey берёт часть артикула до первого дефиса', () => {
  assert.equal(modelKey('402183L-BBLM'), '402183L');
  assert.equal(modelKey('402183L'), '402183L');
});

test('colorFromName достаёт цвет, пропуская размер', () => {
  assert.equal(colorFromName({ name: '402183L-BBLM (32, BLUE BLACK LIME)' }), 'BLUE BLACK LIME');
  assert.equal(colorFromName({ name: '402183L-BBLM' }), '');
});

test('sizeFromName достаёт размер', () => {
  assert.equal(sizeFromName({ name: '402183L-BBLM (32, BLUE BLACK LIME)' }), '32');
  assert.equal(sizeFromName({ name: '402183L-BBLM' }), '');
});

test('msPrice переводит копейки МойСклад в рубли/сумы', () => {
  assert.equal(msPrice({ salePrices: [{ value: 54990 }] }), 549.9);
  assert.equal(msPrice({ salePrices: [] }), null);
  assert.equal(msPrice({}), null);
});

test('parseStoreRenameMap + storeDisplay переименовывают известные склады и не трогают остальные', () => {
  const map = parseStoreRenameMap('Основной склад=Овир, Скечерс Ашан=Ашан');
  const storeDisplay = makeStoreDisplay(map);
  assert.equal(storeDisplay('Основной склад'), 'Овир');
  assert.equal(storeDisplay('Скечерс Ашан'), 'Ашан');
  assert.equal(storeDisplay('Валаматзода'), 'Валаматзода');
});

test('parseStoreRenameMap с пустой строкой даёт пустую карту', () => {
  assert.deepEqual(parseStoreRenameMap(''), {});
  assert.deepEqual(parseStoreRenameMap(undefined), {});
});

test('serializeMsSnapshot/deserializeMsSnapshot переживают JSON-круговорот (кэш в Postgres)', () => {
  const sizes = new Map([['44', { size: '44', article: '216301-CHAR-44', stock: 5, byStore: { 'Овир': 5 } }]]);
  const colors = new Map([['216301-CHAR', { article: '216301-CHAR', color: 'CHARCOAL', stock: 5, byStore: { 'Овир': 5 }, price: 549.9, sizes }]]);
  const models = new Map([['216301', { model: '216301', stock: 5, byStore: { 'Овир': 5 }, colors }]]);
  const groups = new Map([['216301-CHAR', { article: '216301-CHAR', model: '216301', color: 'CHARCOAL', stock: 5, byStore: { 'Овир': 5 }, price: 549.9 }]]);
  const info = new Map([['abc-123', { base: '216301-CHAR', baseU: '216301-CHAR', model: '216301', color: 'CHARCOAL', size: '44', variantArticle: '216301-CHAR-44', price: 549.9, totalStock: 5, byStore: { 'Овир': 5 } }]]);
  const publicData = { updatedAt: 'now', stores: ['Овир'], count: 1, rows: [] };

  const snap = serializeMsSnapshot({ storeNames: ['Овир', 'Фаровон'], publicData, models, groups, info });
  // Как в Postgres JSONB: снимок проходит через JSON туда и обратно
  const roundTripped = JSON.parse(JSON.stringify(snap));
  const restored = deserializeMsSnapshot(roundTripped);

  assert.deepEqual(restored.storeNames, ['Овир', 'Фаровон']);
  assert.deepEqual(restored.publicData, publicData);
  assert.equal(restored.models.size, 1);
  assert.equal(restored.groups.size, 1);
  assert.equal(restored.info.size, 1);

  const m = restored.models.get('216301');
  assert.equal(m.stock, 5);
  assert.ok(m.colors instanceof Map);
  const c = m.colors.get('216301-CHAR');
  assert.equal(c.stock, 5);
  assert.ok(c.sizes instanceof Map);
  assert.deepEqual(c.sizes.get('44'), { size: '44', article: '216301-CHAR-44', stock: 5, byStore: { 'Овир': 5 } });
});

test('deserializeMsSnapshot безопасен на пустом/частичном снимке', () => {
  const restored = deserializeMsSnapshot({});
  assert.deepEqual(restored.storeNames, []);
  assert.equal(restored.publicData, null);
  assert.equal(restored.models.size, 0);
  assert.equal(restored.groups.size, 0);
  assert.equal(restored.info.size, 0);
});

test('isMsCacheStale: нет даты обновления — считаем устаревшим (нужен ресинк)', () => {
  assert.equal(isMsCacheStale(null), true);
  assert.equal(isMsCacheStale(undefined), true);
  assert.equal(isMsCacheStale('не дата'), true);
});

test('isMsCacheStale: свежий кэш (только что обновился) — ресинк не нужен', () => {
  const now = Date.parse('2026-01-01T00:20:00Z');
  const updatedAt = '2026-01-01T00:19:00Z'; // минуту назад
  assert.equal(isMsCacheStale(updatedAt, now), false);
});

test('isMsCacheStale: кэш старше 20 минут — нужен ресинк', () => {
  const now = Date.parse('2026-01-01T00:20:00Z');
  const updatedAt = '2026-01-01T00:00:00Z'; // 20 минут назад — граница
  assert.equal(isMsCacheStale(updatedAt, now), true);
  const fresher = '2026-01-01T00:00:01Z'; // 19:59 назад — ещё свежий
  assert.equal(isMsCacheStale(fresher, now), false);
});
