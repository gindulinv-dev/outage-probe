// Разбор данных графика. Ничего не исполняет: только JSON.parse.
// Запасной путь, если window.DisconSchedule недоступен: вырезать объект прямо из HTML.

export const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

// Вырезает JSON-литерал после «DisconSchedule.<key> =» с учётом скобок внутри строк.
export function extractObject(html, key) {
  const re = new RegExp(`DisconSchedule\\.${key}\\s*=\\s*`);
  const m = re.exec(html);
  if (!m) throw new Error(`в HTML нет «DisconSchedule.${key} =»`);
  let i = m.index + m[0].length;
  const open = html[i];
  if (open !== '{' && open !== '[') throw new Error(`после «DisconSchedule.${key} =» ожидалась { или [`);
  const start = i;
  let depth = 0;
  let quote = null;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        const text = html.slice(start, i + 1);
        try {
          return JSON.parse(text);
        } catch (e) {
          throw new Error(`«DisconSchedule.${key}» не является чистым JSON: ${e.message}`);
        }
      }
    }
  }
  throw new Error(`не закрыты скобки у «DisconSchedule.${key}»`);
}

export function extractFromHtml(html) {
  return { fact: extractObject(html, 'fact'), preset: extractObject(html, 'preset') };
}

// Проверка формы данных перед отправкой.
export function validateData(d) {
  if (!d || !isObj(d.fact) || !isObj(d.fact.data)) throw new Error('нет fact.data');
  if (!isObj(d.preset) || !isObj(d.preset.sch_names)) throw new Error('нет preset.sch_names');
  for (const k of Object.keys(d.fact.data)) {
    if (!/^\d{9,11}$/.test(k)) throw new Error(`странный ключ суток в fact.data: ${k.slice(0, 20)}`);
  }
  return d;
}

export function summarize(d) {
  const days = Object.keys(d.fact.data).sort();
  return {
    days: days.length,
    groupsToday: days.length ? Object.keys(d.fact.data[days[days.length - 1]] || {}).length : 0,
    update: d.fact.update ?? null,
    today: d.fact.today ?? null,
    schNames: Object.keys(d.preset.sch_names).length,
  };
}
