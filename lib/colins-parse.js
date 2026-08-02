// Разбор каталога Colin's (365trends.tj) — чистые функции без сети/БД,
// чтобы группировку и сортировку можно было протестировать отдельно от сервера.

// Порядок размеров одежды — числовые (обувь/брюки) сортируются по значению отдельно.
const CLOTHING_SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '4XL', '5XL'];

function sizeSortKey(size) {
  const s = String(size == null ? '' : size).trim().toUpperCase();
  const idx = CLOTHING_SIZE_ORDER.indexOf(s);
  if (idx >= 0) return [0, idx, s];
  const num = parseFloat(s);
  if (!Number.isNaN(num) && /^\d/.test(s)) return [1, num, s];
  return [2, 0, s];
}

// Сравнивает два размера для сортировки: сначала известные буквенные размеры по
// стандартному порядку, потом числовые по значению, потом всё остальное по алфавиту.
function compareSizes(a, b) {
  const [ta, na, sa] = sizeSortKey(a);
  const [tb, nb, sb] = sizeSortKey(b);
  if (ta !== tb) return ta - tb;
  if (na !== nb) return na - nb;
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

// Собирает плоский список товаров Colin's (как отдаёт /api/products/sidebar-filter)
// в модели -> цвета -> размеры. Дедуплицирует по article (при постраничной выгрузке
// возможны повторы, если список на сервере сдвинулся между запросами) — последняя
// встреченная запись побеждает. Возвращает только модели с остатком > 0.
function buildColinsCatalog(rawItems) {
  const byArticle = new Map();
  for (const it of rawItems || []) {
    if (it && it.article) byArticle.set(it.article, it);
  }

  const modelsByTitle = new Map();
  for (const it of byArticle.values()) {
    const title = it.title || it.article;
    let m = modelsByTitle.get(title);
    if (!m) { m = { model: title, stock: 0, colors: [] }; modelsByTitle.set(title, m); }

    for (const c of (it.colors || [])) {
      const sizes = (c.sizes || [])
        .map(s => ({ size: s.value, stock: Number(s.quantity) || 0 }))
        .filter(s => s.stock > 0)
        .sort((a, b) => compareSizes(a.size, b.size));
      const colorStock = sizes.reduce((s, x) => s + x.stock, 0);
      if (colorStock <= 0) continue; // цвет без остатка ни по одному размеру — не показываем
      const price = c.salePrice != null ? Number(c.salePrice) : (c.price != null ? Number(c.price) : null);
      const oldPrice = (c.price != null && c.salePrice != null && Number(c.price) !== Number(c.salePrice))
        ? Number(c.price) : null;

      m.colors.push({
        article: it.article,
        color: c.name || '',
        price, oldPrice,
        imageUrl: c.imageUrl || null,
        stock: colorStock,
        sizes
      });
      m.stock += colorStock;
    }
  }

  return [...modelsByTitle.values()]
    .filter(m => m.stock > 0)
    .sort((a, b) => b.stock - a.stock);
}

module.exports = { compareSizes, buildColinsCatalog, CLOTHING_SIZE_ORDER };
