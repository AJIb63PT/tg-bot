/**
 * Команды бота — чистые функции над Store/конфигом.
 * Возвращают { text, keyboard? }, чтобы их можно было вызывать и из CLI.
 */

import { humanDate, humanDateLong, isValidHM, nowISO } from './util.js';
import { parseDate } from './dateparse.js';
import {
  addTasksFromText, areaNeedsWeather, buildDigest, dueHuman, STATUS_ICON,
  summaryText, taskLine, weatherWarnings, writeCSV,
} from './service.js';

const HELP = `🤖 <b>Бот учёта задач</b>

Просто пришлите задачу сообщением:
<code>Покраска, заказ 123, срок пятница, ответственный Иван</code>

Разберу на поля и сохраню в базу (SQLite).

<b>Ввод</b>
/add &lt;текст&gt; — добавить задачу (то же, что просто сообщение)
Несколько строк в одном сообщении = несколько задач.

<b>Просмотр</b>
/list [N] — активные задачи
/today — что на сегодня
/overdue — что просрочено
/week — до конца недели
/find &lt;текст&gt; — поиск по названию/заказу/участку
/card &lt;код&gt; — карточка задачи, напр. /card T-0007

<b>Изменение</b>
/done &lt;код&gt; — выполнена
/undone &lt;код&gt; — вернуть в работу
/cancel &lt;код&gt; — отменить
/del &lt;код&gt; — удалить
/assign &lt;код&gt; &lt;имя&gt; — сменить ответственного
/due &lt;код&gt; &lt;срок&gt; — сменить срок (например /due T-0007 завтра)
/setarea &lt;код&gt; &lt;участок&gt; — сменить участок

<b>Участки</b>
/areas — список участков с числом задач

<b>Сводка</b>
/digest — сводка сейчас
/digest on|off — включить/выключить утреннюю рассылку
/digest &lt;ЧЧ:ММ&gt; — время сводки (по умолчанию 09:00)
/summary — короткая сводка

<b>Прочее</b>
/export — выгрузить CSV
/id — узнать свой chat id
/help — эта справка`;

export class Bot {
  constructor({ store, cfg, logger = console }) {
    this.store = store;
    this.cfg = cfg;
    this.log = logger;
  }

  settings(chatId) {
    return this.store.ensureSettings(chatId, this.cfg);
  }

  today(chatId) {
    return nowISO(this.settings(chatId).tz);
  }

  allowed(userId) {
    return this.cfg.allowedUserIds.length === 0 || this.cfg.allowedUserIds.includes(Number(userId));
  }

  /** Достаёт задачу по коду; при неудаче возвращает объект с текстом ошибки. */
  resolve(chatId, arg) {
    if (!arg) return { error: 'Укажите код задачи, например <code>T-0007</code>.' };
    const task = this.store.getTaskByCode(arg.replace(/[^\w-]/g, ''));
    if (!task) return { error: `Задача <code>${escapeHtml(arg)}</code> не найдена. Список: /list` };
    return { task };
  }

