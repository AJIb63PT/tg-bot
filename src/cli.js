#!/usr/bin/env node
/**
 * CLI для проверки логики без Telegram.
 *
 *   npm run parse -- "Покраска, заказ 123, срок пятница, ответственный Иван"
 *   npm run summary
 *   npm run weather
 *   npm run digest
 *   npm run list
 *   npm run export
 *   node src/cli.js add "текст задачи"
 *   node src/cli.js demo            — наполняет демо-базу и показывает сводку
 *   node src/cli.js bot             — то же, что npm start
 */

import process from 'node:process';
import { loadConfig, demoDbPath } from './config.js';
import { Store } from './db.js';
import { parseMessage } from './parse.js';
import { addTasksFromText, buildDigest, summaryText, taskLine, writeCSV } from './service.js';
import { fetchForecast, geocode, formatDayLine, evaluateDay, SEVERITY_ICON } from './weather.js';
import { nowISO } from './util.js';

const CLI_CHAT_ID = Number(process.env.CLI_CHAT_ID ?? 1);

function log(...a) {
  console.log(...a);
}

function openStore(cfg) {
  return new Store(cfg.dbPath);
}

function ctxOf(store, cfg, overrideToday = null) {
  const settings = store.ensureSettings(CLI_CHAT_ID, cfg);
  return {
    today: overrideToday ?? nowISO(settings.tz),
    knownAreas: store.listAreas(CLI_CHAT_ID),
    knownAssignees: [
      ...new Set(store.listTasks({ status: 'all', limit: 500 }).map((t) => t.assignee).filter(Boolean)),
    ],
    cfg,
  };
}

