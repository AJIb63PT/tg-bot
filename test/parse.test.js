import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTask, parseMessage } from '../src/parse.js';

const cfg = {
  weather: {
    workTypes: ['монтаж', 'кровля', 'бетон', 'фасад', 'сварка'],
    frostThresholdC: 0,
    windThresholdKmh: 40,
    rainThresholdMm: 1,
  },
};
const base = { today: '2026-11-06', knownAreas: [], knownAssignees: [], cfg };

test('разбирает пример из задания', () => {
  const p = parseTask('Покраска, заказ 123, срок пятница, ответственный Иван', base);
  assert.equal(p.orderNo, '123');
  assert.equal(p.dueDate, '2026-11-06', 'сегодня пятница, поэтому срок — 06.11');
  assert.equal(p.assignee, 'Иван');
  assert.equal(p.title, 'Покраска');
  assert.equal(p.area, 'Не указан');
  assert.ok(p.warnings.some((w) => /участок/i.test(w)));
});

test('день недели переносится на следующую неделю, если уже прошёл', () => {
  // 2026-11-06 — пятница; «понедельник» должен стать 09.11, а не 02.11.
  const p = parseTask('Покраска, заказ 123, срок понедельник', base);
  assert.equal(p.dueDate, '2026-11-09');
});

test('участок с меткой и заказ с №', () => {
  const p = parseTask('участок: Цех 2, заказ №451, до 12.11, ответственный Петров', base);
  assert.equal(p.area, 'Цех 2');
  assert.equal(p.orderNo, '451');
  assert.equal(p.dueDate, '2026-11-12');
  assert.equal(p.assignee, 'Петров');
});

test('относительные сроки', () => {
  assert.equal(parseTask('завтра сделать', base).dueDate, '2026-11-07');
  assert.equal(parseTask('сегодня сделать', base).dueDate, '2026-11-06');
  assert.equal(parseTask('послезавтра сделать', base).dueDate, '2026-11-08');
  assert.equal(parseTask('через 3 дня сделать', base).dueDate, '2026-11-09');
  assert.equal(parseTask('через 2 недели', base).dueDate, '2026-11-20');
  assert.equal(parseTask('через месяц', base).dueDate, '2026-12-06');
});

test('сроки «на следующей неделе», «до конца месяца»', () => {
  assert.equal(parseTask('на следующей неделе', base).dueDate, '2026-11-15');
  assert.equal(parseTask('до конца месяца', base).dueDate, '2026-11-30');
  assert.equal(parseTask('в начале месяца', base).dueDate, '2026-11-01');
});

test('дата словом и время', () => {
  const p = parseTask('Монтаж кровли, срок 15 ноября в 14:30, ответственный Петров', base);
  assert.equal(p.dueDate, '2026-11-15');
  assert.equal(p.dueTime, '14:30');
  assert.equal(p.workType, 'монтаж');
  assert.equal(p.weatherCheck, true, 'монтаж требует проверки погоды');
});

test('дата в прошлом → предупреждение', () => {
  const p = parseTask('Уборка, срок 01.11.2026', base);
  assert.equal(p.dueDate, '2026-11-01');
  assert.ok(p.warnings.some((w) => /прошёл/i.test(w)));
});

test('«без срока» не даёт дату', () => {
  const p = parseTask('Разобрать склад, без срока, ответственный Иван', base);
  assert.equal(p.dueDate, null);
});

test('известный участок распознаётся без метки', () => {
  const p = parseTask('Покраска в Цех 2, заказ 9', {
    ...base,
    knownAreas: [{ name: 'Цех 2' }],
  });
  assert.equal(p.area, 'Цех 2');
  assert.equal(p.areaSource, 'match');
  assert.equal(p.title, 'Покраска');
});

test('участок в косвенном падеже сопоставляется со справочником', () => {
  const p = parseTask('Покраска, участок: в цехе 2, заказ 9', {
    ...base,
    knownAreas: [{ name: 'Цех 2' }],
  });
  assert.equal(p.area, 'Цех 2');
});

test('участок без метки вырезается из названия задачи', () => {
  const ctx = { ...base, knownAreas: [{ name: 'ФФ1' }] };

  const plain = parseTask('Покраска, заказ 124, срок пятница, ответственный Иван, ФФ1', ctx);
  assert.equal(plain.area, 'ФФ1');
  assert.equal(plain.title, 'Покраска');
  assert.ok(!plain.title.includes('ФФ1'));

  const withPrep = parseTask('Покраска, заказ 125, срок пятница, ответственный Иван, в ФФ1', ctx);
  assert.equal(withPrep.area, 'ФФ1');
  assert.ok(!withPrep.title.includes('ФФ1'), 'название: ' + withPrep.title);

  const inMiddle = parseTask('Покраска, заказ 126, ФФ1, срок пятница, ответственный Иван', ctx);
  assert.equal(inMiddle.area, 'ФФ1');
  assert.ok(!inMiddle.title.includes('ФФ1'), 'название: ' + inMiddle.title);
  assert.match(inMiddle.title, /Покраска/);
});

test('участок в косвенном падеже вырезается из названия', () => {
  const p = parseTask('Покраска, заказ 200, срок пятница, ответственный Иван, в цехе 2', {
    ...base,
    knownAreas: [{ name: 'Цех 2' }],
  });
  assert.equal(p.area, 'Цех 2');
  assert.equal(p.title, 'Покраска');
});

test('название не содержит осиротевших запятых и предлогов', () => {
  const ctx = { ...base, knownAreas: [{ name: 'ФФ1' }] };
  for (const text of [
    'Покраска, заказ 1, срок завтра, ответственный Иван, участок ФФ1',
    'Монтаж кровли, заказ 2, срок завтра, ответственный Петров, участок ФФ1',
    'Сварка, заказ 3, срок завтра, ответственный Петров, ФФ1',
  ]) {
    const p = parseTask(text, ctx);
    assert.ok(!/,\s*,/.test(p.title), `двойные запятые: ${p.title}`);
    assert.ok(!/^[,\s]|[,\s]$/.test(p.title), `мусор по краям: ${p.title}`);
    assert.ok(!/\s(?:в|на|из|со|для|по)$/i.test(p.title), `предлог в конце: ${p.title}`);
    assert.ok(!p.title.includes('ФФ1'), `участок в названии: ${p.title}`);
  }
});

test('несколько строк = несколько задач', () => {
  const list = parseMessage(
    'Покраска, заказ 1, срок завтра, ответственный Иван\nМонтаж, заказ 2, срок пятница, ответственный Петров',
    base,
  );
  assert.equal(list.length, 2);
  assert.equal(list[0].orderNo, '1');
  assert.equal(list[1].orderNo, '2');
});

test('статус «выполнено» распознаётся', () => {
  const p = parseTask('Покраска, заказ 1, срок сегодня, ответственный Иван, выполнено', base);
  assert.equal(p.status, 'done');
});

test('монтаж включает проверку погоды, уборка — нет', () => {
  assert.equal(parseTask('Монтаж опалубки, срок завтра', base).weatherCheck, true);
  assert.equal(parseTask('Уборка помещения, срок завтра', base).weatherCheck, false);
});
