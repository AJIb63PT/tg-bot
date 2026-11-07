/**
 * Прикладной слой: добавление задач, сборка сводок, погодные проверки, экспорт.
 * Используется и ботом, и CLI.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import {
  addDays, diffDays, endOfMonthISO, humanDate, humanDateLong, isValidISODate,
  isoWeekdayFromISO, nowISO, startOfWeekISO, weekdayName,
} from './util.js';
import { parseMessage } from './parse.js';
import { evaluateDay, fetchForecast, formatDayLine, fmt, SEVERITY_ICON } from './weather.js';

// ---------------------------------------------------------------- задачи ----

export function chatContext(store, chatId, cfg) {
  const settings = store.ensureSettings(chatId, cfg);
  const today = nowISO(settings.tz);
  return {
    settings,
    today,
    knownAreas: store.listAreas(chatId),
    knownAssignees: [
      ...new Set(
        store
          .listTasks({ status: 'all', limit: 500 })
          .map((t) => t.assignee)
          .filter(Boolean),
      ),
    ],
    cfg,
  };
}

/** Разбирает текст и сохраняет задачи. */
export function addTasksFromText(store, chatId, text, cfg, { messageId = null } = {}) {
  const ctx = chatContext(store, chatId, cfg);
  const parsed = parseMessage(text, { ...ctx, cfg });
  const saved = [];
  for (const p of parsed) {
    const area = store.matchArea(chatId, p.area) ?? store.getArea(chatId, p.area);
    const task = store.createTask({
      area: p.area,
      orderNo: p.orderNo,
      title: p.title,
      workType: p.workType,
      assignee: p.assignee,
      dueDate: p.dueDate,
      dueTime: p.dueTime,
      weatherCheck: p.weatherCheck,
      lat: p.areaSource !== 'default' ? area?.lat ?? null : null,
      lon: p.areaSource !== 'default' ? area?.lon ?? null : null,
      city: area?.city ?? null,
      chatId,
      messageId,
      rawText: p.rawText,
    });
    if (p.status !== 'open') {
      store.setStatus(task.id, p.status);
    }
    // Участок, названный в тексте (меткой или как «Цех 2»), заводим в справочник —
    // иначе бот не узнает его в следующих сообщениях без метки. Погодный контроль
    // включаем только для работ, которым он нужен; у существующего участка флаг
    // не сбрасываем (undefined не попадает в UPDATE).
    if (p.areaSource !== 'default' && p.area && p.area !== 'Не указан') {
      store.upsertArea(chatId, p.area, {
        weather_check: p.weatherCheck ? 1 : undefined,
      });
    }
    saved.push({ ...store.getTask(task.id), parse: p });
  }
  return { tasks: saved, today: ctx.today, warnings: parsed.flatMap((p) => p.warnings) };
}

// ---------------------------------------------------------------- вывод -----

export const STATUS_ICON = { open: '🟢', done: '✅', cancelled: '🚫' };

export function dueHuman(task, today) {
  if (!task.due_date) return 'без срока';
  const d = task.due_date;
  const delta = diffDays(today, d);
  const time = task.due_time ? ` ${task.due_time}` : '';
  if (delta === 0) return `сегодня${time}`;
  if (delta === 1) return `завтра${time}`;
  if (delta === -1) return `вчера (${humanDate(d)})`;
  if (delta < 0) return `${humanDate(d)} — просрочено на ${Math.abs(delta)} дн.`;
  return `${humanDate(d)}${time}`;
}

export function taskLine(task, today, index = null) {
  const num = index === null ? '' : `${index}. `;
  const bits = [`${STATUS_ICON[task.status] ?? ''}${num}${task.code} — ${task.title}`];
  const meta = [];
  if (task.area && task.area !== 'Не указан') meta.push(task.area);
  if (task.order_no) meta.push(`заказ ${task.order_no}`);
  if (task.assignee) meta.push(`отв. ${task.assignee}`);
  meta.push(dueHuman(task, today));
  return `${bits.join('')}\n   ${meta.join(' · ')}`;
}