  /**
   * @returns {Promise<{text: string, keyboard?: object, files?: Array}>}
   */
  async handle(rawText, { chatId, userId, messageId = null } = {}) {
    if (!this.allowed(userId)) {
      return { text: `⛔ Доступ закрыт. Ваш id: <code>${chatId}</code>. Добавьте его в ALLOWED_USER_IDS.` };
    }
    const text = String(rawText ?? '').trim();
    if (!text) return { text: 'Пустое сообщение. /help' };

    // \w в JS не покрывает кириллицу, поэтому явно добавляем \p{L}.
    const m = /^\/([\p{L}\w]+)(?:@[\w]+)?\s*([\s\S]*)$/u.exec(text);
    if (!m) {
      // Обычное сообщение = новая задача.
      return this.addTask(chatId, text, messageId);
    }
    const [, cmdRaw, argRaw] = m;
    const cmd = cmdRaw.toLowerCase();
    const arg = argRaw.trim();

    switch (cmd) {
      case 'start':
      case 'help':
        return { text: HELP };
      case 'id':
        return { text: `Ваш chat id: <code>${chatId}</code>\nЧасовой пояс: <code>${this.settings(chatId).tz}</code>` };
      case 'add':
      case 'task':
      case 'задача':
        return this.addTask(chatId, arg, messageId);
      case 'list':
      case 'ls':
        return this.list(chatId, arg);
      case 'today':
        return this.filtered(chatId, 'today');
      case 'overdue':
      case 'просрочено':
        return this.filtered(chatId, 'overdue');
      case 'week':
        return this.filtered(chatId, 'week');
      case 'summary':
        return this.filtered(chatId, 'summary');
      case 'digest':
        return this.digestCommand(chatId, arg);
      case 'done':
        return this.status(chatId, arg, 'done');
      case 'undone':
      case 'reopen':
        return this.status(chatId, arg, 'open');
      case 'cancel':
        return this.status(chatId, arg, 'cancelled');
      case 'del':
      case 'delete':
        return this.deleteTask(chatId, arg);
      case 'card':
      case 'show':
        return this.card(chatId, arg);
      case 'find':
      case 'search':
        return this.find(chatId, arg);
      case 'assign':
        return this.reassign(chatId, arg);
      case 'due':
        return this.setDue(chatId, arg);
      case 'setarea':
        return this.setArea(chatId, arg);
      case 'areas':
        return this.areas(chatId);
      case 'export':
        return this.exportCsv(chatId);
      default:
        return { text: `Неизвестная команда: /${escapeHtml(cmd)}\n\n${HELP}` };
    }
  }

  // -------------------------------------------------------------- действия --

  addTask(chatId, text, messageId) {
    if (!text.trim()) return { text: 'Пришлите текст задачи, например:\n<code>Покраска, заказ 123, срок пятница, ответственный Иван</code>' };
    const { tasks, warnings } = addTasksFromText(this.store, chatId, text, this.cfg, { messageId });
    const today = this.today(chatId);

    const lines = tasks.map((t) => {
      const extra = [];
      if (t.parse.weatherCheck) extra.push('🌦 проверю погоду к сроку');
      return (
        `✅ <b>${t.code}</b> — ${escapeHtml(t.title)}\n` +
        `   участок: ${escapeHtml(t.area)} · заказ: ${escapeHtml(t.order_no ?? '—')}\n` +
        `   срок: ${escapeHtml(dueHuman(t, today))} · отв.: ${escapeHtml(t.assignee ?? '—')}` +
        (extra.length ? `\n   ${extra.join(' · ')}` : '')
      );
    });

    let out = lines.join('\n\n');
    if (tasks.length > 1) out = `Добавлено задач: <b>${tasks.length}</b>\n\n${out}`;
    if (warnings.length) {
      out += `\n\n⚠️ ${[...new Set(warnings)].map(escapeHtml).join('\n⚠️ ')}`;
    }

    // Сразу предупредим, если по сроку плохая погода.
    const keyboard = {
      inline_keyboard: tasks.slice(0, 5).map((t) => [
        { text: `✅ ${t.code} выполнена`, callback_data: `done:${t.id}` },
        { text: `📅 ${t.code} завтра`, callback_data: `snooze:${t.id}:1` },
      ]),
    };
    listWeatherHint(this.store, this.cfg, chatId, tasks, this.log).then((hint) => {
      if (hint) this.notify?.(chatId, hint);
    }).catch(() => {});

    return { text: out, keyboard };
  }

  list(chatId, arg) {
    const limit = Number(arg) > 0 ? Math.min(Number(arg), 100) : 30;
    const tasks = this.store.listTasks({ status: 'open', limit });
    const today = this.today(chatId);
    if (tasks.length === 0) return { text: 'Активных задач нет. Добавьте первую сообщением или /add.' };
    return {
      text: `<b>Активные задачи</b> (${tasks.length})\n\n${tasks.map((t, i) => taskLine(t, today, i + 1)).join('\n\n')}`,
      keyboard: taskKeyboard(tasks),
    };
  }

