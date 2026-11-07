/**
 * Работа с датами в заданном часовом поясе без внешних зависимостей.
 *
 * Внутри всё хранится как календарная дата 'YYYY-MM-DD' (без времени) либо
 * как календарная дата + время 'HH:MM'. Перевод в реальный момент времени
 * (для планировщика) делается через Intl — это учитывает переход на летнее
 * время в тех зонах, где оно есть.
 */

const dtfCache = new Map();

function dtf(timeZone) {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}

/** Разбирает момент времени на календарные части в нужной зоне. */
export function zonedParts(date, timeZone) {
  const parts = {};
  for (const p of dtf(timeZone).formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: isoWeekdayFromISO(`${parts.year}-${parts.month}-${parts.day}`),
  };
}

/** 'YYYY-MM-DD' + 'HH:MM' в зоне timeZone -> реальный момент (Date, UTC). */
export function zonedTimeToUtc(dateISO, timeHM, timeZone) {
  const [hh, mm] = timeHM.split(':').map(Number);
  const targetUTC = Date.UTC(
    Number(dateISO.slice(0, 4)),
    Number(dateISO.slice(5, 7)) - 1,
    Number(dateISO.slice(8, 10)),
    hh,
    mm,
  );
  // Смещение зоны считаем как «настенное время минус UTC», затем вычитаем его.
  let ms = targetUTC;
  for (let i = 0; i < 4; i += 1) {
    const p = zonedParts(new Date(ms), timeZone);
    const wallAsUTC = Date.UTC(
      Number(p.date.slice(0, 4)),
      Number(p.date.slice(5, 7)) - 1,
      Number(p.date.slice(8, 10)),
      p.hour,
      p.minute,
      p.second,
    );
    const offset = wallAsUTC - ms;
    const next = targetUTC - offset;
    if (next === ms) break;
    ms = next;
  }
  return new Date(ms);
}

export function nowISO(tz) {
  return zonedParts(new Date(), tz).date;
}

export function nowTime(tz) {
  return zonedParts(new Date(), tz).time;
}

/** Календарная арифметика над 'YYYY-MM-DD'. */
export function addDays(dateISO, days) {
  const ms = Date.parse(`${dateISO}T00:00:00Z`) + days * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

export function addMonths(dateISO, months) {
  const y = Number(dateISO.slice(0, 4));
  const m = Number(dateISO.slice(5, 7));
  const d = Number(dateISO.slice(8, 10));
  const base = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 1 = понедельник ... 7 = воскресенье */
export function isoWeekdayFromISO(dateISO) {
  const d = new Date(`${dateISO}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

export function diffDays(fromISO, toISO) {
  return Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / 86400000);
}

export function startOfWeekISO(dateISO) {
  return addDays(dateISO, -(isoWeekdayFromISO(dateISO) - 1));
}

export function endOfMonthISO(dateISO) {
  const y = Number(dateISO.slice(0, 4));
  const m = Number(dateISO.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${dateISO.slice(0, 7)}-${String(last).padStart(2, '0')}`;
}

export function isValidISODate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s ?? '')) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function isValidHM(s) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s ?? '');
}

const WEEKDAY_RU = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
const WEEKDAY_RU_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const MONTH_RU_GEN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

export function weekdayName(iso, short = false) {
  const i = isoWeekdayFromISO(iso) - 1;
  return short ? WEEKDAY_RU_SHORT[i] : WEEKDAY_RU[i];
}

/** '2026-11-06' -> 'пт, 06.11.2026' */
export function humanDate(iso, { withWeekday = true } = {}) {
  if (!isValidISODate(iso)) return '—';
  const [y, m, d] = iso.split('-');
  const base = `${d}.${m}.${y}`;
  return withWeekday ? `${weekdayName(iso, true)}, ${base}` : base;
}

/** '2026-11-06' -> '6 ноября' */
export function humanDateLong(iso) {
  if (!isValidISODate(iso)) return '—';
  const [, m, d] = iso.split('-');
  return `${Number(d)} ${MONTH_RU_GEN[Number(m) - 1]}`;
}

export { MONTH_RU_GEN, WEEKDAY_RU, WEEKDAY_RU_SHORT };

/** Убирает шум из пользовательского ввода, сохраняя длину строки. */
export function normalizeText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/[“”„«»]/g, '"')
    .trim();
}
