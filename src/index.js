#!/usr/bin/env node
/**
 * Точка входа: Telegram-бот + планировщик утренней сводки + SQLite.
 *
 * Запуск:  npm start        (нужен BOT_TOKEN в .env — см. .env.example)
 */

import process from 'node:process';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { Telegram } from './telegram.js';
import { Bot } from './commands.js';
import { Scheduler } from './scheduler.js';

const log = {
  info: (...a) => console.log(`[${stamp()}]`, ...a),
  warn: (...a) => console.warn(`[${stamp()}] ⚠️`, ...a),
  error: (...a) => console.error(`[${stamp()}] ❌`, ...a),
};

function stamp() {
  return new Date().toISOString().slice(11, 19);
}

async function main() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    log.error(e.message);
    process.exit(1);
  }

  if (!cfg.botToken) {
    log.error(
      'Не задан BOT_TOKEN.\n' +
        '  1) Откройте @BotFather в Telegram → /newbot → получите токен.\n' +
        '  2) Скопируйте .env.example в .env и впишите токен в BOT_TOKEN.\n' +
        '  3) Запустите снова: npm start\n\n' +
        'Пока можно посмотреть, как работает разбор текста, без бота:\n' +
        '  npm run parse -- "Покраска, заказ 123, срок пятница, ответственный Иван"\n' +
        '  npm run summary\n' +
        '  npm run weather',
    );
    process.exit(1);
  }

  const store = new Store(cfg.dbPath);
  const tg = new Telegram(cfg.botToken, log);
  const bot = new Bot({ store, cfg, logger: log });

  // Разовая починка данных: версии до исправления не заводили участок, если
  // работе не требовалась проверка погоды. Подтягиваем такие участки из задач.
  try {
    const restored = store.syncAreasFromTasks();
    if (restored > 0) {
      log.info(`Восстановлено участков из задач: ${restored} (см. /areas)`);
    }
  } catch (e) {
    log.warn('syncAreasFromTasks: ' + e.message);
  }

  // Бот может присылать «догоняющие» уведомления (например, погода при добавлении).
  bot.notify = async (chatId, text) => {
    try {
      await tg.sendMessage(chatId, text);
    } catch (e) {
      log.warn?.('notify: ' + e.message);
    }
  };

  let me;
  try {
    me = await tg.getMe();
  } catch (e) {
    if (/401|Unauthorized/i.test(e.message)) {
      log.error(
        'Telegram не принял BOT_TOKEN (401 Unauthorized).\n' +
          '  Проверьте, что в .env лежит токен целиком, вида 123456789:AAH...\n' +
          '  Получить/перевыпустить: @BotFather → /mybots → ваш бот → API Token.',
      );
    } else {
      log.error('Не удалось связаться с Telegram: ' + e.message);
    }
    store.close();
    process.exit(1);
  }
  log.info(`Бот запущен: @${me.username} (id ${me.id})`);
  log.info(`База: ${cfg.dbPath}`);
  log.info(`Часовой пояс: ${cfg.tz}, сводка в ${cfg.digestTime}`);
  log.info(
    `Погода: порог мороза ≤ ${cfg.weather.frostThresholdC} °C, ветер ≥ ${cfg.weather.windThresholdKmh} км/ч, ` +
      `осадки ≥ ${cfg.weather.rainThresholdMm} мм`,
  );
  if (cfg.allowedUserIds.length > 0) {
    log.info(`Доступ разрешён пользователям: ${cfg.allowedUserIds.join(', ')}`);
  } else {
    log.warn('ALLOWED_USER_IDS пуст — бот отвечает всем. Узнайте свой id командой /id и впишите его в .env.');
  }

  try {
    await tg.setMyCommands([
      { command: 'add', description: 'Добавить задачу' },
      { command: 'list', description: 'Активные задачи' },
      { command: 'today', description: 'Что на сегодня' },
      { command: 'overdue', description: 'Что просрочено' },
      { command: 'week', description: 'До конца недели' },
      { command: 'summary', description: 'Короткая сводка' },
      { command: 'digest', description: 'Утренняя сводка: настройка и предпросмотр' },
      { command: 'card', description: 'Карточка задачи по коду' },
      { command: 'find', description: 'Поиск задач' },
      { command: 'done', description: 'Отметить выполненной' },
      { command: 'due', description: 'Сменить срок' },
      { command: 'assign', description: 'Сменить ответственного' },
      { command: 'areas', description: 'Участки' },
      { command: 'export', description: 'Выгрузить CSV' },
      { command: 'id', description: 'Мой chat id' },
      { command: 'help', description: 'Справка' },
    ]);
  } catch (e) {
    log.warn('setMyCommands: ' + e.message);
  }

  const scheduler = new Scheduler({
    store,
    cfg,
    send: (chatId, text) => tg.sendMessage(chatId, text),
    logger: log,
  });
  scheduler.start();

  const controller = new AbortController();

  const shutdown = async (reason) => {
    log.info(`Останавливаюсь (${reason})…`);
    controller.abort();
    scheduler.stop();
    setTimeout(() => {
      try {
        store.close();
      } catch {
        /* уже закрыта */
      }
      process.exit(0);
    }, 300).unref();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => log.error('unhandledRejection: ' + (e?.stack ?? e)));
  process.on('uncaughtException', (e) => log.error('uncaughtException: ' + (e?.stack ?? e)));

  await tg.poll(
    async (update) => {
      await handleUpdate({ update, bot, tg, store, cfg, log });
    },
    { signal: controller.signal },
  );
}

async function handleUpdate({ update, bot, tg, store, cfg, log }) {
  // --- обычные сообщения ----------------------------------------------------
  const msg = update.message ?? update.edited_message;
  if (msg) {
    const chatId = msg.chat?.id;
    const userId = msg.from?.id;
    const text = msg.text ?? msg.caption;

    if (!text) {
      if (msg.document || msg.photo) {
        await tg.sendMessage(
          chatId,
          'Пока понимаю только текст. Пришлите задачу сообщением, например:\n' +
            '<code>Монтаж опалубки, участок Цех 2, заказ 77, срок пятница, ответственный Иван</code>',
        );
      }
      return;
    }

    log.info(`← [${chatId}] ${text.slice(0, 120).replace(/\n/g, ' ⏎ ')}`);
    await tg.sendChatAction(chatId, 'typing');
    const res = await bot.handle(text, { chatId, userId, messageId: msg.message_id });
    if (res?.text) await tg.sendMessage(chatId, res.text, { keyboard: res.keyboard });
    for (const file of res?.files ?? []) {
      try {
        await tg.sendDocument(chatId, file, 'Выгрузка задач');
      } catch (e) {
        log.warn('sendDocument: ' + e.message);
      }
    }
    return;
  }

  // --- нажатия на кнопки ----------------------------------------------------
  const cb = update.callback_query;
  if (cb) {
    const chatId = cb.message?.chat?.id;
    const userId = cb.from?.id;
    try {
      const res = await bot.callback(cb.data, { chatId, userId });
      await tg.answerCallbackQuery(cb.id, 'Готово');
      if (res?.text) {
        await tg.sendMessage(chatId, res.text, { keyboard: res.keyboard });
      }
    } catch (e) {
      await tg.answerCallbackQuery(cb.id, 'Ошибка');
      log.error('callback: ' + (e?.stack ?? e));
    }
  }
}

main().catch((e) => {
  log.error(e?.stack ?? e);
  process.exit(1);
});
