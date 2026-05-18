const express = require('express');
const { MongoClient } = require('mongodb');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const MONGO_URL = process.env.MONGO_URL;
const DB_NAME = 'skechers';

let db;

async function connectDB() {
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  db = client.db(DB_NAME).collection('items');
  console.log('✅ MongoDB подключена');
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Получить все товары
app.get('/api/items', async (req, res) => {
  const items = await db.find({}).toArray();
  res.json(items);
});

// Добавить товар
app.post('/api/items', async (req, res) => {
  const { article, name, warehouse, floor, row, cell } = req.body;
  if (!article) return res.status(400).json({ error: 'Артикул обязателен' });

  const key = article.toUpperCase();
  const exists = await db.findOne({ article: key });
  if (exists) return res.status(400).json({ error: 'Товар уже существует' });

  await db.insertOne({
    article: key,
    name: name || key,
    warehouse: warehouse || '1',
    floor: floor || null,
    row: row || null,
    cell: cell || null,
    created_at: new Date().toISOString()
  });
  res.json({ success: true });
});

// Обновить товар
app.patch('/api/items/:article', async (req, res) => {
  await db.updateOne({ article: req.params.article }, { $set: req.body });
  res.json({ success: true });
});

// Удалить товар
app.delete('/api/items/:article', async (req, res) => {
  await db.deleteOne({ article: req.params.article });
  res.json({ success: true });
});

// Удалить все
app.delete('/api/items', async (req, res) => {
  await db.deleteMany({});
  res.json({ success: true });
});

// Импорт
app.post('/api/items/import', async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'Нет данных' });

  let added = 0;
  for (const item of items) {
    const key = item.article.toUpperCase();
    const exists = await db.findOne({ article: key });
    if (!exists) {
      await db.insertOne({
        article: key,
        name: item.name || key,
        warehouse: '1',
        floor: null,
        row: null,
        cell: null,
        created_at: new Date().toISOString()
      });
      added++;
    }
  }

  res.json({ success: true, added, skipped: items.length - added });
});

connectDB().then(() => {
  app.listen(PORT, () => console.log(`✅ Сервер запущен на порту ${PORT}`));
});
