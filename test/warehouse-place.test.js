const test = require('node:test');
const assert = require('node:assert/strict');
const { OVIR_FLOOR_BY_LETTER, parseBulkPlaceBlocks, splitCompoundArticle } = require('../lib/warehouse-place');

test('OVIR_FLOOR_BY_LETTER: этаж 2 — А Б Д Е З И Л М, этаж 1 — В Г Ё Ж Й К Н О', () => {
  for (const l of ['А', 'Б', 'Д', 'Е', 'З', 'И', 'Л', 'М']) assert.equal(OVIR_FLOOR_BY_LETTER[l], '2');
  for (const l of ['В', 'Г', 'Ё', 'Ж', 'Й', 'К', 'Н', 'О']) assert.equal(OVIR_FLOOR_BY_LETTER[l], '1');
  assert.equal(OVIR_FLOOR_BY_LETTER['Ю'], undefined);
});

test('parseBulkPlaceBlocks разбирает один блок «Ряд N Буква» + артикулы', () => {
  const text = 'Ряд 8 Б\n310197-crl\n310561-bkld\n405039-slnv-bkcc';
  const { blocks, ignored } = parseBulkPlaceBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].row, '8');
  assert.equal(blocks[0].letter, 'Б');
  assert.deepEqual(blocks[0].articles, ['310197-CRL', '310561-BKLD', '405039-SLNV-BKCC']);
  assert.equal(ignored, 0);
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
  const { blocks } = parseBulkPlaceBlocks(text);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].letter, 'Б');
  assert.deepEqual(blocks[0].articles, ['310197-CRL', '310561-BKLD']);
  assert.equal(blocks[1].letter, 'Д');
  assert.deepEqual(blocks[1].articles, ['314078-HPMT', '403968-BBLM']);
});

test('parseBulkPlaceBlocks: несколько артикулов на одной строке через пробел', () => {
  const text = 'Ряд 3 А\n310197-CRL 310561-BKLD';
  const { blocks } = parseBulkPlaceBlocks(text);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].articles, ['310197-CRL', '310561-BKLD']);
});

test('parseBulkPlaceBlocks возвращает пусто для текста без заголовка «Ряд»', () => {
  assert.deepEqual(parseBulkPlaceBlocks('310197-CRL\n310561-BKLD').blocks, []);
  assert.deepEqual(parseBulkPlaceBlocks('').blocks, []);
});

test('parseBulkPlaceBlocks пропускает строки-комментарии вперемешку с артикулами (реальный кейс)', () => {
  const text = [
    'Ряди 9 м',
    '406334-gybl',
    '303932n-ltpk',
    '«303571-gymt-bkmt»',
    '404800-blk',
    '303644-lglv',
    '400590n-bblm',
    'эли 2 свет то значит 2 свет в этом якейке бивает',
    '9 м это и ест ряд или',
    '9-м чтото такое'
  ].join('\n');
  const { blocks, ignored } = parseBulkPlaceBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].row, '9');
  assert.equal(blocks[0].letter, 'М');
  assert.deepEqual(blocks[0].articles, [
    '406334-GYBL', '303932N-LTPK', '303571-GYMT-BKMT', '404800-BLK', '303644-LGLV', '400590N-BBLM'
  ]);
  assert.ok(ignored > 0, 'комментарии должны попасть в счётчик пропущенных, а не в артикулы');
});

test('splitCompoundArticle: целый код найден в каталоге — не трогаем (составной цвет, не два товара)', () => {
  const catalog = new Set(['303571-GYMT-BKMT']);
  assert.deepEqual(splitCompoundArticle('303571-GYMT-BKMT', c => catalog.has(c)), ['303571-GYMT-BKMT']);
});

test('splitCompoundArticle: целый код не найден, но части найдены — разбиваем на отдельные товары', () => {
  const catalog = new Set(['405638-BLBK', '405638-LGW']);
  assert.deepEqual(splitCompoundArticle('405638-BLBK-LGW', c => catalog.has(c)), ['405638-BLBK', '405638-LGW']);
});

test('splitCompoundArticle: ни целиком, ни по частям не найден — оставляем как есть (неизвестный товар)', () => {
  const catalog = new Set();
  assert.deepEqual(splitCompoundArticle('999999-AAA-BBB', c => catalog.has(c)), ['999999-AAA-BBB']);
});

test('splitCompoundArticle: найдена только одна часть — не разбиваем (неоднозначно, оставляем как есть)', () => {
  const catalog = new Set(['405638-BLBK']); // 405638-LGW не найден
  assert.deepEqual(splitCompoundArticle('405638-BLBK-LGW', c => catalog.has(c)), ['405638-BLBK-LGW']);
});

test('splitCompoundArticle: без второго дефиса — не разбиваем', () => {
  const catalog = new Set();
  assert.deepEqual(splitCompoundArticle('310197-CRL', c => catalog.has(c)), ['310197-CRL']);
});
