// Проверка доступности страницы ДТЭК из GitHub Actions. Ничего не сохраняет в репозиторий.
// Результат: сводка в логе, в Job Summary и HTML каждой попытки в outputs/ (артефакт на 3 дня).
//
// Env: PROBE_URL (по умолчанию страница графиков), PROBE_ATTEMPTS (5), PROBE_GAP_SEC (60)

import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const URL_TO_PROBE = process.env.PROBE_URL || 'https://www.dtek-oem.com.ua/ua/shutdowns';
const ATTEMPTS = Number(process.env.PROBE_ATTEMPTS || 5);
const GAP_MS = Number(process.env.PROBE_GAP_SEC || 60) * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function analyze(html) {
  return {
    bytes: html.length,
    hasFact: html.includes('DisconSchedule.fact'),
    hasPreset: html.includes('DisconSchedule.preset'),
    // Строка _Incapsula_Resource есть и на нормальной странице, поэтому считаем блокировкой только маленькую заглушку
    incapsula: html.length < 5000 && /_Incapsula_Resource|Incapsula incident|Request unsuccessful/i.test(html),
    title: (html.match(/<title[^>]*>([^<]{0,120})/i) || [])[1] || null,
  };
}

await fs.mkdir('outputs', { recursive: true });
const browser = await chromium.launch({ headless: true });
const rows = [];

for (let i = 1; i <= ATTEMPTS; i++) {
  // Новый контекст на каждую попытку: без общих кук, как отдельный визит
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    locale: 'uk-UA',
    timezoneId: 'Europe/Kyiv',
  });
  const page = await context.newPage();
  const t0 = Date.now();
  let status = null;
  let html = '';
  let error = null;
  try {
    const resp = await page.goto(URL_TO_PROBE, { waitUntil: 'networkidle', timeout: 120_000 });
    status = resp ? resp.status() : null;
    await page.waitForTimeout(500);
    html = await page.content();
  } catch (e) {
    error = String((e && e.message) || e).slice(0, 200);
  }
  const sec = Math.round((Date.now() - t0) / 100) / 10;
  const a = analyze(html);
  rows.push({ attempt: i, status, sec, error, ...a });
  await fs.writeFile(`outputs/attempt-${i}.html`, html || '<!-- empty -->');
  console.log(`[PROBE] #${i} http=${status} ${sec}s bytes=${a.bytes} fact=${a.hasFact} preset=${a.hasPreset} incapsula=${a.incapsula} err=${error || '-'}`);
  await page.close();
  await context.close();
  if (i < ATTEMPTS) await sleep(GAP_MS);
}
await browser.close();

const okCount = rows.filter((r) => r.hasFact && r.hasPreset).length;
const verdict = okCount === rows.length ? 'ПУСКАЕТ'
  : okCount === 0 ? 'НЕ ПУСКАЕТ'
  : `НЕСТАБИЛЬНО (${okCount} из ${rows.length})`;

const md = [
  `## ДТЭК из GitHub Actions: ${verdict}`,
  '',
  `URL: ${URL_TO_PROBE}`,
  '',
  '| # | HTTP | сек | байт | fact | preset | Incapsula | ошибка |',
  '|---|------|-----|------|------|--------|-----------|--------|',
  ...rows.map((r) => `| ${r.attempt} | ${r.status ?? '-'} | ${r.sec} | ${r.bytes} | ${r.hasFact} | ${r.hasPreset} | ${r.incapsula} | ${r.error || ''} |`),
  '',
].join('\n');
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, md);
// Код выхода 0 всегда: результат читается из сводки, а не из «красного» значка
