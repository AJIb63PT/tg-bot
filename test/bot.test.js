import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { Bot } from '../src/commands.js';

const CHAT = 555;

function makeBot(overrides = {}) {
  const cfg = {
    tz: 'Asia/Yekaterinburg',
    digestTime: '09:00',
    allowedUserIds: [],
    weather: {
      defaultCity: 'Екатеринбург',
      defaultLat: 56.8,
      defaultLon: 60.6,
      frostThresholdC: 0,
      windThresholdKmh: 40,
      rainThresholdMm: 1,
      workTypes: ['монтаж', 'кровля', 'сварка', 'бетон'],
    },
    ...overrides,
  };
  const store = new Store(':memory:');
  const bot = new Bot({ store, cfg, logger: { warn() {}, info() {}, error() {} } });
  return { store, bot, cfg };
}

const send = (bot, text) => bot.handle(text, { chatId: CHAT, userId: 1 });

test('обычное сообщение создаёт задачу и отвечает кодом', async () => {
  const { bot, store } = makeBot();
  const res = await send(bot, 'Покраска, заказ 123, срок пятница, ответственный Иван');
  assert.match(res.text, /T-0001/);
  assert.match(res.text, /Покраска/);
  assert.match(res.text, /Иван/);
  assert.equal(store.listTasks({ status: 'open' }).length, 1);
  assert.ok(res.keyboard?.inline_keyboard?.length, 'есть кнопки действий');
  store.close();
});

test('/add работает так же, как обычное сообщение', async () => {
  const { bot, store } = makeBot();
  const res = await send(bot, '/add Монтаж опалубки, заказ 777, срок завтра, ответственный Петров');
  assert.match(res.text, /T-0001/);
  assert.match(res.text, /проверю погоду/, 'для монтажа включена погодная проверка');
  assert.equal(store.getTaskByCode('T-0001').weather_check, 1);
  store.close();
});

test('/done переводит задачу в выполненные и убирает из активных', async () => {
  const { bot, store } = makeBot();
  await send(bot, 'Покраска, заказ 1, срок завтра, ответственный Иван');
  const res = await send(bot, '/done T-0001');
  assert.match(res.text, /Выполнена/i);
  assert.equal(store.getTaskByCode('T-0001').status, 'done');
  assert.equal(store.listTasks({ status: 'open' }).length, 0);
  store.close();
});

test('/undone возвращает задачу в работу', async () => {
  const { bot, store } = makeBot();
  await send(bot, 'Покраска, заказ 1, срок завтра, ответственный Иван');
  await send(bot, '/done T-0001');
  await send(bot, '/undone T-0001');
  assert.equal(store.getTaskByCode('T-0001').status, 'open');
  store.close();
});

test('/due меняет срок на естественный язык', async () => {
  const { bot, store } = makeBot();
  await send(bot, 'Покраска, заказ 1, срок завтра, ответственный Иван');
  await send(bot, '/due T-0001 через 3 дня');
  const t = store.getTaskByCode('T-0001');
  const today = bot.today(CHAT);
  const expected = new Date(Date.parse(`${today}T00:00:00Z`) + 3 * 86400000).toISOString().slice(0, 10);
  assert.equal(t.due_date, expected);
  store.close();
});

test('/assign и /setarea обновляют поля', async () => {
  const { bot, store } = makeBot();
  await send(bot, 'Покраска, заказ 1, срок завтра, ответственный Иван');
  await send(bot, '/assign T-0001 Сидоров');
  await send(bot, '/setarea T-0001 Цех 7');
  const t = store.getTaskByCode('T-0001');
  assert.equal(t.assignee, 'Сидоров');
  assert.equal(t.area, 'Цех 7');
  store.close();
});

test('неизвестный код даёт понятную ошибку, а не падение', async () => {
  const { bot, store } = makeBot();
  const res = await send(bot, '/done T-9999');
  assert.match(res.text, /не найдена/i);
  store.close();
});

test('несколько строк создают несколько задач', async () => {
  const { bot, store } = makeBot();
  const res = await send(
    bot,
    'Покраска, заказ 1, срок завтра, ответственный Иван\nСварка, заказ 2, срок пятница, ответственный Петров',
  );
  assert.match(res.text, /Добавлено задач: <b>2<\/b>/);
  assert.equal(store.listTasks({ status: 'open' }).length, 2);
  store.close();
});

