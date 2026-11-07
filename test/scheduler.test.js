import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/scheduler.js';
import { splitMessage } from '../src/telegram.js';
import { zonedTimeToUtc, zonedParts, addDays, addMonths, humanDate, humanDateLong } from '../src/util.js';

const cfg = {
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

/** Часовой пояс Екатеринбурга — UTC+5 без перехода на летнее время. */
test('настенное время переводится в UTC верно', () => {
  const d = zonedTimeToUtc('2026-11-06', '09:00', 'Asia/Yekaterinburg');
  assert.equal(d.toISOString(), '2026-11-06T04:00:00.000Z');
});

test('zonedParts читает дату/время в нужной зоне', () => {
  const p = zonedParts(new Date('2026-11-06T20:30:00Z'), 'Asia/Yekaterinburg');
  assert.equal(p.date, '2026-11-07', '20:30 UTC = 01:30 следующего дня в Екатеринбурге');
  assert.equal(p.time, '01:30');
});

test('календарная арифметика', () => {
  assert.equal(addDays('2026-11-06', 1), '2026-11-07');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(humanDate('2026-11-06'), 'пт, 06.11.2026');
  assert.equal(humanDateLong('2026-11-06'), '6 ноября');
});

function stubStore(overrides = {}) {
  const state = { sent: 0 };
  const base = {
    allChatsWithDigest: () => [
      { chat_id: 1, tz: 'Asia/Yekaterinburg', digest_time: overrides.digestTime ?? '00:00', digest_enabled: 1 },
    ],
    digestSentAt: () => overrides.sentAt ?? null,
    markDigestSent: () => {
      state.sent += 1;
    },
    ensureSettings: () => ({
      chat_id: 1,
      tz: 'Asia/Yekaterinburg',
      digest_time: overrides.digestTime ?? '00:00',
      city: 'Екатеринбург',
      lat: 56.8,
      lon: 60.6,
    }),
    listTasks: () => [],
    getArea: () => null,
    alertIsNew: () => true,
    markAlert: () => {},
    clearOldAlerts: () => 0,
    getForecast: () => null,
    saveForecast: () => {},
  };
  return { store: { ...base, ...overrides }, state };
}

/** Время в зоне Екатеринбурга в формате ЧЧ:ММ, со сдвигом в минутах. */
function tzTime(offsetMin = 0) {
  const p = zonedParts(new Date(Date.now() + offsetMin * 60000), 'Asia/Yekaterinburg');
  return p.time;
}

test('сводка отправляется, когда время уже прошло (в пределах окна)', async () => {
  const sent = [];
  // Целевое время — 30 минут назад: попадает в окно догоняющей отправки.
  const { store, state } = stubStore({ digestTime: tzTime(-30) });
  const s = new Scheduler({ store, cfg, send: async (id, text) => sent.push({ id, text }), logger: {} });
  await s.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, 1);
  assert.match(sent[0].text, /Сводка на/);
  assert.equal(state.sent, 1, 'отмечено как отправленное');
});

test('сводка не отправляется дважды в день', async () => {
  const sent = [];
  const { store } = stubStore({ digestTime: tzTime(-30), sentAt: new Date().toISOString() });
  const s = new Scheduler({ store, cfg, send: async (id, text) => sent.push(text), logger: {} });
  await s.tick();
  assert.equal(sent.length, 0);
});

test('сводка не отправляется раньше времени', async () => {
  const sent = [];
  const { store } = stubStore({ digestTime: tzTime(60) });
  const s = new Scheduler({ store, cfg, send: async (id, text) => sent.push(text), logger: {} });
  await s.tick();
  assert.equal(sent.length, 0, 'время ещё не наступило');
});

test('пропущенная давно сводка не отправляется (вне окна 3 ч)', async () => {
  const sent = [];
  const { store } = stubStore({ digestTime: tzTime(-60 * 5) });
  const s = new Scheduler({ store, cfg, send: async (id, text) => sent.push(text), logger: {} });
  await s.tick();
  assert.equal(sent.length, 0);
});

test('splitMessage режет длинный текст по границам строк', () => {
  const line = 'x'.repeat(100);
  const text = Array.from({ length: 100 }, () => line).join('\n');
  const parts = splitMessage(text, 1000);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 1000);
  assert.equal(parts.join('\n').replace(/\s+/g, ''), text.replace(/\s+/g, ''));
});

test('splitMessage не трогает короткий текст', () => {
  assert.deepEqual(splitMessage('привет', 100), ['привет']);
});
