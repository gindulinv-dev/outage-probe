import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractObject, extractFromHtml, validateData, summarize } from '../scripts/lib/extract.mjs';

const mirror = JSON.parse(fs.readFileSync(new URL('./fixtures/odesa.json', import.meta.url), 'utf8'));
const page = (fact, preset) =>
  `<html><script>var DisconSchedule = {}; DisconSchedule.fact = ${JSON.stringify(fact)};\nDisconSchedule.preset = ${JSON.stringify(preset)};</script></html>`;

test('извлекает fact и preset из HTML и они совпадают с исходными', () => {
  const got = extractFromHtml(page(mirror.fact, mirror.preset));
  assert.deepEqual(got.fact, mirror.fact);
  assert.deepEqual(got.preset, mirror.preset);
});

test('скобки и кавычки внутри строк не ломают вырезание', () => {
  const fact = { data: { 1793743200: {} }, update: 'a } b ] c " d \\ e { [', today: 1793743200 };
  const got = extractObject(page(fact, { sch_names: {} }), 'fact');
  assert.deepEqual(got, fact);
});

test('нет маркера: понятная ошибка', () => {
  assert.throws(() => extractObject('<html>пусто</html>', 'fact'), /нет «DisconSchedule.fact =»/);
});

test('JS-литерал вместо JSON не исполняется, а отвергается', () => {
  const html = "<script>DisconSchedule.fact = {data: {}, update: 'x'};</script>";
  assert.throws(() => extractObject(html, 'fact'), /не является чистым JSON/);
});

test('исполняемый код в значении не выполняется', () => {
  globalThis.__pwned = false;
  const html = '<script>DisconSchedule.fact = {"data": {}, "x": (globalThis.__pwned = true)};</script>';
  assert.throws(() => extractObject(html, 'fact'));
  assert.equal(globalThis.__pwned, false);
});

test('незакрытые скобки', () => {
  assert.throws(() => extractObject('DisconSchedule.fact = {"data": {', 'fact'), /не закрыты скобки/);
});

test('validateData: настоящие данные проходят, мусор нет', () => {
  assert.doesNotThrow(() => validateData({ fact: mirror.fact, preset: mirror.preset }));
  assert.throws(() => validateData(null));
  assert.throws(() => validateData({ fact: { data: [] }, preset: mirror.preset }), /fact\.data/);
  assert.throws(() => validateData({ fact: mirror.fact, preset: {} }), /sch_names/);
  assert.throws(() => validateData({ fact: { data: { abc: {} } }, preset: mirror.preset }), /странный ключ/);
});

test('summarize на настоящих данных', () => {
  const s = summarize({ fact: mirror.fact, preset: mirror.preset });
  assert.equal(s.days >= 1, true);
  assert.equal(s.groupsToday, 12);
  assert.equal(s.schNames, 12);
  assert.equal(s.today, 1793743200);
});