test('/areas на пустой базе подсказывает, как создать участок', async () => {
  const { bot, store } = makeBot();
  const res = await send(bot, '/areas');
  assert.match(res.text, /Участков пока нет/);
  assert.match(res.text, /участок ФФ1/, 'подсказка показывает пример');
  store.close();
});

// Команды управления погодой удалены — бот не должен на них реагировать.
test('удалённые погодные команды больше не существуют', async () => {
  const { bot, store } = makeBot();
  for (const cmd of ['/addarea Цех 2 | Екатеринбург', '/weatherarea Склад on', '/setcity Москва', '/weather', '/thresholds', '/threshold frost -5']) {
    const res = await send(bot, cmd);
    assert.match(res.text, /Неизвестная команда/, `${cmd} должна быть неизвестна`);
  }
  assert.equal(store.listAreas(CHAT).length, 0, 'ничего не создалось');
  store.close();
});

// Регрессия: «участок ФФ1» в конце сообщения не попадал в справочник, потому что
// участок заводился только для работ с погодной проверкой.
test('участок из сообщения попадает в справочник даже без проверки погоды', async () => {
  const { bot, store } = makeBot();
  await send(bot, 'Покраска, заказ 123, срок пятница, ответственный Иван, участок ФФ1');

  const task = store.getTaskByCode('T-0001');
  assert.equal(task.area, 'ФФ1', 'участок попал в задачу');

  const areas = store.listAreas(CHAT);
  assert.equal(areas.length, 1, 'участок заведён в справочник');
  assert.equal(areas[0].name, 'ФФ1');
  assert.equal(areas[0].weather_check, 0, 'для покраски погодный контроль не нужен');

  const res = await send(bot, '/areas');
  assert.match(res.text, /ФФ1/, '/areas показывает участок');
  assert.doesNotMatch(res.text, /Участков пока нет/);
  store.close();
});

test('после регистрации участок узнаётся без метки в следующем сообщении', async () => {
  const { bot, store } = makeBot();
  await send(bot, 'Покраска, заказ 123, срок пятница, ответственный Иван, участок ФФ1');
  await send(bot, 'Покраска, заказ 124, срок пятница, ответственный Иван, ФФ1');

  const second = store.getTaskByCode('T-0002');
  assert.equal(second.area, 'ФФ1', 'участок узнан без метки');
  assert.ok(!second.title.includes('ФФ1'), 'участок не остался в названии: ' + second.title);
  store.close();
});

test('повторный текст не сбрасывает погодный флаг участка', async () => {
  const { bot, store } = makeBot();
  await send(bot, 'Монтаж, участок Склад, заказ 1, срок завтра, ответственный Иван');
  assert.equal(store.getArea(CHAT, 'Склад').weather_check, 1);

  await send(bot, 'Покраска, участок Склад, заказ 2, срок завтра, ответственный Иван');
  assert.equal(store.getArea(CHAT, 'Склад').weather_check, 1, 'флаг сохранён');
  store.close();
});

test('название задачи очищается от осиротевших запятых', async () => {
  const { bot, store } = makeBot();
  await send(bot, 'Покраска, заказ 123, срок пятница, ответственный Иван, участок ФФ1');
  const task = store.getTaskByCode('T-0001');
  assert.equal(task.title, 'Покраска');
  assert.ok(!/,\s*,/.test(task.title), 'нет двойных запятых: ' + task.title);
  store.close();
});

// Регрессия: /areas показывал только справочник, и участки из старых задач
// (созданных до исправления) в нём не появлялись.
test('/areas показывает участки из уже созданных задач', async () => {
  const { bot, store } = makeBot();
  // Имитируем «старые» данные: задачи есть, справочник пуст.
  store.createTask({ title: 'Покраска', area: 'ФФ1', chatId: CHAT, dueDate: '2026-11-07' });
  store.createTask({ title: 'Покраска', area: 'ФФ12', chatId: CHAT, dueDate: '2026-11-08' });
  assert.equal(store.listAreas(CHAT).length, 0, 'справочник пуст до вызова');

  const res = await send(bot, '/areas');
  assert.match(res.text, /ФФ1/);
  assert.match(res.text, /ФФ12/);
  assert.match(res.text, /Участки<\/b> \(2\)/);
  store.close();
});

test('/areas показывает число задач по каждому участку', async () => {
  const { bot, store } = makeBot();
  await send(bot, 'Покраска, заказ 1, срок завтра, ответственный Иван, участок ФФ1');
  await send(bot, 'Сварка, заказ 2, срок завтра, ответственный Петров, участок ФФ1');
  const res = await send(bot, '/areas');
  assert.match(res.text, /в работе/, 'видно количество задач');
  store.close();
});

