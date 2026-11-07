import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { tasksToCSV } from '../src/service.js';

function fresh() {
  return new Store(':memory:');
}

test('создание задачи и автокод', () => {
  const s = fresh();
  const a = s.createTask({ title: 'A', area: 'Цех 1' });
  const b = s.createTask({ title: 'B', area: 'Цех 2' });
  assert.equal(a.code, 'T-0001');
  assert.equal(b.code, 'T-0002');
  assert.equal(a.status, 'open');
  s.close();
});

test('поиск по коду в разных форматах', () => {
  const s = fresh();
  const t = s.createTask({ title: 'Покраска' });
  assert.equal(s.getTaskByCode('T-0001').id, t.id);
  assert.equal(s.getTaskByCode('t-0001').id, t.id);
  assert.equal(s.getTaskByCode('#T-0001').id, t.id);
  assert.equal(s.getTaskByCode('0001').id, t.id);
  assert.equal(s.getTaskByCode('1').id, t.id);
  s.close();
});

test('фильтры списка: просрочено / на дату / поиск', () => {
  const s = fresh();
  s.createTask({ title: 'Старая', area: 'Цех 1', dueDate: '2026-11-01' });
  s.createTask({ title: 'Сегодняшняя', area: 'Цех 1', dueDate: '2026-11-06' });
  s.createTask({ title: 'Будущая', area: 'Цех 2', dueDate: '2026-11-20', orderNo: '999' });
  assert.equal(s.listTasks({ overdueBefore: '2026-11-06' }).length, 1);
  assert.equal(s.listTasks({ dueFrom: '2026-11-06', dueTo: '2026-11-06' }).length, 1);
  assert.equal(s.listTasks({ search: '999' }).length, 1);
  assert.equal(s.listTasks({ area: 'цех 2' }).length, 1);
  assert.equal(s.listTasks({ status: 'all' }).length, 3);
  s.close();
});

test('статусы и журнал событий', () => {
  const s = fresh();
  const t = s.createTask({ title: 'X' });
  s.setStatus(t.id, 'done');
  assert.equal(s.getTask(t.id).status, 'done');
  assert.ok(s.getTask(t.id).closed_at);
  s.setStatus(t.id, 'open');
  assert.equal(s.getTask(t.id).closed_at, null);
  const kinds = s.events(t.id).map((e) => e.kind);
  assert.deepEqual(kinds, ['created', 'done', 'reopened']);
  s.close();
});

test('обновление задачи пишет событие', () => {
  const s = fresh();
  const t = s.createTask({ title: 'X' });
  s.updateTask(t.id, { assignee: 'Иван', due_date: '2026-11-10' });
  const updated = s.getTask(t.id);
  assert.equal(updated.assignee, 'Иван');
  assert.equal(updated.due_date, '2026-11-10');
  assert.ok(s.events(t.id).some((e) => e.kind === 'updated'));
  s.close();
});

test('настройки чата создаются однократно', () => {
  const s = fresh();
  const cfg = {
    tz: 'Asia/Yekaterinburg',
    digestTime: '09:00',
    weather: { defaultCity: 'Екатеринбург', defaultLat: 56.8, defaultLon: 60.6 },
  };
  const a = s.ensureSettings(1, cfg);
  const b = s.ensureSettings(1, cfg);
  assert.equal(a.chat_id, b.chat_id);
  s.updateSettings(1, { digest_time: '08:30', digest_enabled: false });
  assert.equal(s.getSettings(1).digest_time, '08:30');
  assert.equal(s.getSettings(1).digest_enabled, 0);
  assert.equal(s.allChatsWithDigest().length, 0);
  s.close();
});

test('участки: upsert, match, погодный флаг', () => {
  const s = fresh();
  s.upsertArea(1, 'Цех 2', { city: 'Екатеринбург', lat: 56.8, lon: 60.6 });
  s.upsertArea(1, 'Цех 2', { weather_check: true });
  const a = s.getArea(1, 'цех 2');
  assert.equal(a.weather_check, 1);
  assert.equal(a.lat, 56.8);
  assert.equal(s.matchArea(1, 'работы в Цех 2 сегодня').name, 'Цех 2');
  assert.equal(s.matchArea(1, 'нет такого'), null);
  s.close();
});

test('погодный кэш: сохранение и устаревание', () => {
  const s = fresh();
  s.saveForecast(1, 56.8, 60.6, [{ day: '2026-11-06', tmin: -5, tmax: 1, wind: 12, precip: 0, code: 3 }]);
  const hit = s.getForecast(1, 56.8, 60.6, '2026-11-06');
  assert.equal(hit.tmin, -5);
  assert.equal(s.getForecast(1, 56.8, 60.6, '2026-11-06', -1), null, 'отрицательный TTL = просрочено');
  s.close();
});

