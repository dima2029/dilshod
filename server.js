const express = require('express');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');
 
const app = express();
const PORT = process.env.PORT || 3000;
 
// База данных (JSON файл)
const adapter = new FileSync('db.json');
const db = low(adapter);
 
// Начальные данные
db.defaults({ items: [] }).write();
 
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
 
// ── API ──────────────────────────────────────
 
// Получить все товары
app.get('/api/items', (req, res) => {
  const items = db.get('items').value();
  res.json(items);
});
 
// Добавить товар
app.post('/api/items', (req, res) => {
  const { article, name, warehouse, floor, row, cell } = req.body;
  if (!article) return res.status(400).json({ error: 'Артикул обязателен' });
 
  const key = article.toUpperCase();
  const exists = db.get('items').find({ article: key }).value();
  if (exists) return res.status(400).json({ error: 'Товар уже существует' });
 
  const item = {
    article: key,
    name: name || key,
    warehouse: warehouse || '1',
    floor: floor || null,
    row: row || null,
    cell: cell || null,
    created_at: new Date().toISOString()
  };
 
  db.get('items').push(item).write();
  res.json({ success: true });
});
 
// Обновить товар
app.patch('/api/items/:article', (req, res) => {
  const { article } = req.params;
  const fields = req.body;
  db.get('items').find({ article }).assign(fields).write();
  res.json({ success: true });
});
 
// Удалить товар
app.delete('/api/items/:article', (req, res) => {
  db.get('items').remove({ article: req.params.article }).write();
  res.json({ success: true });
});
 
// Удалить все
app.delete('/api/items', (req, res) => {
  db.set('items', []).write();
  res.json({ success: true });
});
 
// Импорт массива товаров
app.post('/api/items/import', (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'Нет данных' });
 
  let added = 0;
  items.forEach(item => {
    const key = item.article.toUpperCase();
    const exists = db.get('items').find({ article: key }).value();
    if (!exists) {
      db.get('items').push({
        article: key,
        name: item.name || key,
        warehouse: '1',
        floor: null,
        row: null,
        cell: null,
        created_at: new Date().toISOString()
      }).write();
      added++;
    }
  });
 
  res.json({ success: true, added, skipped: items.length - added });
});
 
app.listen(PORT, () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
});
 