  filtered(chatId, mode) {
    const today = this.today(chatId);
    const all = this.store.listTasks({ status: 'open', limit: 500 });
    if (mode === 'summary') return { text: summaryText(all, today) };
    const pick = {
      today: (t) => t.due_date === today,
      overdue: (t) => t.due_date && t.due_date < today,
      week: (t) => t.due_date && t.due_date >= today && t.due_date <= addDaysISO(today, 6),
    }[mode];
    const tasks = all.filter(pick);
    const titles = {
      today: `📌 На сегодня — ${humanDateLong(today)}`,
      overdue: '🔴 Просроченные задачи',
      week: '🗓 Задачи до конца недели',
    };
    if (tasks.length === 0) return { text: `${titles[mode]}\n\nНичего нет 🎉` };
    return {
      text: `<b>${titles[mode]}</b> (${tasks.length})\n\n${tasks.map((t, i) => taskLine(t, today, i + 1)).join('\n\n')}`,
      keyboard: taskKeyboard(tasks),
    };
  }

  card(chatId, arg) {
    const { task, error } = this.resolve(chatId, arg);
    if (error) return { text: error };
    return this.renderCard(task, chatId);
  }

  /** Отрисовка карточки задачи. Используется и командой /card, и кнопкой «📄». */
  renderCard(task, chatId) {
    const today = this.today(chatId);
    const rows = [
      `<b>${task.code}</b> ${STATUS_ICON[task.status] ?? ''}`,
      `<b>${escapeHtml(task.title)}</b>`,
      `Участок: ${escapeHtml(task.area)}`,
      `Заказ: ${escapeHtml(task.order_no ?? '—')}`,
      `Вид работ: ${escapeHtml(task.work_type ?? '—')}`,
      `Ответственный: ${escapeHtml(task.assignee ?? '—')}`,
      `Срок: ${escapeHtml(dueHuman(task, today))}`,
      `Проверка погоды: ${task.weather_check ? 'да' : 'нет'}`,
      `Создана: ${escapeHtml(String(task.created_at).replace('T', ' ').slice(0, 16))}`,
    ];
    if (task.raw_text) rows.push(`<i>Исходный текст: ${escapeHtml(task.raw_text)}</i>`);
    return {
      text: rows.join('\n'),
      keyboard: {
        inline_keyboard: [
          [
            { text: task.status === 'open' ? '✅ Выполнена' : '↩️ Вернуть в работу', callback_data: `toggle:${task.id}` },
            { text: '⏭ +1 день', callback_data: `snooze:${task.id}:1` },
            { text: '⏭ +1 нед.', callback_data: `snooze:${task.id}:7` },
          ],
          [
            { text: '📋 Все задачи', callback_data: 'list:0' },
            { text: '🗑 Удалить', callback_data: `del:${task.id}` },
          ],
        ],
      },
    };
  }

  status(chatId, arg, status) {
    const { task, error } = this.resolve(chatId, arg);
    if (error) return { text: error };
    if (task.status === status) return { text: `${task.code} уже в статусе «${STATUS_ICON[status]} ${status}».` };
    this.store.setStatus(task.id, status);
    const labels = { done: '✅ Выполнена', open: '🟢 Возвращена в работу', cancelled: '🚫 Отменена' };
    return { text: `${labels[status]}: <b>${task.code}</b> — ${escapeHtml(task.title)}` };
  }

  deleteTask(chatId, arg) {
    const { task, error } = this.resolve(chatId, arg);
    if (error) return { text: error };
    this.store.deleteTask(task.id);
    return { text: `🗑 Удалена: <b>${task.code}</b> — ${escapeHtml(task.title)}` };
  }

  find(chatId, arg) {
    if (!arg) return { text: 'Укажите запрос: /find покраска' };
    const tasks = this.store.listTasks({ status: 'all', search: arg, limit: 30 });
    const today = this.today(chatId);
    if (tasks.length === 0) return { text: `По запросу «${escapeHtml(arg)}» ничего не найдено.` };
    return {
      text: `<b>Найдено: ${tasks.length}</b>\n\n${tasks.map((t, i) => taskLine(t, today, i + 1)).join('\n\n')}`,
    };
  }

