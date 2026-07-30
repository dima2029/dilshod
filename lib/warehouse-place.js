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

// Разбирает пересланный список вида:
//   Ряд 8 Б
//   310197-CRL
//   310561-BKLD
// Допускает несколько блоков «Ряд N Буква» подряд в одном сообщении, а также
// пояснительные строки-комментарии вперемешку с артикулами — они просто пропускаются.
function parseBulkPlaceBlocks(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  // (?=\s|$) вместо \b — в JS-регулярках \w (и, значит, \b) не распознаёт кириллицу
  const headerRe = /^ряд[аи]?\.?\s+(\d{1,2})\s*[-,:]?\s*([А-ЯЁа-яё])(?=\s|$)/i;
  const blocks = [];
  let current = null;
  let ignored = 0;
  for (const line of lines) {
    const m = line.match(headerRe);
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

// Некоторые артикулы в списках склеены через дефис — на самом деле это НЕСКОЛЬКО
// разных товаров одной модели (например «405638-BLBK-LGW» = «405638-BLBK» + «405638-LGW»),
// а не один товар с составным цветом (как «303571-GYMT-BKMT», где весь код — один цвет).
// Различить это можно только по каталогу МойСклад: если целый код найден как есть —
// это один товар; если нет, но раздельные части найдены по отдельности — значит, это
// несколько товаров, слитых вместе. hasInCatalog — функция article -> boolean (например
// code => msGroups.has(code)).
function splitCompoundArticle(article, hasInCatalog) {
  if (hasInCatalog(article)) return [article];
  const m = article.match(/^(\d+[A-ZА-ЯЁ]*)-(.+)$/i);
  if (!m) return [article];
  const [, base, rest] = m;
  const parts = rest.split('-').filter(Boolean);
  if (parts.length < 2) return [article];
  const candidates = parts.map(p => `${base}-${p}`);
  return candidates.every(hasInCatalog) ? candidates : [article];
}

module.exports = { OVIR_FLOOR_BY_LETTER, parseBulkPlaceBlocks, splitCompoundArticle };