test('/areas не сбрасывает погодный флаг участка', async () => {
  const { bot, store } = makeBot();
  await send(bot, 'Монтаж, заказ 1, срок завтра, ответственный Иван, участок Склад');
  assert.equal(store.getArea(CHAT, 'Склад').weather_check, 1);
  await send(bot, '/areas');
  assert.equal(store.getArea(CHAT, 'Склад').weather_check, 1, 'флаг сохранён после /areas');
  store.close();
});

test('/digest on|off и время', async () => {
  const { bot, store } = makeBot();
  await send(bot, '/digest off');
  assert.equal(store.getSettings(CHAT).digest_enabled, 0);
  const res = await send(bot, '/digest 08:30');
  assert.match(res.text, /08:30/);
  assert.equal(store.getSettings(CHAT).digest_time, '08:30');
  store.close();
});

test('/today и /overdue фильтруют правильно', async () => {
  const { bot, store } = makeBot();
  const today = bot.today(CHAT);
  store.createTask({ area: 'Цех 1', title: 'Просроченная', dueDate: '2026-01-01' });
  store.createTask({ area: 'Цех 1', title: 'На сегодня', dueDate: today });
  const overdue = await send(bot, '/overdue');
  assert.match(overdue.text, /Просроченная/);
  assert.doesNotMatch(overdue.text, /На сегодня/);
  const todayRes = await send(bot, '/today');
  assert.match(todayRes.text, /На сегодня/);
  store.close();
});

test('/find ищет по заказу и названию', async () => {
  const { bot, store } = makeBot();
  await send(bot, 'Покраска металлоконструкций, заказ 512, срок завтра, ответственный Иван');
  const byOrder = await send(bot, '/find 512');
  assert.match(byOrder.text, /Покраска/);
  const byName = await send(bot, '/find металлоконструкций');
  assert.match(byName.text, /T-0001/);
  const nothing = await send(bot, '/find зебра');
  assert.match(nothing.text, /ничего не найдено/i);
  store.close();
});

test('/card показывает карточку задачи', async () => {
  const { bot, store } = makeBot();
  await send(bot, 'Покраска, заказ 123, срок завтра, ответственный Иван');
  const res = await send(bot, '/card T-0001');
  assert.match(res.text, /Покраска/);
  assert.match(res.text, /123/);
  assert.match(res.text, /Иван/);
  store.close();
});

test('callback «выполнена» и «отложить» работают', async () => {
  const { bot, store } = makeBot();
  await send(bot, 'Покраска, заказ 1, срок завтра, ответственный Иван');
  const id = store.getTaskByCode('T-0001').id;

  const snooze = await bot.callback(`snooze:${id}:7`, { chatId: CHAT, userId: 1 });
  assert.match(snooze.text, /срок/i);
  const shifted = store.getTask(id).due_date;

  const done = await bot.callback(`done:${id}`, { chatId: CHAT, userId: 1 });
  assert.match(done.text, /выполнен/i);
  assert.equal(store.getTask(id).status, 'done');

  const toggle = await bot.callback(`toggle:${id}`, { chatId: CHAT, userId: 1 });
  assert.match(toggle.text, /в работе/);
  assert.equal(store.getTask(id).status, 'open');
  assert.ok(shifted, 'срок был перенесён');
  store.close();
});

test('callback удаления убирает задачу', async () => {
  const { bot, store } = makeBot();
  await send(bot, 'Покраска, заказ 1, срок завтра, ответственный Иван');
  const id = store.getTaskByCode('T-0001').id;
  await bot.callback(`del:${id}`, { chatId: CHAT, userId: 1 });
  assert.equal(store.getTask(id), null);
  store.close();
});

test('/list содержит ровно две кнопки на задачу: «готово» и «перенос»', async () => {
  const { bot } = makeBot();
  await send(bot, 'Покраска, заказ 1, срок завтра, ответственный Иван');
  await send(bot, 'Монтаж, заказ 2, срок завтра, ответственный Петров');

  const rows = (await send(bot, '/list')).keyboard.inline_keyboard;
  assert.equal(rows.length, 2, 'по ряду на задачу');
  for (const row of rows) {
    assert.equal(row.length, 2, 'в ряду ровно две кнопки');
    assert.match(row[0].callback_data, /^done:/);
    assert.match(row[1].callback_data, /^snooze:/);
  }
  const actions = rows.flat().map((b) => b.callback_data.split(':')[0]);
  assert.ok(!actions.includes('card'), 'кнопки карточки в /list больше нет');
});

