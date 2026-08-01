// Приводит карточку товара из закрытой админки 365trends.tj (Dashboard-Products API,
// GET /api/dashboard/products/{id}) к тому же плоскому виду, что и публичный
// sidebar-filter (article, title, colors[].{name,price,salePrice,imageUrl,sizes[].{value,quantity}}),
// чтобы дальше использовать один и тот же buildColinsCatalog из lib/colins-parse.js
// независимо от источника данных.
function mapDashboardProductToRawItem(p) {
  return {
    article: p.article,
    title: p.title,
    colors: (p.colors || []).map(c => ({
      name: c.name,
      price: c.price,
      salePrice: c.salePrice,
      imageUrl: c.imageUrl,
      sizes: (c.sizes || []).map(s => ({ value: s.value, quantity: s.quantity }))
    }))
  };
}

module.exports = { mapDashboardProductToRawItem };
