// Сборщик: открывает страницу ДТЭК браузером, достаёт fact и preset, шлёт в Worker (/ingest).
//
// Env (секреты репозитория): WORKER_URL, INGEST_TOKEN
// Env (необязательно): DTEK_URL, MAX_FETCH_RETRY (3), FETCH_BACKOFF_MS (3000)
//
// Код выхода: 0, если Worker данные или отчёт об ошибке принял (алерты шлёт сам Worker);
// 1, если Worker недоступен или отверг запрос: это сбой настройки, он должен быть виден как «красный» запуск.
// Секреты и адрес Worker в лог не печатаются: репозиторий публичный, логи тоже.

import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { extractFromHtml, validateData, summarize } from './lib/extract.mjs';

const DTEK_URL = process.env.DTEK_URL || 'https://www.dtek-oem.com.ua/ua/shutdowns';
const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/+$/, '');
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';
const MAX_RETRY = Number(process.env.MAX_FETCH_RETRY || 3);
const BACKOFF_MS = Number(process.env.FETCH_BACKOFF_MS || 3000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!WORKER_URL || !INGEST_TOKEN) {
  console.error('[ERROR] не заданы секреты WORKER_URL и/или INGEST_TOKEN');
  process.exit(1);
}

async function readFromPage(page) {
  // 1) Из самого браузера: страница сама исполняет свой JS, мы получаем готовый объект.
  let viaBrowser = null;
  try {
    viaBrowser = await page.evaluate(() => {
      const d = window.DisconSchedule;
      if (!d || !d.fact || !d.preset) return null;
      return JSON.parse(JSON.stringify({ fact: d.fact, preset: d.preset }));
    });
  } catch {
    viaBrowser = null;
  }
  if (viaBrowser) {
    try {
      return { data: validateData(viaBrowser), via: 'window' };
    } catch {
      // пробуем запасной путь
    }
  }
  // 2) Запасной путь: вырезать JSON из HTML (без eval).
  const html = await page.content();
  return { data: validateData(extractFromHtml(html)), via: 'html', bytes: html.length };
}

async function collectOnce(browser) {
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    locale: 'uk-UA',
    timezoneId: 'Europe/Kyiv',
  });
  const page = await context.newPage();
  try {
    const resp = await page.goto(DTEK_URL, { waitUntil: 'networkidle', timeout: 120_000 });
    await page.waitForTimeout(500);
    const status = resp ? resp.status() : null;
    if (status && status >= 400) throw new Error(`ДТЭК ответил HTTP ${status}`);
    return await readFromPage(page);
  } finally {
    await page.close();
    await context.close();
  }
}

async function collectWithRetry() {
  const browser = await chromium.launch({ headless: true });
  let lastErr = null;
  try {
    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
      try {
        const res = await collectOnce(browser);
        console.log(`[OK] попытка ${attempt}/${MAX_RETRY}, источник=${res.via}, ${JSON.stringify(summarize(res.data))}`);
        return res.data;
      } catch (e) {
        lastErr = e;
        console.warn(`[WARN] попытка ${attempt}/${MAX_RETRY}: ${String((e && e.message) || e).slice(0, 200)}`);
        if (attempt < MAX_RETRY) await sleep(BACKOFF_MS * attempt + Math.floor(Math.random() * 500));
      }
    }
  } finally {
    await browser.close();
  }
  throw lastErr || new Error('неизвестная ошибка сборщика');
}

async function post(body) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${WORKER_URL}/ingest`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${INGEST_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      const text = (await res.text()).slice(0, 200);
      if (res.ok) return { status: res.status, text };
      if (res.status >= 400 && res.status < 500) {
        // 403/413/422: повторять бессмысленно
        throw Object.assign(new Error(`Worker ответил HTTP ${res.status}: ${text}`), { fatal: true });
      }
      lastErr = new Error(`Worker ответил HTTP ${res.status}`);
    } catch (e) {
      if (e && e.fatal) throw e;
      lastErr = e;
    }
    if (attempt < 3) await sleep(2000 * attempt);
  }
  throw lastErr;
}

let data = null;
let collectError = null;
try {
  data = await collectWithRetry();
} catch (e) {
  collectError = String((e && e.message) || e).slice(0, 250);
}

try {
  if (data) {
    const contentHash = crypto.createHash('sha256').update(JSON.stringify({ fact: data.fact, preset: data.preset })).digest('hex');
    const r = await post({ fact: data.fact, preset: data.preset, contentHash });
    console.log(`[OK] Worker принял данные: HTTP ${r.status}`);
  } else {
    console.error(`[FAIL] не удалось получить данные ДТЭК: ${collectError}`);
    const r = await post({ error: collectError });
    console.log(`[OK] Worker принял отчёт об ошибке: HTTP ${r.status}`);
  }
} catch (e) {
  console.error(`[ERROR] не удалось связаться с Worker: ${String((e && e.message) || e).slice(0, 250)}`);
  process.exit(1);
}
