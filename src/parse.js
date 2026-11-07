/**
 * Разбор свободного текста задачи на поля: участок, заказ, срок, ответственный
 * (+ название работы, тип работ, признак проверки погоды).
 *
 * Поддерживаются как «живые» сообщения:
 *     Покраска, заказ 123, срок пятница, ответственный Иван
 *     участок: Цех 2; заказ №45; до 12.11; ответственный Петров
 *     монтаж опалубки на объекте Склад, заказ 77, к 15 ноября, мастер Сидоров
 * так и многострочные сообщения — каждая непустая строка = отдельная задача.
 */

import { normalizeText, isValidISODate, weekdayName } from './util.js';
import { parseDate } from './dateparse.js';

const L = '\\p{L}';
const CAP = 'А-ЯЁA-Z';

const RE = {
  // «заказ 123», «заказ №123», «заявка #45», «наряд 7»
  order: new RegExp(
    `(?:заказ|заявк\\p{L}*|наряд|зкз|order)\\s*(?:№|#|N|номер)?\\s*[.:\\-]?\\s*([${L}\\d][${L}\\d\\-_/]*)`,
    'iu',
  ),
  orderBare: new RegExp(`(?:№|#)\\s*([${L}\\d][${L}\\d\\-_/]*)`, 'iu'),
  // «ответственный Иван», «исполнитель: Петров И.И.», «мастер Сидоров»
  assignee: new RegExp(
    `(?:ответственн\\p{L}*|ответств\\p{L}*|исполнител\\p{L}*|мастер|бригадир|поручено|назначен\\p{L}*|делает)\\s*[:\\-]?\\s*([${CAP}][\\p{L}\\-]+(?:\\s+[${CAP}][\\p{L}.\\-]*)?)`,
    'u',
  ),
  // «участок: Цех 2», «объект Склад», «на участке Площадка-3»
  area: new RegExp(
    `(?:на\\s+)?(?:участке|участок|объекте|объект|адрес|адресе|локаци\\p{L}*)\\s*[:\\-]?\\s*([^,;.\\n]+)`,
    'iu',
  ),
  // «цех 2», «площадка №3» — слово входит в само название, поэтому берём его целиком
  areaNamed: new RegExp(
    `(?:(?<!${L})(?:в|во|на|из|со)\\s+)?((?<!${L})(?:цех|склад|зон\\p{L}*|площадк\\p{L}*)\\s*(?:№\\s*)?[\\p{L}]*\\s*\\d[\\p{L}\\d\\-/]*)`,
    'iu',
  ),
  // «срок: пятница», «дедлайн 12.11», «к 15 ноября»
  dueLabel: new RegExp(
    `(?:срок\\p{L}*|дедлайн|deadline|выполнить\\s+до|готов\\p{L}*\\s+к|нужно\\s+к|надо\\s+к)\\s*[:\\-]?\\s*([^,;\\n]+)`,
    'iu',
  ),
  statusDone: new RegExp(
    `(?<!${L})(выполнен\\p{L}*|готов\\p{L}*|сделан\\p{L}*|закрыт\\p{L}*|завершен\\p{L}*|завершён\\p{L}*|отменен\\p{L}*|отменён\\p{L}*)(?!${L})`,
    'iu',
  ),
  statusCancelled: new RegExp(`(?<!${L})(отмен\\p{L}*)(?!${L})`, 'iu'),
  statusOpen: new RegExp(`(?<!${L})(не\\s+выполнен\\p{L}*|в\\s+работе|открыт\\p{L}*)(?!${L})`, 'iu'),
  labels: /(?:участок|участке|объект|объекте|цех|склад|зона|зоне|локация|адрес|площадка|заказ|заявка|наряд|зкз|order|срок|сроки|дедлайн|deadline|ответственный|ответственный за|ответств|исполнитель|мастер|бригадир|поручено|назначен|делает)\s*[:№#-]?/giu,
};

/** Слова-заполнители, которые не должны попадать в название задачи. */
const FILLER = new RegExp(
  `(?<!${L})(?:срок|сроки|дедлайн|deadline|ответственный|ответств\\p{L}*|исполнител\\p{L}*|мастер|бригадир|поручено|назначен\\p{L}*|заказ|заявк\\p{L}*|наряд|номер|№|#|участок|участке|объект|объекте|цех|склад|зона|зоне|адрес|площадк\\p{L}*)(?!${L})`,
  'giu',
);

const WEATHER_HINTS = [
  'монтаж', 'монтир', 'кровл', 'фасад', 'бетон', 'сварк', 'высот',
  'землян', 'котлован', 'асфальт', 'покрыти', 'наружн', 'уличн',
];

function makeSink(text) {
  let rest = ` ${text} `;
  return {
    /** Извлекает первый захват и вырезает найденный фрагмент из текста. */
    take(re) {
      const m = re.exec(rest);
      if (!m) return null;
      rest = rest.replace(m[0], ' ');
      return { value: m[1]?.trim() ?? m[0].trim(), full: m[0].trim() };
    },
    strip(re) {
      rest = rest.replace(re, ' ');
    },
    get rest() {
      return rest;
    },
  };
}

function cleanTitle(s) {
  return s
    .replace(/\s+/g, ' ')
    // Удалённые поля оставляют за собой «осиротевшие» разделители:
    // «Покраска, , , , » → «Покраска, ». Схлопываем их в один.
    .replace(/(?:\s*[,;]\s*){2,}/g, ', ')
    .replace(/^[\s,;:\-.]+|[\s,;:\-.]+$/g, '')
    .replace(/\s+([,;:.])/g, '$1')
    .replace(/(?:^|[\s,;])(?:в|во|на|из|со|для|по)\s*$/iu, '')
    .replace(/^и\s+/iu, '')
    .trim();
}

/**
 * Мягкое сравнение с учётом русских окончаний:
 * «в цехе 2» находит участок «Цех 2», «на складе» — «Склад».
 */
export function fuzzyIncludes(haystack, needle) {
  const tokens = (s) =>
    String(s ?? '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .split(' ')
      .filter(Boolean);
  const hay = tokens(haystack);
  const want = tokens(needle);
  if (want.length === 0) return false;
  return want.every((w) => {
    const stem = w.length > 5 ? w.slice(0, w.length - 2) : w.length > 3 ? w.slice(0, -1) : w;
    return hay.some((h) => h === w || h.startsWith(stem));
  });
}

function detectWorkType(text, title, cfg) {
  const haystack = `${title} ${text}`.toLowerCase();
  const configured = (cfg?.weather?.workTypes ?? []).find((w) => haystack.includes(w));
  if (configured) return configured;
  const hint = WEATHER_HINTS.find((w) => haystack.includes(w));
  if (hint) return hint;
  const first = cleanTitle(title).split(/[\s,]+/)[0];
  return first ? first.toLowerCase() : null;
}

function needsWeather(workType, text, cfg) {
  const haystack = `${workType ?? ''} ${text}`.toLowerCase();
  const types = cfg?.weather?.workTypes ?? [];
  if (types.some((w) => haystack.includes(w))) return true;
  return WEATHER_HINTS.some((w) => haystack.includes(w));
}

/**
 * Разбирает одну задачу.
 * @param {string} rawText
 * @param {object} ctx
 *   ctx.today          'YYYY-MM-DD' в часовом поясе чата
 *   ctx.knownAreas     [{name}] — для распознавания участка без метки
 *   ctx.knownAssignees [string] — для распознавания ответственного без метки
 *   ctx.cfg            конфиг
 * @returns {object} задача + warnings
 */
export function parseTask(rawText, ctx) {
  const text = normalizeText(rawText);
  const warnings = [];
  const sink = makeSink(text);

  // 1. Явно помеченные поля ------------------------------------------------
  const order = sink.take(RE.order) ?? sink.take(RE.orderBare);
  const assigneeHit = sink.take(RE.assignee);
  const areaHit = sink.take(RE.area);
  const areaNamedHit = areaHit ? null : sink.take(RE.areaNamed);
  const dueHit = sink.take(RE.dueLabel);

  // 2. Срок: сначала из помеченного фрагмента, потом из всего текста -------
  const dateCtx = { today: ctx.today };
  let due = dueHit ? parseDate(dueHit.value, dateCtx) : { date: null, time: null, match: null, label: null };
  if (!due.date && !due.time) {
    due = parseDate(sink.rest, dateCtx);
  } else if (!due.date) {
    const fallback = parseDate(sink.rest, dateCtx);
    if (fallback.date) due = { ...fallback, time: due.time ?? fallback.time };
  }
  if (due.match) sink.strip(new RegExp(escapeRe(due.match).replace(/\s+/g, '\\s+'), 'iu'));

  // 3. Участок: метка -> «Цех 2» -> известные участки -> «Не указан» -------
  const candidate = areaHit?.value ?? areaNamedHit?.value ?? null;
  let area = null;
  let areaSource = null;
  if (candidate) {
    const clean = candidate.replace(/\s+/g, ' ').trim();
    // Приводим к каноническому названию из справочника, если он совпал.
    const known = ctx.knownAreas?.find(
      (a) => fuzzyIncludes(clean, a.name) || a.name.toLowerCase() === clean.toLowerCase(),
    );
    if (known) {
      area = known.name;
      areaSource = 'match';
    } else {
      area = clean;
      areaSource = areaHit ? 'label' : 'named';
    }
  }
  if (!area && ctx.knownAreas?.length) {
    const hit = ctx.knownAreas.find((a) => fuzzyIncludes(text, a.name));
    if (hit) {
      area = hit.name;
      areaSource = 'match';
      // Название найдено по всему тексту, а не через sink.take, поэтому
      // вырезаем его вручную — иначе участок останется в названии задачи.
      sink.strip(areaRegex(hit.name));
    }
  }
  if (!area) {
    area = 'Не указан';
    areaSource = 'default';
    warnings.push('Участок не распознан — записан как «Не указан». Уточните: /setarea');
  }

  // 4. Ответственный: метка -> известные -> null ---------------------------
  let assignee = assigneeHit?.value?.replace(/\s+/g, ' ').trim() ?? null;
  if (!assignee && ctx.knownAssignees?.length) {
    const lower = text.toLowerCase();
    const hit = ctx.knownAssignees.find((a) => a && lower.includes(a.toLowerCase()));
    if (hit) assignee = hit;
  }
  if (!assignee) {
    const m = new RegExp(`(?:^|[,.!?]\\s+)([${CAP}][а-яёa-z\\-]{2,})\\s*[,.]?$`, 'u').exec(text);
    if (m) {
      assignee = m[1];
      sink.strip(new RegExp(escapeRe(m[1]), 'u'));
    }
  }
  if (!assignee) warnings.push('Ответственный не указан. Добавьте: /assign T-0001 Иванов');

  // 5. Название работы -----------------------------------------------------
  sink.strip(FILLER);
  const title = cleanTitle(sink.rest) || cleanTitle(text) || 'Задача';
  const workType = detectWorkType(text, title, ctx.cfg);

  // 6. Статус --------------------------------------------------------------
  let status = 'open';
  if (RE.statusCancelled.test(text) && !/не\s+отмен/iu.test(text)) status = 'cancelled';
  else if (RE.statusDone.test(text) && !/не\s+выполн/iu.test(text)) status = 'done';

  // 7. Даты в прошлом — предупреждаем -------------------------------------
  if (due.date && due.date < ctx.today) {
    warnings.push(`Срок ${due.date} уже прошёл — задача сразу попадёт в просроченные.`);
  }

  return {
    area,
    areaSource,
    orderNo: order?.value ?? null,
    title,
    workType,
    assignee,
    dueDate: due.date && isValidISODate(due.date) ? due.date : null,
    dueTime: due.time ?? null,
    dueLabel: due.label ?? null,
    status,
    weatherCheck: needsWeather(workType, text, ctx.cfg),
    rawText: text,
    warnings,
  };
}

/** Разбирает сообщение: несколько строк = несколько задач. */
export function parseMessage(rawText, ctx) {
  const text = normalizeText(rawText).replace(/^\/(add|task|задача)\b\s*/iu, '');
  const lines = text
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter((l) => l.length > 1);

  if (lines.length <= 1) {
    const one = parseTask(lines[0] ?? text, ctx);
    return [one];
  }

  // Многострочный ввод: если первая строка — «шапка» с общим сроком/участком,
  // она попадёт в первую задачу; это ожидаемое поведение для быстрого ввода.
  return lines.map((line) => parseTask(line, ctx));
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Регулярка для участка, найденного в свободном тексте. Каждое слово названия
 * допускается с падежным окончанием и предлогом: «Цех 2» найдётся как
 * «в цехе 2», «на складе», «склада». Лишние пробелы учитываются.
 */
function areaRegex(name) {
  const words = String(name).trim().split(/\s+/).map(escapeRe).filter(Boolean);
  if (words.length === 0) return /$^/u;
  const body = words.map((w) => `${w}[${L}]*`).join('\\s+');
  return new RegExp(`(?:\\s+(?:в|во|на|из|со|к|по)\\s+)?(?<!${L})${body}(?!${L})`, 'iu');
}

export { weekdayName };
