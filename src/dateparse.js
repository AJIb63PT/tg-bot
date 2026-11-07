/**
 * Разбор сроков из свободного русского текста.
 * Возвращает календарную дату 'YYYY-MM-DD' (+ время 'HH:MM'), без внешних библиотек.
 */

import {
  addDays, addMonths, diffDays, endOfMonthISO, isValidISODate,
  isoWeekdayFromISO, startOfWeekISO, weekdayName,
} from './util.js';

const L = '\\p{L}';
const b = (word) => new RegExp(`(?<!${L})(?:${word})(?!${L})`, 'iu');

const WEEKDAYS = [
  { n: 1, re: /(?<![\p{L}])понед\p{L}*(?![\p{L}])|(?<![\p{L}])пн(?![\p{L}])/iu },
  { n: 2, re: /(?<![\p{L}])вторн\p{L}*(?![\p{L}])|(?<![\p{L}])вт(?![\p{L}])/iu },
  { n: 3, re: /(?<![\p{L}])сред\p{L}*(?![\p{L}])|(?<![\p{L}])ср(?![\p{L}])/iu },
  { n: 4, re: /(?<![\p{L}])четвер\p{L}*(?![\p{L}])|(?<![\p{L}])чт(?![\p{L}])/iu },
  { n: 5, re: /(?<![\p{L}])пятниц\p{L}*(?![\p{L}])|(?<![\p{L}])пт(?![\p{L}])|(?<![\p{L}])пятн(?![\p{L}])/iu },
  { n: 6, re: /(?<![\p{L}])суббот\p{L}*(?![\p{L}])|(?<![\p{L}])сб(?![\p{L}])/iu },
  { n: 7, re: /(?<![\p{L}])воскрес\p{L}*(?![\p{L}])|(?<![\p{L}])вс(?![\p{L}])/iu },
];

const MONTHS = [
  { n: 1, re: /янв\p{L}*/iu },
  { n: 2, re: /фев\p{L}*/iu },
  { n: 3, re: /мар\p{L}*/iu },
  { n: 4, re: /апр\p{L}*/iu },
  { n: 5, re: /ма[йя]\p{L}*/iu },
  { n: 6, re: /июн\p{L}*/iu },
  { n: 7, re: /июл\p{L}*/iu },
  { n: 8, re: /авг\p{L}*/iu },
  { n: 9, re: /сен\p{L}*/iu },
  { n: 10, re: /окт\p{L}*/iu },
  { n: 11, re: /ноя\p{L}*/iu },
  { n: 12, re: /дек\p{L}*/iu },
];

const MONTH_WORDS = 'янв\\p{L}*|фев\\p{L}*|мар\\p{L}*|апр\\p{L}*|ма[йя]\\p{L}*|июн\\p{L}*|июл\\p{L}*|авг\\p{L}*|сен\\p{L}*|окт\\p{L}*|ноя\\p{L}*|дек\\p{L}*';

/** «7 ноября», «7 ноября 2026», «7-го ноября» */
const DAY_RE = new RegExp(
  `(?<!${L})(\\d{1,2})\\s*(?:-?\\p{L}{0,2})?\\s+(${MONTH_WORDS})(?:\\s+(\\d{4})(?!\\d))?`,
  'iu',
);

function monthFromWord(word) {
  for (const m of MONTHS) if (m.re.test(word)) return m.n;
  return null;
}

/** 'YYYY-MM-DD' + время -> { date, time } */
function fixYear(day, month, today) {
  const date = `${today.slice(0, 4)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (!isValidISODate(date)) return null;
  // Если дата сильно в прошлом — вероятно, имелся в виду следующий год.
  if (diffDays(today, date) < -180) {
    const next = `${Number(today.slice(0, 4)) + 1}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return isValidISODate(next) ? next : date;
  }
  return date;
}

