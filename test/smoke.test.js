// Дымовые тесты: ловят ровно те ошибки, которые раньше приходилось проверять
// вручную перед каждым деплоем (синтаксис server.js и инлайн-скрипта на сайте).
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

test('server.js — валидный синтаксис', () => {
  assert.doesNotThrow(() => {
    execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')]);
  });
});

test('public/index.html — инлайн-скрипт без синтаксических ошибок', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .filter(m => !/\ssrc=/.test(m[1] || ''))
    .map(m => m[2])
    .filter(code => code.trim());

  assert.ok(scripts.length > 0, 'ожидался хотя бы один инлайн-скрипт в index.html');
  for (const code of scripts) {
    assert.doesNotThrow(() => new Function(code), 'инлайн-скрипт должен парситься без синтаксических ошибок');
  }
});

test('lib/moysklad-parse.js — валидный синтаксис', () => {
  assert.doesNotThrow(() => {
    execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'lib', 'moysklad-parse.js')]);
  });
});
