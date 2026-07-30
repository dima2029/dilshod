// Массовая расстановка товаров по ячейкам склада Овир — чистые функции без сети/БД,
// чтобы разбор пересланных списков был протестирован отдельно от бота.

// Схема Овира: этаж определяется по букве ячейки (ряд 1–10 на обоих этажах).
const OVIR_FLOOR_BY_LETTER = {};
['А', 'Б', 'Д', 'Е', 'З', 'И', 'Л', 'М'].forEach(l => { OVIR_FLOOR_BY_LETTER[l] = '2'; });
['В', 'Г', 'Ё', 'Ж', 'Й', 'К', 'Н', 'О'].forEach(l => { OVIR_FLOOR_BY_LETTER[l] = '1'; });

// Похоже ли слово на артикул Skechers (302183L-BBLM, 310197-CRL, 303571-GYMT-BKMT…):
// начинается с 4+ цифр, возможен короткий буквенный суффикс, дальше обязательно дефис.
// Так отсеиваются случайные слова-комментарии («если», «ряд», «свет» и т.п.) и одиночные цифры.
const ARTICLE_RE = /^\d{4,}[A-ZА-ЯЁ]{0,3}-[A-ZА-ЯЁ0-9-]+$/i;

// Убирает обрамляющие кавычки/скобки вокруг артикула: «303571-GYMT-BKMT» -> 303571-GYMT-BKMT
function stripPunctuation(tok) {
  return tok.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

// Заголовок блока — два варианта:
//  1) со словом «Ряд»/«Ряди»: «Ряд 8 Б» — после буквы допускается хвост (?=\s|$),
//     т.к. слово «Ряд» само по себе однозначно указывает на заголовок;
//  2) без слова, просто «3 Ё»: тут строка должна состоять РОВНО из числа и буквы
//     (якорь $ в конце) — иначе случайно поймаем комментарий вроде «9 м это и есть
//     ряд или», который тоже начинается с «число + буква», но на самом деле не заголовок.
// (?=\s|$)/\s*$ вместо \b — в JS-регулярках \w (и, значит, \b) не распознаёт кириллицу.
const HEADER_WITH_PREFIX_RE = /^ряд[аи]?\.?\s+(\d{1,2})\s*[-,:]?\s*([А-ЯЁа-яё])(?=\s|$)/i;
const HEADER_BARE_RE = /^(\d{1,2})\s*[-,:]?\s*([А-ЯЁа-яё])\s*$/i;

function matchHeader(line) {
  return line.match(HEADER_WITH_PREFIX_RE) || line.match(HEADER_BARE_RE);
}

// Похоже ли сообщение на массовую расстановку — проверяем первую непустую строку.
// Используется и ботом (решить, обрабатывать ли текст как расстановку, а не как поиск),
// и самим парсером ниже — единая точка правды, чтобы триггер и разбор не расходились.
function looksLikeBulkPlace(text) {
  const firstLine = String(text || '').split(/\r?\n/).map(l => l.trim()).find(Boolean) || '';
  return Boolean(matchHeader(firstLine));
}

// Разбирает пересланный список вида:
//   Ряд 8 Б            (или просто «8 Б», без слова «Ряд»)
//   310197-CRL
//   310561-BKLD
// Допускает несколько блоков «Ряд N Буква» подряд в одном сообщении, а также
// пояснительные строки-комментарии вперемешку с артикулами — они просто пропускаются.
function parseBulkPlaceBlocks(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const blocks = [];
  let current = null;
  let ignored = 0;
  for (const line of lines) {
    const m = matchHeader(line);
    if (m) {
      current = { row: m[1], letter: m[2].toUpperCase(), articles: [] };
      blocks.push(current);
      continue;
    }
    if (!current) continue;
    for (const raw of line.split(/\s+/)) {
      const tok = stripPunctuation(raw).toUpperCase();
      if (!tok) continue;
      if (ARTICLE_RE.test(tok)) current.articles.push(tok);
      else ignored++;
    }
  }
  return { blocks, ignored };
}

// Артикулы в списках нередко склеены через дефис — это НЕСКОЛЬКО разных цветов
// одной модели, слитых вместе (например «405638-BLBK-LGW» = «405638-BLBK» +
// «405638-LGW», «403988-BLU-BLK» = «403988-BLU» + «403988-BLK»), а не один товар
// с составным названием цвета. Правило простое: 2+ цветовых сегмента после номера
// модели — всегда отдельные позиции. Проверка по каталогу МойСклад ненадёжна (там
// эти цвета вполне могут не значиться отдельными SKU, хотя на полке это два разных
// товара), поэтому разбиваем безусловно, по одному только виду кода.
function splitCompoundArticle(article) {
  const m = article.match(/^(\d+[A-ZА-ЯЁ]*)-(.+)$/i);
  if (!m) return [article];
  const [, base, rest] = m;
  const parts = rest.split('-').filter(Boolean);
  if (parts.length < 2) return [article];
  return parts.map(p => `${base}-${p}`);
}

module.exports = { OVIR_FLOOR_BY_LETTER, parseBulkPlaceBlocks, splitCompoundArticle, looksLikeBulkPlace };