function parseTime(text) {
  // 14:30 / 9:05
  let m = /(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/u.exec(text);
  if (m) return { time: `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`, match: m[0] };

  // «в 9 утра», «к 18:00 часам», «в 7 вечера»
  m = /(?<![\p{L}])(?:в|к|на)\s+([01]?\d|2[0-3])\s*(?:час\p{L}*|ч\.?)?\s*(утра|вечера|дня|ночи)?/iu.exec(text);
  if (m && (m[2] || /час|ч\./iu.test(m[0]))) {
    let h = Number(m[1]);
    const part = (m[2] ?? '').toLowerCase();
    if (part === 'вечера' && h < 12) h += 12;
    if (part === 'дня' && h < 12 && h !== 12) h += 12;
    if (part === 'ночи' && h === 12) h = 0;
    return { time: `${String(h).padStart(2, '0')}:00`, match: m[0] };
  }
  return { time: null, match: null };
}

/**
 * @param {string} text
 * @param {{today: string}} ctx  today в формате 'YYYY-MM-DD' в нужной зоне
 * @returns {{date: string|null, time: string|null, match: string|null, label: string|null}}
 */
export function parseDate(text, { today }) {
  const src = String(text ?? '').trim();
  if (!src) return { date: null, time: null, match: null, label: null };
  const lower = src.toLowerCase();

  const none = b('без\\s+срока|не\\s+срочно|когда-нибудь|нет\\s+срока|б/с').exec(lower);
  if (none) return { date: null, time: null, match: none[0], label: null };

  const timeInfo = parseTime(src);
  const withTime = (date, match, label) => ({
    date,
    time: timeInfo.time,
    match: [match, timeInfo.match].filter(Boolean).join(' ').trim() || null,
    label,
  });

  // --- ISO 2026-11-07 -------------------------------------------------------
  let m = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/u.exec(src);
  if (m && isValidISODate(m[0])) return withTime(m[0], m[0], m[0]);

  // --- 07.11.2026 / 07.11.26 / 07/11 / 7-11 --------------------------------
  m = /(?<!\d)(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?(?!\d)/u.exec(src);
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      let year = m[3] ? Number(m[3]) : null;
      if (year !== null && year < 100) year += 2000;
      let date;
      if (year) {
        date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (!isValidISODate(date)) date = null;
      } else {
        date = fixYear(day, month, today);
      }
      if (date) return withTime(date, date, m[0]);
    }
  }

  // --- 7 ноября [2026] ------------------------------------------------------
  m = DAY_RE.exec(src);
  if (m) {
    const day = Number(m[1]);
    const month = monthFromWord(m[2]);
    const year = m[3] ? Number(m[3]) : null;
    if (month && day >= 1 && day <= 31) {
      const date = year
        ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
        : fixYear(day, month, today);
      if (isValidISODate(date)) return withTime(date, m[0], m[0].trim());
    }
  }

  // --- сегодня / завтра / послезавтра / вчера ------------------------------
  const rel = [
    [/послезавтра/u, 2, 'послезавтра'],
    [/завтра/u, 1, 'завтра'],
    [/сегодня|нынче|севодня/u, 0, 'сегодня'],
    [/вчера/u, -1, 'вчера'],
  ];
  for (const [re, delta, label] of rel) {
    const mm = re.exec(lower);
    if (mm) return withTime(addDays(today, delta), mm[0], label);
  }

  // --- через 3 дня / через 2 недели / через месяц --------------------------
  m = /через\s+(\d{1,3})?\s*(д\p{L}*|недел\p{L}*|месяц\p{L}*|год\p{L}*)/iu.exec(lower);
  if (m) {
    const qty = m[1] ? Number(m[1]) : 1;
    const unit = m[2].toLowerCase();
    let date;
    if (unit.startsWith('д')) date = addDays(today, qty);
    else if (unit.startsWith('недел')) date = addDays(today, qty * 7);
    else if (unit.startsWith('месяц')) date = addMonths(today, qty);
    else date = addMonths(today, qty * 12);
    return withTime(date, m[0], 'через ' + qty + ' ' + unit);
  }

  // --- конец недели / месяца, начало, середина ----------------------------
  const period = /(начал\p{L}*|середин\p{L}*|конец|конц\p{L}*|к\s+концу|до\s+конца|в\s+конце)\s*(?:этой\s+|текущей\s+|следующей\s+)?(недел\p{L}*|месяц\p{L}*)/iu.exec(lower);
  if (period) {
    const [, posRaw, unit] = period;
    const pos = posRaw.toLowerCase();
    const nextWeek = /следующ/u.test(period[0]);
    let date;
    if (unit.toLowerCase().startsWith('недел')) {
      const weekStart = addDays(startOfWeekISO(today), nextWeek ? 7 : 0);
      if (pos.startsWith('начал')) date = weekStart;
      else if (pos.startsWith('середин')) date = addDays(weekStart, 3);
      else date = addDays(weekStart, 6);
    } else {
      const monthBase = nextWeek ? addMonths(today, 1) : today;
      if (pos.startsWith('начал')) date = `${monthBase.slice(0, 7)}-01`;
      else if (pos.startsWith('середин')) date = `${monthBase.slice(0, 7)}-15`;
      else date = endOfMonthISO(monthBase);
    }
    return withTime(date, period[0], period[0].trim());
  }

  // --- этой/на этой неделе, в течение недели, до конца недели -------------
  m = /(?:на\s+)?(?:этой|текущей|следующей)\s+неделе|в\s+течение\s+недел\p{L}*|на\s+неделе|до\s+конца\s+недели/iu.exec(lower);
  if (m) {
    const nextWeek = /следующ/u.test(m[0]);
    const weekStart = addDays(startOfWeekISO(today), nextWeek ? 7 : 0);
    return withTime(addDays(weekStart, 6), m[0], m[0].trim());
  }

  // --- срочно / ASAP -------------------------------------------------------
  m = b('срочно|асап|asap|немедленно|прямо\\s+сейчас').exec(lower);
  if (m) return withTime(today, m[0], 'срочно → сегодня');

  // --- день недели ---------------------------------------------------------
  const nextWeekHint = /следующ|на\s+следующей/iu.test(lower);
  const thisWeekHint = /этой|текущей|в\s+эту/iu.test(lower);
  for (const wd of WEEKDAYS) {
    const mm = wd.re.exec(lower);
    if (!mm) continue;
    const todayWd = isoWeekdayFromISO(today);
    let delta = wd.n - todayWd;
    if (nextWeekHint) {
      if (delta <= 0) delta += 7;
    } else if (thisWeekHint) {
      if (delta < 0) delta += 7;
    } else if (delta < 0) {
      delta += 7;
    }
    return withTime(addDays(today, delta), mm[0], weekdayName(addDays(today, delta)));
  }

  // --- только число месяца: «до 15», «к 20-му» -----------------------------
  m = /(?:до|к|на)\s+(\d{1,2})(?:-?(?:е|го|му|ое))?(?!\d|[:.]\d)/u.exec(lower);
  if (m) {
    const day = Number(m[1]);
    if (day >= 1 && day <= 31) {
      const month = Number(today.slice(5, 7));
      let date = fixYear(day, month, today);
      if (date && diffDays(today, date) < 0) date = addMonths(date, 1);
      if (isValidISODate(date)) return withTime(date, m[0], m[0].trim());
    }
  }

  return { date: null, time: timeInfo.time, match: timeInfo.match, label: null };
}

/** Удаляет из строки распознанный фрагмент срока (чтобы он не попал в название). */
export function stripDate(text, parsed) {
  if (!parsed?.match) return text;
  let out = text;
  for (const fragment of String(parsed.match).split(/\s+/)) {
    if (!fragment) continue;
    out = out.replace(new RegExp(`(?<!${L})${escapeRe(fragment)}(?!${L})`, 'iu'), ' ');
  }
  return out.replace(/\s{2,}/g, ' ').replace(/\s+([,;.])/g, '$1').trim();
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
