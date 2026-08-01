const test = require('node:test');
const assert = require('node:assert/strict');
const { mapDashboardProductToRawItem } = require('../lib/colins-dashboard');
const { buildColinsCatalog } = require('../lib/colins-parse');

test('mapDashboardProductToRawItem: приводит карточку из Dashboard-Products к виду sidebar-filter', () => {
  const dashboardProduct = {
    id: 'e4671670-6244-434e-b73c-6cbafdd755e6',
    article: 'cl1069983',
    title: 'Брюки cl1069983',
    active: false,
    colors: [
      {
        id: '2d7801ca-61b1-4d16-8ca2-0b332a0da143',
        name: 'DN00214',
        active: false,
        price: '699.9',
        salePrice: '629.91',
        imageUrl: null,
        sizes: [
          { id: 's1', value: '25-30', quantity: 0 },
          { id: 's2', value: '26-30', quantity: 3 }
        ],
        galleries: []
      }
    ]
  };
  const raw = mapDashboardProductToRawItem(dashboardProduct);
  assert.equal(raw.article, 'cl1069983');
  assert.equal(raw.title, 'Брюки cl1069983');
  assert.equal(raw.colors.length, 1);
  assert.deepEqual(raw.colors[0], {
    name: 'DN00214', price: '699.9', salePrice: '629.91', imageUrl: null,
    sizes: [{ value: '25-30', quantity: 0 }, { value: '26-30', quantity: 3 }]
  });
});

test('mapDashboardProductToRawItem: результат совместим с buildColinsCatalog (полная цепочка)', () => {
  const products = [
    {
      article: 'cl001', title: 'Модель A',
      colors: [{ name: 'BLK', price: '100', salePrice: '90', imageUrl: null, sizes: [{ value: 'M', quantity: 5 }] }]
    },
    {
      article: 'cl002', title: 'Модель A', // тот же title -> та же модель в каталоге
      colors: [{ name: 'WHT', price: '100', salePrice: '100', imageUrl: null, sizes: [{ value: 'M', quantity: 0 }] }]
    }
  ];
  const catalog = buildColinsCatalog(products.map(mapDashboardProductToRawItem));
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].model, 'Модель A');
  assert.equal(catalog[0].stock, 5);
  // buildColinsCatalog оставляет оба цвета модели, но обнуляет размеры без остатка
  assert.equal(catalog[0].colors.length, 2);
  assert.equal(catalog[0].colors[0].article, 'cl001');
  assert.equal(catalog[0].colors[0].stock, 5);
  assert.equal(catalog[0].colors[1].article, 'cl002');
  assert.equal(catalog[0].colors[1].stock, 0);
});