  reassign(chatId, arg) {
    const m = /^(\S+)\s+(.+)$/u.exec(arg);
    if (!m) return { text: 'Формат: /assign T-0007 Иванов' };
    const { task, error } = this.resolve(chatId, m[1]);
    if (error) return { text: error };
    this.store.updateTask(task.id, { assignee: m[2].trim() });
    return { text: `👤 ${task.code}: ответственный → <b>${escapeHtml(m[2].trim())}</b>` };
  }

  setDue(chatId, arg) {
    const m = /^(\S+)\s+(.+)$/u.exec(arg);
    if (!m) return { text: 'Формат: /due T-0007 завтра' };
    const { task, error } = this.resolve(chatId, m[1]);
    if (error) return { text: error };
    const today = this.today(chatId);
    const parsed = parseDate(m[2], { today });
    if (!parsed.date) return { text: `Не понял срок «${escapeHtml(m[2])}». Примеры: завтра, пятница, 15.11, через 3 дня.` };
    this.store.updateTask(task.id, { due_date: parsed.date, due_time: parsed.time ?? task.due_time });
    return { text: `📅 ${task.code}: срок → <b>${escapeHtml(dueHuman({ ...task, due_date: parsed.date, due_time: parsed.time ?? task.due_time }, today))}</b>` };
  }

  setArea(chatId, arg) {
    const m = /^(\S+)\s+(.+)$/u.exec(arg);
    if (!m) return { text: 'Формат: /setarea T-0007 Цех 2' };
    const { task, error } = this.resolve(chatId, m[1]);
    if (error) return { text: error };
    const area = this.store.matchArea(chatId, m[2].trim()) ?? this.store.getArea(chatId, m[2].trim());
    this.store.updateTask(task.id, {
      area: area?.name ?? m[2].trim(),
      lat: area?.lat ?? null,
      lon: area?.lon ?? null,
      city: area?.city ?? null,
    });
    return { text: `🏗 ${task.code}: участок → <b>${escapeHtml(area?.name ?? m[2].trim())}</b>` };
  }

  areas(chatId) {
    // Подтягиваем участники, названные в задачах, но отсутствующие в справочнике
    // (наследие старых версий). Идемпотентно и безопасно.
    this.store.syncAreasFromTasks();
    const list = this.store.listAreasDetailed(chatId);
    if (list.length === 0) {
      return {
        text:
          'Участков пока нет.\n\n' +
          'Участок создаётся сам, как только вы упомянете его в задаче:\n' +
          '<code>Покраска, заказ 123, срок пятница, ответственный Иван, участок ФФ1</code>\n\n' +
          'Координаты для прогноза берутся из DEFAULT_LAT / DEFAULT_LON в .env.',
      };
    }
    const lines = list.map((a) => {
      const bits = [];
      if (a.open_tasks > 0) bits.push(`${a.open_tasks} в работе`);
      else if (a.total_tasks > 0) bits.push(`задач: ${a.total_tasks}`);
      if (a.city) bits.push(escapeHtml(a.city));
      if (a.lat) bits.push(`${a.lat}, ${a.lon}`);
      return (
        `• <b>${escapeHtml(a.name)}</b>${a.weather_check ? ' 🌦' : ''}` +
        (bits.length ? ` — ${bits.join(' · ')}` : '')
      );
    });
    const hasWeather = list.some((a) => a.weather_check);
    const note = hasWeather ? '\n\n🌦 — по участку проверяется погода' : '';
    return { text: `<b>Участки</b> (${list.length})\n${lines.join('\n')}${note}` };
  }

  digestCommand(chatId, arg) {
    const settings = this.settings(chatId);
    const a = arg.trim().toLowerCase();
    if (!arg) {
      return this.digestBuild(chatId);
    }
    if (a === 'on' || a === 'off' || a === 'вкл' || a === 'выкл') {
      const on = a === 'on' || a === 'вкл';
      this.store.updateSettings(chatId, { digest_enabled: on });
      return { text: `Утренняя сводка в ${settings.digest_time}: <b>${on ? 'включена' : 'выключена'}</b>` };
    }
    if (isValidHM(a)) {
      this.store.updateSettings(chatId, { digest_time: a });
      return { text: `⏰ Время сводки: <b>${a}</b> (${settings.tz})` };
    }
    return { text: 'Формат: /digest, /digest on, /digest off, /digest 08:30' };
  }