export function collectBuckets(tasks, today) {
  const open = tasks.filter((t) => t.status === 'open');
  const weekEnd = addDays(startOfWeekISO(today), 6);
  const monthEnd = endOfMonthISO(today);
  return {
    overdue: open.filter((t) => t.due_date && t.due_date < today),
    today: open.filter((t) => t.due_date === today),
    tomorrow: open.filter((t) => t.due_date === addDays(today, 1)),
    week: open.filter((t) => t.due_date && t.due_date > addDays(today, 1) && t.due_date <= weekEnd),
    later: open.filter((t) => t.due_date && (t.due_date > weekEnd || t.due_date > monthEnd)),
    noDate: open.filter((t) => !t.due_date),
    total: open.length,
  };
}

export function summaryText(tasks, today, { title = null, limitPerSection = 15 } = {}) {
  const b = collectBuckets(tasks, today);
  const head = title ?? `☀️ Сводка на ${humanDateLong(today)}, ${weekdayName(today)}`;
  const out = [head, `Всего в работе: ${b.total}`, ''];

  const section = (label, items, note) => {
    if (items.length === 0) return;
    out.push(`${label} (${items.length})`);
    items.slice(0, limitPerSection).forEach((t, i) => out.push(taskLine(t, today, i + 1)));
    if (items.length > limitPerSection) out.push(`   … и ещё ${items.length - limitPerSection}`);
    if (note) out.push(`   ${note}`);
    out.push('');
  };

  section('🔴 Просрочено', b.overdue);
  section('📌 На сегодня', b.today);
  section('⏭ Завтра', b.tomorrow);
  section('🗓 До конца недели', b.week);
  section('📅 Позже', b.later);
  section('❔ Без срока', b.noDate);

  if (out.length === 2) out.push('Задач в работе нет. Добавьте: «Покраска, заказ 123, срок пятница, ответственный Иван»');
  return out.join('\n').trimEnd();
}

// -------------------------------------------------------------- погода ------

/** Нужен ли прогноз этому участку (индивидуальные настройки или общий список). */
export function areaNeedsWeather(store, chatId, task, cfg) {
  if (!task.area || task.area === 'Не указан') return Boolean(task.weather_check);
  const area = store.getArea(chatId, task.area);
  if (area?.weather_check) return true;
  return Boolean(task.weather_check);
}

export function taskCoords(store, chatId, task, cfg) {
  const area = task.area && task.area !== 'Не указан' ? store.getArea(chatId, task.area) : null;
  const settings = store.ensureSettings(chatId, cfg);
  return {
    lat: area?.lat ?? settings.lat ?? cfg.weather.defaultLat,
    lon: area?.lon ?? settings.lon ?? cfg.weather.defaultLon,
    place: area?.city ?? settings.city ?? cfg.weather.defaultCity,
  };
}

/**
 * Прогноз + предупреждения для набора задач.
 * @returns {Promise<{byTask: Map<number, {place:string, day:object, warnings:object[]}> , places:number}>}
 */
export async function weatherWarnings(store, chatId, tasks, cfg, { days = 7 } = {}) {
  const settings = store.ensureSettings(chatId, cfg);
  const today = nowISO(settings.tz);
  const horizon = addDays(today, days);
  const relevant = tasks.filter(
    (t) => t.status === 'open' && t.due_date && t.due_date >= today && t.due_date <= horizon,
  );
  const byTask = new Map();
  if (relevant.length === 0) return { byTask, places: 0 };

  // Группируем по координатам, чтобы не дёргать API лишний раз.
  const groups = new Map();
  for (const t of relevant) {
    const { lat, lon, place } = taskCoords(store, chatId, t, cfg);
    const key = `${lat},${lon}`;
    if (!groups.has(key)) groups.set(key, { lat, lon, place, tasks: [] });
    groups.get(key).tasks.push(t);
  }

  const thresholds = {
    frostThresholdC: cfg.weather.frostThresholdC,
    windThresholdKmh: cfg.weather.windThresholdKmh,
    rainThresholdMm: cfg.weather.rainThresholdMm,
  };

  for (const group of groups.values()) {
    let forecast = null;
    const neededDays = group.tasks.map((t) => t.due_date);
    const allCached = neededDays.every((d) => store.getForecast(chatId, group.lat, group.lon, d));
    if (allCached) {
      forecast = neededDays.map((d) => store.getForecast(chatId, group.lat, group.lon, d, 1e9));
    } else {
      try {
        forecast = await fetchForecast({
          lat: group.lat,
          lon: group.lon,
          tz: settings.tz,
          days: Math.max(days, 3),
        });
        store.saveForecast(chatId, group.lat, group.lon, forecast);
      } catch (e) {
        for (const t of group.tasks) {
          byTask.set(t.id, {
            place: group.place,
            day: null,
            warnings: [{ kind: 'error', severity: 'low', text: `нет данных: ${e.message}` }],
          });
        }
        continue;
      }
    }
    for (const t of group.tasks) {
      const day = forecast.find((f) => f.day === t.due_date) ?? null;
      const warns = day
        ? evaluateDay(day, thresholds)
        : [{ kind: 'info', severity: 'low', text: 'прогноз на эту дату недоступен' }];
      byTask.set(t.id, { place: group.place, day, warnings: warns });
    }
  }
  return { byTask, places: groups.size };
}

