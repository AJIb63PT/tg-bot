import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDay, describeCode, geocode, fetchForecast } from '../src/weather.js';

const th = { frostThresholdC: 0, windThresholdKmh: 40, rainThresholdMm: 1 };

test('мороз ниже порога → предупреждение', () => {
  const w = evaluateDay({ day: '2026-11-06', tmin: -3, tmax: 2, wind: 10, precip: 0, code: 3 }, th);
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, 'frost');
  assert.equal(w[0].severity, 'medium');
});

test('сильный мороз → высокий уровень', () => {
  const w = evaluateDay({ day: '2026-11-06', tmin: -15, tmax: -8, wind: 5, precip: 0, code: 71 }, th);
  const frost = w.find((x) => x.kind === 'frost');
  assert.equal(frost.severity, 'high');
});

test('порог мороза настраивается', () => {
  const day = { day: '2026-11-06', tmin: -3, tmax: 2, wind: 0, precip: 0, code: 0 };
  assert.equal(evaluateDay(day, th).length, 1);
  assert.equal(evaluateDay(day, { ...th, frostThresholdC: -5 }).length, 0);
});

test('сильный ветер и дождь', () => {
  const w = evaluateDay({ day: '2026-11-06', tmin: 5, tmax: 9, wind: 55, precip: 12, code: 65 }, th);
  assert.equal(w.find((x) => x.kind === 'wind').severity, 'medium');
  assert.equal(w.find((x) => x.kind === 'rain').severity, 'high');
  assert.match(w.find((x) => x.kind === 'rain').text, /сильный дождь/);
});

test('хорошая погода — нет предупреждений', () => {
  const w = evaluateDay({ day: '2026-11-06', tmin: 8, tmax: 15, wind: 12, precip: 0, code: 1 }, th);
  assert.deepEqual(w, []);
});

test('осадки ниже порога, но мокрый код — мягкое предупреждение', () => {
  const w = evaluateDay({ day: '2026-11-06', tmin: 3, tmax: 6, wind: 5, precip: 0.4, code: 61 }, th);
  assert.equal(w.length, 1);
  assert.equal(w[0].severity, 'medium');
});

test('коды WMO переводятся на русский', () => {
  assert.equal(describeCode(0), 'ясно');
  assert.equal(describeCode(65), 'сильный дождь');
  assert.equal(describeCode(95), 'гроза');
  assert.match(describeCode(1234), /код 1234/);
});

// Сетевые тесты — только когда они явно разрешены (npm run test:net).
test('Open-Meteo: геокодинг и прогноз (сеть)', { skip: process.env.TEST_NET !== '1' }, async () => {
  const g = await geocode('Екатеринбург');
  assert.ok(g && g.lat > 50 && g.lon > 50, 'координаты получены');
  const f = await fetchForecast({ lat: g.lat, lon: g.lon, tz: g.timezone, days: 3 });
  assert.equal(f.length, 3);
  assert.ok(typeof f[0].tmin === 'number');
  assert.ok(typeof f[0].wind === 'number');
});
