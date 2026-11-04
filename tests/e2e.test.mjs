// Сквозная проверка без сети: локальный «ДТЭК» и локальный «Worker», настоящий Chromium.
// Запуск: npm run test:e2e (нужен установленный Chromium).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const mirror = JSON.parse(fs.readFileSync(new URL('./fixtures/odesa.json', import.meta.url), 'utf8'));
const script = new URL('../scripts/collect.mjs', import.meta.url).pathname;

function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

const pageGlobal = () => `<html><body><script>
  var DisconSchedule = {};
  DisconSchedule.fact = ${JSON.stringify(mirror.fact)};
  DisconSchedule.preset = ${JSON.stringify(mirror.preset)};
</script></body></html>`;

// const не попадает в window: проверяет запасной путь через разбор HTML
const pageConst = () => `<html><body><script>
  const DisconSchedule = {};
  DisconSchedule.fact = ${JSON.stringify(mirror.fact)};
  DisconSchedule.preset = ${JSON.stringify(mirror.preset)};
</script></body></html>`;

async function run({ dtek, workerStatus = 200, token = 'tok' }) {
  const received = [];
  const dt = await listen((req, res) => {
    if (dtek.status) {
      res.writeHead(dtek.status);
      return res.end('nope');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(dtek.html);
  });
  const wk = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || 'null') });
      res.writeHead(workerStatus, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      DTEK_URL: `http://127.0.0.1:${dt.port}/`,
      WORKER_URL: `http://127.0.0.1:${wk.port}`,
      INGEST_TOKEN: token,
      MAX_FETCH_RETRY: '2',
      FETCH_BACKOFF_MS: '50',
    },
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  const code = await new Promise((r) => child.on('close', r));
  dt.srv.close();
  wk.srv.close();
  return { code, out, received };
}

test('страница с window.DisconSchedule: данные уходят в Worker', { timeout: 90_000 }, async () => {
  const r = await run({ dtek: { html: pageGlobal() } });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.received.length, 1);
  assert.equal(r.received[0].url, '/ingest');
  assert.equal(r.received[0].auth, 'Bearer tok');
  assert.deepEqual(r.received[0].body.fact, mirror.fact);
  assert.deepEqual(r.received[0].body.preset, mirror.preset);
  assert.match(r.received[0].body.contentHash, /^[0-9a-f]{64}$/);
  assert.match(r.out, /источник=window/);
  assert.doesNotMatch(r.out, /tok\b.*Bearer|127\.0\.0\.1:\d+\/ingest/);
});

test('страница с const (нет в window): запасной разбор HTML', { timeout: 90_000 }, async () => {
  const r = await run({ dtek: { html: pageConst() } });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.received[0].body.fact, mirror.fact);
  assert.deepEqual(r.received[0].body.preset, mirror.preset);
  assert.match(r.out, /источник=html/);
});

test('заглушка вместо данных: отчёт об ошибке в Worker, код выхода 0', { timeout: 90_000 }, async () => {
  const r = await run({ dtek: { html: '<html><iframe src="/_Incapsula_Resource"></iframe></html>' } });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.received.length, 1);
  assert.equal(typeof r.received[0].body.error, 'string');
  assert.equal(r.received[0].body.fact, undefined);
});

test('ДТЭК отвечает 503: отчёт об ошибке', { timeout: 90_000 }, async () => {
  const r = await run({ dtek: { status: 503 } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.received[0].body.error, /503/);
});

test('Worker отверг токен (403): запуск красный, без повторов', { timeout: 90_000 }, async () => {
  const r = await run({ dtek: { html: pageGlobal() }, workerStatus: 403 });
  assert.equal(r.code, 1, r.out);
  assert.equal(r.received.length, 1);
  assert.doesNotMatch(r.out, /Bearer/);
});

test('без секретов: красный запуск', async () => {
  const child = spawn(process.execPath, [script], { env: { PATH: process.env.PATH } });
  const code = await new Promise((r) => child.on('close', r));
  assert.equal(code, 1);
});