export function weatherBlock(byTask, today) {
  const risky = [...byTask.entries()].filter(([, v]) =>
    v.warnings.some((w) => w.severity === 'high' || w.severity === 'medium'),
  );
  if (risky.length === 0) return '';
  const out = ['🌦 Погодные риски'];
  for (const [id, v] of risky) {
    const t = v.task ?? null;
    const head = t
      ? `${t.code} «${t.title}»${t.area && t.area !== 'Не указан' ? ` (${t.area})` : ''}, срок ${humanDate(t.due_date)}${t.assignee ? `, отв. ${t.assignee}` : ''}`
      : `#${id}`;
    out.push(`• ${head}`);
    for (const w of v.warnings) {
      if (w.severity === 'low' && w.kind !== 'info') continue;
      out.push(`   ${SEVERITY_ICON[w.severity] ?? ''} ${w.text}`);
    }
    if (v.day) out.push(`   🌡 ${formatDayLine(v.day)}`);
  }
  return out.join('\n');
}

/** Полная утренняя сводка (задачи + погодные риски). */
export async function buildDigest(store, chatId, cfg, { includeWeather = true } = {}) {
  const settings = store.ensureSettings(chatId, cfg);
  const today = nowISO(settings.tz);
  const tasks = store.listTasks({ status: 'open', limit: 500 });
  let text = summaryText(tasks, today);

  if (includeWeather) {
    const weatherTasks = tasks.filter((t) => areaNeedsWeather(store, chatId, t, cfg));
    if (weatherTasks.length > 0) {
      try {
        const { byTask } = await weatherWarnings(store, chatId, weatherTasks, cfg, { days: 7 });
        for (const [id, v] of byTask) {
          const t = weatherTasks.find((x) => x.id === id);
          if (t) v.task = t;
        }
        const block = weatherBlock(byTask, today);
        if (block) text += `\n\n${block}`;
      } catch (e) {
        text += `\n\n🌦 Погода: не удалось получить прогноз (${e.message})`;
      }
    }
  }
  return { text, today, tasks };
}

// --------------------------------------------------------------- экспорт ----

const CSV_COLUMNS = [
  ['code', 'Код'],
  ['area', 'Участок'],
  ['order_no', 'Заказ'],
  ['title', 'Задача'],
  ['work_type', 'Вид работ'],
  ['assignee', 'Ответственный'],
  ['due_date', 'Срок'],
  ['due_time', 'Время'],
  ['status', 'Статус'],
  ['weather_check', 'Проверка погоды'],
  ['created_at', 'Создана'],
  ['updated_at', 'Изменена'],
  ['raw_text', 'Исходный текст'],
];

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV с разделителем ';' и BOM — открывается в Excel без настроек. */
export function tasksToCSV(tasks) {
  const header = CSV_COLUMNS.map(([, label]) => csvCell(label)).join(';');
  const rows = tasks.map((t) =>
    CSV_COLUMNS.map(([key]) => {
      if (key === 'status') return csvCell(STATUS_RU[t.status] ?? t.status);
      if (key === 'weather_check') return csvCell(t.weather_check ? 'да' : 'нет');
      return csvCell(t[key]);
    }).join(';'),
  );
  return `\uFEFF${[header, ...rows].join('\r\n')}\r\n`;
}

export const STATUS_RU = { open: 'в работе', done: 'выполнена', cancelled: 'отменена' };

export function writeCSV(tasks, file = path.join(ROOT, 'export', 'tasks.csv')) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, tasksToCSV(tasks), 'utf8');
  return file;
}

export { fmt, isValidISODate, isoWeekdayFromISO, humanDate };