  async digestBuild(chatId) {
    const { text } = await buildDigest(this.store, chatId, this.cfg);
    return { text: `<b>Сводка (предпросмотр)</b>\n\n${text}` };
  }

  exportCsv(chatId) {
    const tasks = this.store.listTasks({ status: 'all', limit: 500 });
    const file = writeCSV(tasks);
    return { text: `📄 Экспортировано задач: <b>${tasks.length}</b>\nВ файл: <code>${escapeHtml(file)}</code>`, files: [file] };
  }

  /** Нажатия на инлайн-кнопки. */
  async callback(data, { chatId } = {}) {
    const [action, idRaw, extra] = String(data).split(':');

    // Действия, не привязанные к конкретной задаче.
    if (action === 'list') {
      return this.list(chatId, String(extra ?? ''));
    }

    const task = this.store.getTask(Number(idRaw));
    if (!task) return { text: 'Задача не найдена (возможно, удалена).' };
    const today = this.today(chatId);

    switch (action) {
      case 'card':
        return this.renderCard(task, chatId);
      case 'done':
        this.store.setStatus(task.id, 'done');
        return { text: `✅ <b>${task.code}</b> — ${escapeHtml(task.title)}\nОтмечена выполненной.` };
      case 'toggle': {
        const next = task.status === 'open' ? 'done' : 'open';
        this.store.setStatus(task.id, next);
        return { text: `${next === 'done' ? '✅' : '🟢'} <b>${task.code}</b>: ${next === 'done' ? 'выполнена' : 'в работе'}` };
      }
      case 'snooze': {
        const days = Number(extra) || 1;
        const base = task.due_date && task.due_date > today ? task.due_date : today;
        const nextDate = addDaysISO(base, days);
        this.store.updateTask(task.id, { due_date: nextDate });
        return { text: `📅 <b>${task.code}</b>: срок → ${humanDate(nextDate)}` };
      }
      case 'del':
        this.store.deleteTask(task.id);
        return { text: `🗑 Удалена: <b>${task.code}</b>` };
      default:
        return { text: 'Неизвестное действие.' };
    }
  }
}

function addDaysISO(dateISO, days) {
  return new Date(Date.parse(`${dateISO}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function taskKeyboard(tasks) {
  return {
    inline_keyboard: tasks.slice(0, 8).map((t) => [
      { text: `✅ ${t.code}`, callback_data: `done:${t.id}` },
      { text: `⏭ ${t.code} +1д`, callback_data: `snooze:${t.id}:1` },
    ]),
  };
}

/** Короткий разовый прогноз-подсказка при добавлении задачи. */
async function listWeatherHint(store, cfg, chatId, tasks, log) {
  const relevant = tasks.filter((t) => areaNeedsWeather(store, chatId, t, cfg) && t.due_date);
  if (relevant.length === 0) return '';
  try {
    const { byTask } = await weatherWarnings(store, chatId, relevant, cfg, { days: 14 });
    const lines = [];
    for (const t of relevant) {
      const v = byTask.get(t.id);
      if (!v) continue;
      const risky = v.warnings.filter((w) => w.severity !== 'low');
      if (risky.length === 0) continue;
      lines.push(
        `🌦 ${t.code} (${humanDate(t.due_date)}): ` + risky.map((w) => w.text).join('; '),
      );
    }
    if (lines.length === 0) return '';
    return `<b>Внимание, погода на срок:</b>\n${lines.map(escapeHtml).join('\n')}\nНажмите «выполнена» или перенесите срок, если работа зависит от погоды.`;
  } catch (e) {
    log?.warn?.('weather hint failed: ' + e.message);
    return '';
  }
}
