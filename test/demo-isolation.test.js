import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.js';
import { demoDbPath } from '../src/config.js';
import { addTasksFromText, buildDigest } from '../src/service.js';

const cfgBase = {
  tz: 'Asia/Yekaterinburg',
  digestTime: '09:00',
  weather: {
    defaultCity: 'Екатеринбург',
    defaultLat: 56.8,
    defaultLon: 60.6,
    frostThresholdC: 0,
    windThresholdKmh: 40,
    rainThresholdMm: 1,
    workTypes: ['монтаж'],
  },
};

const SAMPLES = [
  'Монтаж опалубки, участок Цех 2, заказ 451, срок сегодня, ответственный Иван',
  'Покраска металлокаркаса, участок Цех 2, заказ 452, срок пятница, ответственный Иван',
  'Монтаж кровли, участок Склад, заказ 455, срок через 2 дня, ответственный Петров',
  'Замена подшипника, участок Цех 1, заказ 458, срок завтра, ответственный Сидоров',
  'Сварка каркаса, участок Склад, заказ 460, срок через 5 дней, ответственный Петров',
];

/** Воспроизводит наполнение демо-базы без запуска CLI (без подпроцессов). */
function seedDemo(dbPath) {
  const cfg = { ...cfgBase, dbPath };
  const store = new Store(dbPath);
  for (const s of SAMPLES) addTasksFromText(store, 1, s, cfg);
  return store;
}

test('demo использует отдельную базу и не трогает рабочую', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-demo-'));
  const workDb = path.join(tmp, 'work.db');
  const demoDb = path.join(tmp, 'demo.db');

  // «Рабочая» база с пользовательской задачей.
  const seed = new Store(workDb);
  seed.createTask({ title: 'Пользовательская задача', area: 'Цех 9', chatId: 777 });
  seed.close();

  const demo = seedDemo(demoDb);
  const { text } = await buildDigest(demo, 1, { ...cfgBase, dbPath: demoDb });
  const demoTasks = demo.listTasks({ status: 'all' });
  demo.close();

  assert.ok(demoTasks.length >= 5, 'демо-задачи записаны в демо-базу');
  assert.match(text, /Сводка на/);

  const work = new Store(workDb);
  const workTasks = work.listTasks({ status: 'all' });
  work.close();
  assert.equal(workTasks.length, 1, 'в рабочей базе ровно одна — пользовательская');
  assert.equal(workTasks[0].title, 'Пользовательская задача');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('demoDbPath не совпадает с рабочей базой', () => {
  const cfg = { ...cfgBase, dbPath: path.resolve('./data/bot.db') };
  const demo = demoDbPath(cfg, {});
  assert.notEqual(demo, cfg.dbPath);
  assert.match(demo, /demo\.db$/);
});

test('demoDbPath падает, если DEMO_DB_PATH указывает на рабочую базу', () => {
  const cfg = { ...cfgBase, dbPath: path.resolve('./data/bot.db') };
  assert.throws(
    () => demoDbPath(cfg, { DEMO_DB_PATH: './data/bot.db' }),
    /совпадает с рабочей/,
  );
});

test('demoDbPath уважает явный DEMO_DB_PATH', () => {
  const cfg = { ...cfgBase, dbPath: path.resolve('./data/bot.db') };
  const demo = demoDbPath(cfg, { DEMO_DB_PATH: './tmp/my-demo.db' });
  assert.match(demo, /my-demo\.db$/);
});
