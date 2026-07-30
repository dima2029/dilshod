const test = require('node:test');
const assert = require('node:assert/strict');
const {
  baseArticle, modelKey, colorFromName, sizeFromName, msPrice,
  parseStoreRenameMap, makeStoreDisplay
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
