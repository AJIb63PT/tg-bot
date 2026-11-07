import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Минимальный парсер .env — без зависимостей. */
export function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

const num = (v, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

/**
 * Путь к демонстрационной базе. Специально НЕ совпадает с рабочей:
 * `npm run demo` не должен засорять боевые данные.
 */
export function demoDbPath(cfg, env = process.env) {
  const rel = env.DEMO_DB_PATH ?? './data/demo.db';
  const resolved = path.resolve(ROOT, rel);
  if (resolved === cfg.dbPath) {
    throw new Error(
      'Демо-база совпадает с рабочей (DEMO_DB_PATH == DB_PATH). ' +
        'Это привело бы к записи демо-данных в рабочие. Укажите другой файл.',
    );
  }
  return resolved;
}

const list = (v) =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function loadConfig() {
  loadDotEnv();

  const cfg = {
    botToken: (process.env.BOT_TOKEN ?? '').trim(),
    allowedUserIds: list(process.env.ALLOWED_USER_IDS).map(Number).filter(Number.isFinite),
    tz: (process.env.TZ ?? 'Asia/Yekaterinburg').trim(),
    digestTime: (process.env.DIGEST_TIME ?? '09:00').trim(),
    locale: (process.env.LOCALE ?? 'ru').trim(),
    dbPath: path.resolve(ROOT, process.env.DB_PATH ?? './data/bot.db'),
    weather: {
      defaultLat: num(process.env.DEFAULT_LAT, 56.8389),
      defaultLon: num(process.env.DEFAULT_LON, 60.6057),
      defaultCity: (process.env.DEFAULT_CITY ?? 'Екатеринбург').trim(),
      frostThresholdC: num(process.env.FROST_THRESHOLD_C, 0),
      windThresholdKmh: num(process.env.WIND_THRESHOLD_KMH, 40),
      rainThresholdMm: num(process.env.RAIN_THRESHOLD_MM, 1),
      workTypes: list(process.env.WEATHER_WORKTYPES).map((s) => s.toLowerCase()),
    },
  };

  if (cfg.allowedUserIds.length === 0) {
    const raw = list(process.env.ALLOWED_USER_IDS);
    if (raw.length > 0) {
      throw new Error('ALLOWED_USER_IDS содержит нечисловые значения: ' + raw.join(', '));
    }
  }
  if (!/^\d{1,2}:\d{2}$/.test(cfg.digestTime)) {
    throw new Error(`DIGEST_TIME должен быть в формате ЧЧ:ММ, получено: ${cfg.digestTime}`);
  }
  try {
    new Intl.DateTimeFormat('ru', { timeZone: cfg.tz });
  } catch {
    throw new Error(`Неизвестный часовой пояс TZ=${cfg.tz}`);
  }
  return cfg;
}
