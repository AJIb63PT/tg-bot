/**
 * Планировщик: утренняя сводка в настроенное время + проверка погодных рисков.
 * Работает по «настенным» часам каждого чата (chat_settings.tz), поэтому
 * переход на летнее время учитывается автоматически через zonedTimeToUtc.
 *
 * Догоняющая логика: если процесс был выключен и время уже прошло, сводка
 * отправится при следующей проверке (не позже GRACE_MINUTES), но один раз в день.
 */

import { addDays, humanDate, nowISO, zonedParts } from './util.js';
import { buildDigest, areaNeedsWeather, weatherWarnings, weatherBlock } from './service.js';
import { SEVERITY_ICON } from './weather.js';

const CHECK_INTERVAL_MS = 60_000;
const GRACE_MINUTES = 180;

export class Scheduler {
  /**
   * @param {object} o
   * @param {import('./db.js').Store} o.store
   * @param {object} o.cfg
   * @param {(chatId:number, text:string)=>Promise<any>} o.send
   * @param {object} [o.logger]
   */
  constructor({ store, cfg, send, logger = console }) {
    this.store = store;
    this.cfg = cfg;
    this.send = send;
    this.log = logger;
    this.timer = null;
    this.running = false;
    this.lastTick = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, CHECK_INTERVAL_MS);
    this.timer.unref?.();
    void this.tick();
    this.log.info?.('⏰ Планировщик запущен (проверка раз в минуту)');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const chats = this.store.allChatsWithDigest();
      for (const chat of chats) {
        try {
          await this.maybeDigest(chat);
        } catch (e) {
          this.log.error?.(`Сводка для чата ${chat.chat_id}: ${e.message}`);
        }
      }
      // Раз в сутки подчищаем историю алертов (храним 14 дней).
      const today = nowISO(this.cfg.tz);
      if (this.lastCleanup !== today) {
        this.store.clearOldAlerts(addDays(today, -14));
        this.lastCleanup = today;
      }
      this.lastTick = new Date();
    } finally {
      this.running = false;
    }
  }

  async maybeDigest(chat) {
    const chatId = Number(chat.chat_id);
    const tz = chat.tz || this.cfg.tz;
    const { date: today, time: hhmm } = zonedParts(new Date(), tz);
    const [h, m] = (chat.digest_time || this.cfg.digestTime).split(':').map(Number);
    const [nowH, nowM] = hhmm.split(':').map(Number);
    const minutesNow = nowH * 60 + nowM;
    const target = h * 60 + m;

    if (minutesNow < target || minutesNow > target + GRACE_MINUTES) return;
    if (this.store.digestSentAt(chatId, today)) return;

    await this.sendDigest(chatId, tz, today);
    this.store.markDigestSent(chatId, today);
    // Сразу после сводки — срочные погодные предупреждения (один раз на задачу в день).
    try {
      await this.sendSoonWarnings(chatId, tz);
    } catch (e) {
      this.log.warn?.('Погодные предупреждения: ' + e.message);
    }
  }

  async sendDigest(chatId, tz, today) {
    this.log.info?.(`Отправляю сводку в чат ${chatId} за ${today}`);
    const { text } = await buildDigest(this.store, chatId, this.cfg);
    let out = text;

    // Дополнительно: погодные риски на 3 дня (то, что требует решения сегодня).
    try {
      const tasks = this.store.listTasks({ status: 'open', limit: 500 });
      const weatherTasks = tasks.filter((t) => areaNeedsWeather(this.store, chatId, t, this.cfg));
      const { byTask } = await weatherWarnings(this.store, chatId, weatherTasks, this.cfg, { days: 3 });
      for (const [id, v] of byTask) {
        const t = weatherTasks.find((x) => x.id === id);
        if (t) v.task = t;
      }
      const soon = new Map(
        [...byTask.entries()].filter(([, v]) => v.day && v.warnings.some((w) => w.severity !== 'low')),
      );
      const block = weatherBlock(soon, today);
      if (block && !out.includes('Погодные риски')) out += `\n\n${block}`;
    } catch (e) {
      this.log.warn?.('Погодный блок сводки: ' + e.message);
    }

    await this.send(chatId, out);
  }

  /**
   * Отдельный «бдительный» проход: ищем задачи на завтра, по которым ожидается
   * плохая погода, и присылаем предупреждение заранее (один раз на задачу в день).
   * Вызывается из tick() раз в сутки — в то же время, что и сводка.
   */
  async sendSoonWarnings(chatId, tz) {
    const today = nowISO(tz);
    const tasks = this.store
      .listTasks({ status: 'open', dueFrom: today, limit: 500 })
      .filter((t) => areaNeedsWeather(this.store, chatId, t, this.cfg));
    if (tasks.length === 0) return;
    const { byTask } = await weatherWarnings(this.store, chatId, tasks, this.cfg, { days: 3 });
    const messages = [];
    for (const [id, v] of byTask) {
      const t = tasks.find((x) => x.id === id);
      if (!t) continue;
      const bad = v.warnings.filter((w) => w.severity === 'high');
      if (bad.length === 0) continue;
      if (!this.store.alertIsNew(chatId, 'weather', today, t.code)) continue;
      messages.push(
        `${bad.map((w) => SEVERITY_ICON[w.severity]).join('')} <b>${t.code}</b> «${t.title}» — ${humanDate(t.due_date)}` +
          `${t.area && t.area !== 'Не указан' ? ` (${t.area})` : ''}\n   ${bad.map((w) => w.text).join('; ')}`,
      );
      this.store.markAlert(chatId, 'weather', today, t.code);
    }
    if (messages.length) {
      await this.send(
        chatId,
        `⚠️ <b>Погода мешает работам</b>\n${messages.join('\n')}\n\nПеренесите срок или предусмотрите меры.`,
      );
    }
  }
}
