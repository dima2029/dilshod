const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeCellCode, decodeCellCode, isCellCode } = require('../lib/cell-qr');

test('encodeCellCode/decodeCellCode: круговой обход без потерь', () => {
  const cell = { warehouse: '2', floor: '2', row: '8', cell: 'Б' };
  const code = encodeCellCode(cell);
  assert.equal(code, 'CELL:2:2:8:Б');
  assert.deepEqual(decodeCellCode(code), cell);
});

test('decodeCellCode: обычный штрихкод товара (цифры) — не код ячейки', () => {
  assert.equal(decodeCellCode('4820022500048'), null);
  assert.equal(decodeCellCode(''), null);
  assert.equal(decodeCellCode('310197-CRL'), null);
});

test('isCellCode: отличает код ячейки от штрихкода товара', () => {
  assert.equal(isCellCode('CELL:1:1:1:А'), true);
  assert.equal(isCellCode('4820022500048'), false);
  assert.equal(isCellCode(''), false);
});

test('encodeCellCode: недостающие floor/row/cell кодируются как «-» и разбираются в null', () => {
  const code = encodeCellCode({ warehouse: '3' });
  assert.equal(code, 'CELL:3:-:-:-');
  assert.deepEqual(decodeCellCode(code), { warehouse: '3', floor: null, row: null, cell: null });
});