test('отметка «сводка отправлена» идемпотентна', () => {
  const s = fresh();
  assert.equal(s.digestSentAt(1, '2026-11-06'), null);
  s.markDigestSent(1, '2026-11-06');
  assert.ok(s.digestSentAt(1, '2026-11-06'));
  s.markDigestSent(1, '2026-11-06');
  assert.ok(s.digestSentAt(1, '2026-11-06'));
  s.close();
});

test('CSV: BOM, разделитель ;, экранирование кавычек', () => {
  const s = fresh();
  s.createTask({ title: 'Покраска "особая"; срочно', area: 'Цех 1', dueDate: '2026-11-06' });
  const csv = tasksToCSV(s.listTasks({ status: 'all' }));
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('Код;Участок;Заказ'));
  assert.ok(csv.includes('""особая""'));
  assert.equal(csv.split('\r\n').filter(Boolean).length, 2);
  s.close();
});

test('удаление задачи уносит события', () => {
  const s = fresh();
  const t = s.createTask({ title: 'X' });
  s.addEvent(t.id, 'note', 'привет');
  s.deleteTask(t.id);
  assert.equal(s.getTask(t.id), null);
  assert.equal(s.events(t.id).length, 0);
  s.close();
});

test('алерты: уникальность по дню', () => {
  const s = fresh();
  assert.equal(s.alertIsNew(1, 'weather', '2026-11-06', 'T-0001'), true);
  s.markAlert(1, 'weather', '2026-11-06', 'T-0001');
  assert.equal(s.alertIsNew(1, 'weather', '2026-11-06', 'T-0001'), false);
  assert.equal(s.alertIsNew(1, 'weather', '2026-11-07', 'T-0001'), true);
  s.close();
});

// Регрессия: до исправления участок заводился только для работ с проверкой
// погоды, поэтому в базе накапливались задачи с участками вне справочника.
test('syncAreasFromTasks восстанавливает участки, названные только в задачах', () => {
  const s = fresh();
  s.createTask({ title: 'A', area: 'ФФ1', chatId: 7 });
  s.createTask({ title: 'B', area: 'ФФ12', chatId: 7 });
  s.createTask({ title: 'C', area: 'Склад', chatId: 7 });
  s.upsertArea(7, 'Склад', { weather_check: true });

  assert.deepEqual(s.listAreas(7).map((a) => a.name), ['Склад'], 'пока только Склад');

  const added = s.syncAreasFromTasks();
  assert.equal(added, 2, 'добавлены ФФ1 и ФФ12');
  assert.deepEqual(s.listAreas(7).map((a) => a.name).sort(), ['Склад', 'ФФ1', 'ФФ12']);
  assert.equal(s.getArea(7, 'Склад').weather_check, 1, 'флаг погоды сохранён');
  s.close();
});

test('syncAreasFromTasks идемпотентен', () => {
  const s = fresh();
  s.createTask({ title: 'A', area: 'ФФ1', chatId: 7 });
  assert.equal(s.syncAreasFromTasks(), 1);
  assert.equal(s.syncAreasFromTasks(), 0, 'повторно ничего не добавляется');
  assert.equal(s.listAreas(7).length, 1);
  s.close();
});

test('syncAreasFromTasks игнорирует «Не указан» и разные чаты', () => {
  const s = fresh();
  s.createTask({ title: 'A', area: 'Не указан', chatId: 7 });
  s.createTask({ title: 'B', area: 'Цех 9', chatId: 7 });
  s.createTask({ title: 'C', area: 'Цех 9', chatId: 8 });

  assert.equal(s.syncAreasFromTasks(), 2, 'по одному участку на каждый чат');
  assert.deepEqual(s.listAreas(7).map((a) => a.name), ['Цех 9']);
  assert.deepEqual(s.listAreas(8).map((a) => a.name), ['Цех 9']);
  s.close();
});

test('listAreasDetailed считает задачи по участку', () => {
  const s = fresh();
  s.upsertArea(7, 'ФФ1', {});
  const a = s.createTask({ title: 'A', area: 'ФФ1', chatId: 7 });
  s.createTask({ title: 'B', area: 'ФФ1', chatId: 7 });
  s.setStatus(a.id, 'done');

  const [row] = s.listAreasDetailed(7);
  assert.equal(row.name, 'ФФ1');
  assert.equal(row.total_tasks, 2, 'всего задач с этим участком');
  assert.equal(row.open_tasks, 1, 'одна в работе');
  s.close();
});

test('участок сопоставляется без учёта регистра (кириллица)', () => {
  const s = fresh();
  s.upsertArea(7, 'ФФ1', {});
  assert.ok(s.getArea(7, 'фф1'), 'нижний регистр');
  assert.ok(s.getArea(7, 'ФФ1'), 'как записано');
  assert.equal(s.matchArea(7, 'работы на ФФ1 сегодня').name, 'ФФ1');
  s.close();
});
