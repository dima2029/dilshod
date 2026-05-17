const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// База данных
const db = new Database('warehouse.db');

// Создаём таблицу если нет
db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    article TEXT PRIMARY KEY,
    name TEXT,
    warehouse TEXT DEFAULT '1',
    floor TEXT,
    row TEXT,
    cell TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── API ──────────────────────────────────────

// Получить все товары
app.get('/api/items', (req, res) => {
  const items = db.prepare('SELECT * FROM items ORDER BY created_at DESC').all();
  res.json(items);
});

// Добавить товар
app.post('/api/items', (req, res) => {
  const { article, name, warehouse, floor, row, cell } = req.body;
  if (!article) return res.status(400).json({ error: 'Артикул обязателен' });

  try {
    db.prepare(`
      INSERT INTO items (article, name, warehouse, floor, row, cell)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(article.toUpperCase(), name || article, warehouse || '1', floor || null, row || null, cell || null);
    res.json({ success: true });
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      res.status(400).json({ error: 'Товар уже существует' });
    } else {
      res.status(500).json({ error: e.message });
    }
  }
});

// Обновить товар
app.patch('/api/items/:article', (req, res) => {
  const { article } = req.params;
  const fields = req.body;
  const keys = Object.keys(fields);
  if (!keys.length) return res.status(400).json({ error: 'Нет данных' });

  const set = keys.map(k => `${k} = ?`).join(', ');
  const vals = keys.map(k => fields[k]);
  db.prepare(`UPDATE items SET ${set} WHERE article = ?`).run(...vals, article);
  res.json({ success: true });
});

// Удалить товар
app.delete('/api/items/:article', (req, res) => {
  db.prepare('DELETE FROM items WHERE article = ?').run(req.params.article);
  res.json({ success: true });
});

// Удалить все
app.delete('/api/items', (req, res) => {
  db.prepare('DELETE FROM items').run();
  res.json({ success: true });
});

// Импорт массива товаров
app.post('/api/items/import', (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'Нет данных' });

  const insert = db.prepare(`
    INSERT OR IGNORE INTO items (article, name, warehouse, floor, row, cell)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let added = 0;
  const insertMany = db.transaction((list) => {
    for (const item of list) {
      const info = insert.run(
        item.article.toUpperCase(),
        item.name || item.article,
        '1', null, null, null
      );
      if (info.changes) added++;
    }
  });

  insertMany(items);
  res.json({ success: true, added, skipped: items.length - added });
});

app.listen(PORT, () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
});