async function main() {
  const cfg = loadConfig();
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = rest.join(' ');

  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      log(
        [
          'Команды:',
          '  parse "<текст>"   разобрать текст и показать поля (не сохраняя)',
          '  add "<текст>"     добавить задачу в базу',
          '  list [N]          список активных задач',
          '  summary           сводка (как утренняя, без погоды)',
          '  digest            полная сводка с погодой',
          '  weather [дней]    прогноз по городу по умолчанию',
          '  geo "<город>"     проверить геокодинг',
          '  export            выгрузить CSV',
          '  demo              заполнить демо-данными и показать сводку',
          '  scheduler         показать, когда сработает утренняя сводка',
          '  bot               запустить бота (нужен BOT_TOKEN)',
        ].join('\n'),
      );
      return;

    case 'parse': {
      const store = openStore(cfg);
      const ctx = ctxOf(store, cfg);
      const parsed = parseMessage(arg, ctx);
      parsed.forEach((p, i) => {
        log(`--- задача ${i + 1} ---`);
        log(JSON.stringify(
          {
            area: p.area,
            orderNo: p.orderNo,
            dueDate: p.dueDate,
            dueTime: p.dueTime,
            assignee: p.assignee,
            title: p.title,
            workType: p.workType,
            weatherCheck: p.weatherCheck,
            status: p.status,
            warnings: p.warnings,
          },
          null,
          2,
        ));
      });
      store.close();
      return;
    }

    case 'add': {
      const store = openStore(cfg);
      const { tasks, warnings } = addTasksFromText(store, CLI_CHAT_ID, arg, cfg);
      const today = nowISO(store.ensureSettings(CLI_CHAT_ID, cfg).tz);
      for (const t of tasks) {
        log(`${t.code}: ${taskLine(t, today)}`);
      }
      if (warnings.length) log('⚠️  ' + warnings.join('\n⚠️  '));
      store.close();
      return;
    }

    case 'list': {
      const store = openStore(cfg);
      const n = Number(rest[0]) || 50;
      const today = nowISO(store.ensureSettings(CLI_CHAT_ID, cfg).tz);
      const tasks = store.listTasks({ status: 'open', limit: n });
      tasks.forEach((t, i) => log(taskLine(t, today, i + 1) + '\n'));
      log(`Всего: ${tasks.length}`);
      store.close();
      return;
    }

    case 'summary': {
      const store = openStore(cfg);
      const today = nowISO(store.ensureSettings(CLI_CHAT_ID, cfg).tz);
      log(summaryText(store.listTasks({ status: 'open', limit: 500 }), today));
      store.close();
      return;
    }

    case 'digest': {
      const store = openStore(cfg);
      const { text } = await buildDigest(store, CLI_CHAT_ID, cfg);
      log(text);
      store.close();
      return;
    }

    case 'weather': {
      const store = openStore(cfg);
      const settings = store.ensureSettings(CLI_CHAT_ID, cfg);
      const days = Number(rest[0]) || 5;
      const forecast = await fetchForecast({
        lat: settings.lat ?? cfg.weather.defaultLat,
        lon: settings.lon ?? cfg.weather.defaultLon,
        tz: settings.tz,
        days,
      });
      store.saveForecast(CLI_CHAT_ID, settings.lat, settings.lon, forecast);
      const th = {
        frostThresholdC: cfg.weather.frostThresholdC,
        windThresholdKmh: cfg.weather.windThresholdKmh,
        rainThresholdMm: cfg.weather.rainThresholdMm,
      };
      log(`Прогноз: ${settings.city} (${settings.lat}, ${settings.lon})`);
      for (const d of forecast) {
        const w = evaluateDay(d, th);
        log(`${w.map((x) => SEVERITY_ICON[x.severity]).join('') || '  '} ${d.day} — ${formatDayLine(d)}${w.length ? ' :: ' + w.map((x) => x.text).join('; ') : ''}`);
      }
      store.close();
      return;
    }

    case 'geo': {
      const g = await geocode(arg);
      log(g ? JSON.stringify(g, null, 2) : 'не найдено');
      return;
    }

    case 'export': {
      const store = openStore(cfg);
      const tasks = store.listTasks({ status: 'all', limit: 1000 });
      const file = writeCSV(tasks);
      log(`Экспортировано ${tasks.length} задач → ${file}`);
      store.close();
      return;
    }

    case 'demo': {
      // ВАЖНО: демо пишет в отдельную базу, чтобы не засорять рабочие данные,
      // даже если рядом лежит .env с настоящим DB_PATH.
      const demoCfg = { ...cfg, dbPath: demoDbPath(cfg) };
      const store = new Store(demoCfg.dbPath);
      log(`Демо-база: ${demoCfg.dbPath}`);
      log('(рабочая база не затрагивается)\n');
      const today = nowISO(store.ensureSettings(CLI_CHAT_ID, demoCfg).tz);
      const samples = [
        `Монтаж опалубки, участок Цех 2, заказ 451, срок сегодня, ответственный Иван`,
        `Покраска металлоконструкций, участок Цех 2, заказ 452, срок пятница, ответственный Иван`,
        `Монтаж кровли, участок Склад, заказ 455, срок через 2 дня, ответственный Петров`,
        `Замена подшипника, участок Цех 1, заказ 458, срок завтра, ответственный Сидоров`,
        `Сварка каркаса, участок Склад, заказ 460, срок через 5 дней, ответственный Петров`,
      ];
      for (const s of samples) {
        const { tasks } = addTasksFromText(store, CLI_CHAT_ID, s, demoCfg);
        for (const t of tasks) log(`+ ${t.code} ${t.title} [${t.area}] ${t.due_date}`);
      }
      log('');
      const { text } = await buildDigest(store, CLI_CHAT_ID, demoCfg);
      log(text);
      store.close();
      return;
    }

    case 'scheduler': {
      const store = openStore(cfg);
      const today = nowISO(store.ensureSettings(CLI_CHAT_ID, cfg).tz);
      log(`Сегодня: ${today} (${cfg.tz}), время сводки: ${cfg.digestTime}`);
      log(`Сводка уже отправлена сегодня: ${store.digestSentAt(CLI_CHAT_ID, today) ?? 'нет'}`);
      log('Планировщик проверяет время каждую минуту и «догоняет» пропущенный запуск в течение 3 часов.');
      store.close();
      return;
    }

    case 'bot': {
      const { spawn } = await import('node:child_process');
      const child = spawn(process.execPath, ['src/index.js'], { stdio: 'inherit' });
      child.on('exit', (code) => process.exit(code ?? 0));
      return;
    }

    default:
      log(`Неизвестная команда: ${cmd}. Запустите без аргументов для справки.`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e?.stack ?? e);
  process.exit(1);
});
