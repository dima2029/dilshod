const test = require('node:test');
const assert = require('node:assert/strict');
const { OVIR_FLOOR_BY_LETTER, parseBulkPlaceBlocks } = require('../lib/warehouse-place');

test('OVIR_FLOOR_BY_LETTER: этаж 2 — А Б Д Е З И Л М, этаж 1 — В Г Ё Ж Й К Н О', () => {
  for (const l of ['А', 'Б', 'Д', 'Е', 'З', 'И', 'Л', 'М']) assert.equal(OVIR_FLOOR_BY_LETTER[l], '2');
  for (const l of ['В', 'Г', 'Ё', 'Ж', 'Й', 'К', 'Н', 'О']) assert.equal(OVIR_FLOOR_BY_LETTER[l], '1');
  assert.equal(OVIR_FLOOR_BY_LETTER['Ю'], undefined);
});

test('parseBulkPlaceBlocks разбирает один блок «Ряд N Буква» + артикулы', () => {
  const text = 'Ряд 8 Б\n310197-crl\n310561-bkld\n405039-slnv-bkcc';
  const blocks = parseBulkPlaceBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].row, '8');
  assert.equal(blocks[0].letter, 'Б');
  assert.deepEqual(blocks[0].articles, ['310197-CRL', '310561-BKLD', '405039-SLNV-BKCC']);
});

test('parseBulkPlaceBlocks разбирает несколько блоков в одном сообщении', () => {
  const text = [
    'Ряди 8 б',
    '310197-crl',
    '310561-bkld',
    'Ряди 8 д',
    '314078-hpmt',
    '403968-bblm'
  ].join('\n');
  const blocks = parseBulkPlaceBlocks(text);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].letter, 'Б');
  assert.deepEqual(blocks[0].articles, ['310197-CRL', '310561-BKLD']);
  assert.equal(blocks[1].letter, 'Д');
  assert.deepEqual(blocks[1].articles, ['314078-HPMT', '403968-BBLM']);
});

test('parseBulkPlaceBlocks: несколько артикулов на одной строке через пробел', () => {
  const text = 'Ряд 3 А\n310197-CRL 310561-BKLD';
  const blocks = parseBulkPlaceBlocks(text);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].articles, ['310197-CRL', '310561-BKLD']);
});

test('parseBulkPlaceBlocks возвращает пусто для текста без заголовка «Ряд»', () => {
  assert.deepEqual(parseBulkPlaceBlocks('310197-CRL\n310561-BKLD'), []);
  assert.deepEqual(parseBulkPlaceBlocks(''), []);
});
