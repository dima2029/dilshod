const test = require('node:test');
const assert = require('node:assert/strict');
const { compareSizes, buildColinsCatalog } = require('../lib/colins-parse');

test('compareSizes: буквенные размеры одежды идут по стандартному порядку', () => {
  const sizes = ['L', 'XS', 'M', 'S', 'XL'];
  assert.deepEqual([...sizes].sort(compareSizes), ['XS', 'S', 'M', 'L', 'XL']);
});

test('compareSizes: числовые размеры сортируются по значению, а не по алфавиту', () => {
  const sizes = ['10', '2', '30', '4'];
  assert.deepEqual([...sizes].sort(compareSizes), ['2', '4', '10', '30']);
});

test('compareSizes: буквенные размеры идут раньше числовых и неизвестных', () => {
  const sizes = ['42', 'M', 'ONE SIZE', 'S'];
  assert.deepEqual([...sizes].sort(compareSizes), ['S', 'M', '42', 'ONE SIZE']);
});

test('buildColinsCatalog: группирует по title (модель) -> colors -> sizes с остатком > 0', () => {
  const items = [
    {
      article: 'CL1', title: 'Женская юбка Colin\'s',
      colors: [{ name: 'WHT', price: '339.9', salePrice: '339.9', imageUrl: 'a.png', sizes: [
        { value: 'S', quantity: 2 }, { value: 'M', quantity: 0 }, { value: 'L', quantity: 4 }
      ] }]
    },
    {
      article: 'CL2', title: 'Женская юбка Colin\'s',
      colors: [{ name: 'BLK', price: '349.9', salePrice: '299.9', imageUrl: 'b.png', sizes: [
        { value: 'XS', quantity: 1 }
      ] }]
    }
  ];
  const rows = buildColinsCatalog(items);
  assert.equal(rows.length, 1);
  const model = rows[0];
  assert.equal(model.model, 'Женская юбка Colin\'s');
  assert.equal(model.colors.length, 2);
  assert.equal(model.stock, 2 + 4 + 1); // M=0 отфильтрован

  const white = model.colors.find(c => c.color === 'WHT');
  assert.equal(white.stock, 6);
  assert.deepEqual(white.sizes.map(s => s.size), ['S', 'L']); // M с нулём убран, порядок S затем L
  assert.equal(white.price, 339.9);
  assert.equal(white.oldPrice, null); // цена и скидка равны — нет старой цены

  const black = model.colors.find(c => c.color === 'BLK');
  assert.equal(black.price, 299.9);
  assert.equal(black.oldPrice, 349.9); // цена и скидка разные — есть старая цена
});

test('buildColinsCatalog: дедуплицирует по article при повторе (сдвиг страниц при пагинации)', () => {
  const dup = {
    article: 'CL1', title: 'Шорты Colin\'s',
    colors: [{ name: 'BLK', price: '199.9', salePrice: '199.9', sizes: [{ value: 'M', quantity: 3 }] }]
  };
  const rows = buildColinsCatalog([dup, { ...dup }, { ...dup }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].colors.length, 1);
  assert.equal(rows[0].stock, 3); // не утроилось
});

test('buildColinsCatalog: товар с остатком 0 по всем размерам не попадает в каталог', () => {
  const items = [{
    article: 'CL1', title: 'Пусто',
    colors: [{ name: 'BLK', price: '100', salePrice: '100', sizes: [{ value: 'M', quantity: 0 }] }]
  }];
  assert.deepEqual(buildColinsCatalog(items), []);
});

test('buildColinsCatalog: цвет без остатка ни по одному размеру скрыт, даже если у модели есть другой цвет с остатком', () => {
  const items = [
    {
      article: 'CL1', title: 'Кофта',
      colors: [{ name: 'BLK', price: '100', salePrice: '100', sizes: [{ value: 'M', quantity: 5 }] }]
    },
    {
      article: 'CL2', title: 'Кофта', // тот же title -> та же модель
      colors: [{ name: 'WHT', price: '100', salePrice: '100', sizes: [{ value: 'M', quantity: 0 }, { value: 'L', quantity: 0 }] }]
    }
  ];
  const rows = buildColinsCatalog(items);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stock, 5);
  assert.equal(rows[0].colors.length, 1);
  assert.equal(rows[0].colors[0].color, 'BLK');
});

test('buildColinsCatalog: пустой вход даёт пустой каталог', () => {
  assert.deepEqual(buildColinsCatalog([]), []);
  assert.deepEqual(buildColinsCatalog(undefined), []);
});
