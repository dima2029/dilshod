const test = require('node:test');
const assert = require('node:assert/strict');
const {
  OVIR_FLOOR_BY_LETTER, parseBulkPlaceBlocks, splitCompoundArticle, looksLikeBulkPlace,
  normalizeDashes, normalizeConfusableLetter
} = require('../lib/warehouse-place');

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

test('parseBulkPlaceBlocks понимает заголовок и без слова «Ряд» (реальный кейс: «3 ё»)', () => {
  const text = '3 ё\n210810-khk\n220624-gry\n216522ww-bbk\n211196-char\n216812-nvgy\n118156-dknv';
  const { blocks } = parseBulkPlaceBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].row, '3');
  assert.equal(blocks[0].letter, 'Ё');
  assert.deepEqual(blocks[0].articles, [
    '210810-KHK', '220624-GRY', '216522WW-BBK', '211196-CHAR', '216812-NVGY', '118156-DKNV'
  ]);
});

test('looksLikeBulkPlace: распознаёт и «Ряд N Буква», и просто «N Буква»', () => {
  assert.equal(looksLikeBulkPlace('Ряд 8 Б\n310197-CRL'), true);
  assert.equal(looksLikeBulkPlace('Ряди 9 м\n406334-gybl'), true);
  assert.equal(looksLikeBulkPlace('3 ё\n210810-khk'), true);
  assert.equal(looksLikeBulkPlace('310197-CRL'), false);
  assert.equal(looksLikeBulkPlace('310197'), false);
  assert.equal(looksLikeBulkPlace(''), false);
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

test('splitCompoundArticle: 2 цвета через дефис — всегда разбиваем на 2 товара', () => {
  assert.deepEqual(splitCompoundArticle('405638-BLBK-LGW'), ['405638-BLBK', '405638-LGW']);
  assert.deepEqual(splitCompoundArticle('403988-BLU-BLK'), ['403988-BLU', '403988-BLK']);
});

test('splitCompoundArticle: 4 цвета через дефис — разбиваем на 4 товара', () => {
  assert.deepEqual(
    splitCompoundArticle('310197-WHT-BBK-LAV-LTPK'),
    ['310197-WHT', '310197-BBK', '310197-LAV', '310197-LTPK']
  );
});

test('splitCompoundArticle: без второго дефиса (обычный артикул) — не разбиваем', () => {
  assert.deepEqual(splitCompoundArticle('310197-CRL'), ['310197-CRL']);
  assert.deepEqual(splitCompoundArticle('403865-RYBK'), ['403865-RYBK']);
});

test('normalizeDashes: приводит длинное/короткое тире, минус и слэш к обычному дефису', () => {
  assert.equal(normalizeDashes('4–Н'), '4-Н');   // en dash (U+2013) — типичная автозамена на iPhone
  assert.equal(normalizeDashes('4—Н'), '4-Н');   // em dash (U+2014)
  assert.equal(normalizeDashes('4‑Н'), '4-Н');   // non-breaking hyphen (U+2011)
  assert.equal(normalizeDashes('4−5'), '4-5');   // minus sign (U+2212)
  assert.equal(normalizeDashes('205700-DKNV/BBK'), '205700-DKNV-BBK'); // слэш между цветами
  assert.equal(normalizeDashes('4-Н'), '4-Н');   // обычный дефис не трогаем
});

test('реальный кейс: заголовок с автозаменённым тире (en dash) + артикул со слэшем (как реально пришло с iPhone)', () => {
  const text = '4–Н\n205700-dknv/bbk';
  assert.equal(looksLikeBulkPlace(text), true);
  const { blocks } = parseBulkPlaceBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].row, '4');
  assert.equal(blocks[0].letter, 'Н');
  assert.deepEqual(blocks[0].articles, ['205700-DKNV-BBK']);
  // и сам составной артикул разбивается на 2 товара, как обычно
  assert.deepEqual(splitCompoundArticle(blocks[0].articles[0]), ['205700-DKNV', '205700-BBK']);
});

test('normalizeConfusableLetter: латинские буквы-двойники приводятся к кириллическим', () => {
  assert.equal(normalizeConfusableLetter('A'), 'А');
  assert.equal(normalizeConfusableLetter('B'), 'В');
  assert.equal(normalizeConfusableLetter('E'), 'Е');
  assert.equal(normalizeConfusableLetter('K'), 'К');
  assert.equal(normalizeConfusableLetter('M'), 'М');
  assert.equal(normalizeConfusableLetter('H'), 'Н');
  assert.equal(normalizeConfusableLetter('O'), 'О');
  assert.equal(normalizeConfusableLetter('b'), 'В'); // регистр не важен
  assert.equal(normalizeConfusableLetter('Б'), 'Б'); // уже кириллица — не трогаем
});

test('реальный кейс: буква заголовка набрана на латинице («3-B» вместо «3-В»)', () => {
  const text = [
    '3-B',
    '232836-bkw',
    '118277-gry',
    '220821-wht',
    '216518-gry',
    '246084-blbk',
    '118309-bbk'
  ].join('\n');
  assert.equal(looksLikeBulkPlace(text), true);
  const { blocks } = parseBulkPlaceBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].row, '3');
  assert.equal(blocks[0].letter, 'В'); // латинская B стала кириллической В
  assert.equal(OVIR_FLOOR_BY_LETTER[blocks[0].letter], '1'); // и лукап по схеме склада срабатывает
  assert.deepEqual(blocks[0].articles, [
    '232836-BKW', '118277-GRY', '220821-WHT', '216518-GRY', '246084-BLBK', '118309-BBK'
  ]);
});
