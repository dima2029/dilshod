// QR-код ячейки склада кодирует место как простую текстовую строку — этого достаточно,
// чтобы отличить его от штрихкода товара (тот всегда просто цифры) и распарсить обратно.
// Формат: CELL:<склад>:<этаж>:<ряд>:<ячейка>, например CELL:2:2:8:Б (Овир, эт.2, ряд 8, Б).
const CELL_PREFIX = 'CELL:';

function encodeCellCode({ warehouse, floor, row, cell }) {
  return `${CELL_PREFIX}${warehouse}:${floor || '-'}:${row || '-'}:${cell || '-'}`;
}

// Возвращает {warehouse, floor, row, cell} или null, если строка — не наш код ячейки
// (например, это был обычный штрихкод товара с полки).
function decodeCellCode(code) {
  const s = String(code == null ? '' : code).trim();
  if (!s.startsWith(CELL_PREFIX)) return null;
  const parts = s.slice(CELL_PREFIX.length).split(':');
  if (parts.length !== 4) return null;
  const [warehouse, floor, row, cell] = parts;
  if (!warehouse) return null;
  return {
    warehouse,
    floor: floor === '-' ? null : floor,
    row: row === '-' ? null : row,
    cell: cell === '-' ? null : cell
  };
}

function isCellCode(code) {
  return String(code == null ? '' : code).trim().startsWith(CELL_PREFIX);
}

module.exports = { encodeCellCode, decodeCellCode, isCellCode, CELL_PREFIX };
