// Массовая расстановка товаров по ячейкам склада Овир — чистые функции без сети/БД,
// чтобы разбор пересланных списков был протестирован отдельно от бота.

// Схема Овира: этаж определяется по букве ячейки (ряд 1–10 на обоих этажах).
const OVIR_FLOOR_BY_LETTER = {};
['А', 'Б', 'Д', 'Е', 'З', 'И', 'Л', 'М'].forEach(l => { OVIR_FLOOR_BY_LETTER[l] = '2'; });
['В', 'Г', 'Ё', 'Ж', 'Й', 'К', 'Н', 'О'].forEach(l => { OVIR_FLOOR_BY_LETTER[l] = '1'; });

// Разбирает пересланный список вида:
//   Ряд 8 Б
//   310197-CRL
//   310561-BKLD
// Допускает несколько блоков «Ряд N Буква» подряд в одном сообщении.
function parseBulkPlaceBlocks(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  // (?=\s|$) вместо \b — в JS-регулярках \w (и, значит, \b) не распознаёт кириллицу
  const headerRe = /^ряд[аи]?\.?\s+(\d{1,2})\s*[-,:]?\s*([А-ЯЁа-яё])(?=\s|$)/i;
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(headerRe);
    if (m) {
      current = { row: m[1], letter: m[2].toUpperCase(), articles: [] };
      blocks.push(current);
    } else if (current) {
      for (const tok of line.split(/\s+/)) {
        if (tok) current.articles.push(tok.toUpperCase());
      }
    }
  }
  return blocks;
}

module.exports = { OVIR_FLOOR_BY_LETTER, parseBulkPlaceBlocks };