// Обработчик card: сохранён для совместимости: в истории Telegram остались
// старые сообщения с прежней кнопкой «📄», и она продолжает работать.
test('устаревший callback card: по-прежнему открывает карточку', async () => {
  const { bot, store } = makeBot();
  await send(bot, 'Монтаж кровли, заказ 455, срок завтра, ответственный Петров, участок Склад');
  const id = store.getTaskByCode('T-0001').id;

  const res = await bot.callback(`card:${id}`, { chatId: CHAT, userId: 1 });
  assert.doesNotMatch(res.text, /Неизвестное действие/);
  assert.match(res.text, /T-0001/);
  assert.match(res.text, /Монтаж кровли/);
  assert.match(res.text, /Склад/);
  assert.match(res.text, /455/);
  store.close();
});

test('все кнопки из /list и /card имеют обработчик', async () => {
  const { bot, store } = makeBot();
  await send(bot, 'Монтаж кровли, заказ 455, срок завтра, ответственный Петров, участок Склад');
  const id = store.getTaskByCode('T-0001').id;

  const fromList = (await send(bot, '/list')).keyboard.inline_keyboard.flat();
  const fromCard = (await send(bot, '/card T-0001')).keyboard.inline_keyboard.flat();
  const all = [...fromList, ...fromCard];
  assert.ok(all.length >= 5, 'кнопок достаточно для проверки');

  // «del» и «toggle» меняют состояние, поэтому проверяем все, кроме удаления,
  // и следим, чтобы ни одна не дала «Неизвестное действие».
  for (const b of all) {
    if (b.callback_data.startsWith('del:')) continue;
    const res = await bot.callback(b.callback_data, { chatId: CHAT, userId: 1 });
    assert.doesNotMatch(
      res.text,
      /Неизвестное действие/,
      `кнопка «${b.text}» (${b.callback_data}) не обработана`,
    );
  }

  // Удаление — на копии, чтобы не ломать остальные проверки.
  await bot.callback(`del:${id}`, { chatId: CHAT, userId: 1 });
  assert.equal(store.getTask(id), null, 'кнопка удаления работает');
  store.close();
});

test('кнопка «Все задачи» из карточки возвращает список', async () => {
  const { bot, store } = makeBot();
  await send(bot, 'Покраска, заказ 1, срок завтра, ответственный Иван');
  const res = await bot.callback('list:0', { chatId: CHAT, userId: 1 });
  assert.doesNotMatch(res.text, /Неизвестное действие/);
  assert.match(res.text, /Активные задачи/);
  assert.match(res.text, /T-0001/);
  store.close();
});

test('открыть карточку можно командой /card', async () => {
  const { bot, store } = makeBot();
  await send(bot, 'Покраска, заказ 1, срок завтра, ответственный Иван');
  const viaCommand = await send(bot, '/card T-0001');
  const id = store.getTaskByCode('T-0001').id;
  const viaCallback = await bot.callback(`card:${id}`, { chatId: CHAT, userId: 1 });
  assert.equal(viaCallback.text, viaCommand.text, 'команда и callback дают одно и то же');
  store.close();
});

test('allowlist блокирует посторонних', async () => {
  const { bot, store } = makeBot({ allowedUserIds: [42] });
  const denied = await bot.handle('Покраска', { chatId: 999, userId: 7 });
  assert.match(denied.text, /Доступ закрыт/);
  assert.equal(store.listTasks({ status: 'open' }).length, 0);
  const ok = await bot.handle('Покраска', { chatId: 999, userId: 42 });
  assert.match(ok.text, /T-0001/);
  store.close();
});

test('/help содержит инструкцию и пример', async () => {
  const { bot, store } = makeBot();
  const res = await send(bot, '/help');
  assert.match(res.text, /Покраска, заказ 123, срок пятница, ответственный Иван/);
  assert.match(res.text, /\/digest/);
  store.close();
});

test('неизвестная команда не ломает бота', async () => {
  const { bot, store } = makeBot();
  const res = await send(bot, '/чепуха');
  assert.match(res.text, /Неизвестная команда/);
  store.close();
});

test('/id показывает chat id', async () => {
  const { bot, store } = makeBot();
  const res = await send(bot, '/id');
  assert.match(res.text, /555/);
  store.close();
});
