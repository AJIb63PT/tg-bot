/**
 * Open-Meteo: прогноз погоды без API-ключа.
 *   Геокодинг:  https://geocoding-api.open-meteo.com/v1/search
 *   Прогноз:    https://api.open-meteo.com/v1/forecast
 */

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const TIMEOUT_MS = 12000;

const WMO = {
  0: 'ясно',
  1: 'преимущественно ясно',
  2: 'переменная облачность',
  3: 'пасмурно',
  45: 'туман',
  48: 'изморозь',
  51: 'слабая морось',
  53: 'морось',
  55: 'сильная морось',
  56: 'ледяная морось',
  57: 'сильная ледяная морось',
  61: 'небольшой дождь',
  63: 'дождь',
  65: 'сильный дождь',
  66: 'ледяной дождь',
  67: 'сильный ледяной дождь',
  71: 'небольшой снег',
  73: 'снег',
  75: 'сильный снег',
  77: 'снежные зёрна',
  80: 'небольшие ливни',
  81: 'ливни',
  82: 'сильные ливни',
  85: 'небольшие снегопады',
  86: 'сильные снегопады',
  95: 'гроза',
  96: 'гроза с градом',
  99: 'сильная гроза с градом',
};

export const isWetCode = (code) =>
  (code >= 51 && code <= 67) || (code >= 71 && code <= 77) || (code >= 80 && code <= 86) || code >= 95;

export function describeCode(code) {
  return WMO[code] ?? `код ${code}`;
}

async function getJSON(url) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'user-agent': 'table-gen-bot/1.0 (+telegram task bot)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (e) {
      lastError = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw new Error(`Open-Meteo недоступен: ${lastError?.message ?? lastError}`);
}

/** Поиск координат по названию города/посёлка. */
export async function geocode(name) {
  const url = `${GEO_URL}?name=${encodeURIComponent(name)}&count=1&language=ru&format=json`;
  const data = await getJSON(url);
  const hit = data?.results?.[0];
  if (!hit) return null;
  return {
    name: hit.name,
    admin: hit.admin1 ?? null,
    country: hit.country ?? null,
    lat: hit.latitude,
    lon: hit.longitude,
    timezone: hit.timezone ?? 'UTC',
  };
}

/**
 * Суточный прогноз.
 * @returns {Promise<Array<{day:string,tmin:number,tmax:number,wind:number,precip:number,code:number}>>}
 */
export async function fetchForecast({ lat, lon, tz, days = 5 }) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    daily: 'temperature_2m_min,temperature_2m_max,precipitation_sum,wind_speed_10m_max,weather_code',
    timezone: tz || 'auto',
    forecast_days: String(Math.min(Math.max(days, 1), 16)),
  });
  const data = await getJSON(`${FORECAST_URL}?${params}`);
  const d = data?.daily;
  if (!d?.time) return [];
  return d.time.map((day, i) => ({
    day,
    tmin: d.temperature_2m_min?.[i] ?? null,
    tmax: d.temperature_2m_max?.[i] ?? null,
    wind: d.wind_speed_10m_max?.[i] ?? null,
    precip: d.precipitation_sum?.[i] ?? null,
    code: d.weather_code?.[i] ?? null,
  }));
}

/**
 * Оценка одного дня по порогам.
 * @param {object} day   запись прогноза
 * @param {object} th    {frostThresholdC, windThresholdKmh, rainThresholdMm}
 * @returns {Array<{kind:'frost'|'wind'|'rain', severity:'high'|'medium', text:string}>}
 */
export function evaluateDay(day, th) {
  const out = [];
  if (!day) return out;

  if (day.tmin !== null && day.tmin <= th.frostThresholdC) {
    const hard = day.tmin <= th.frostThresholdC - 10;
    out.push({
      kind: 'frost',
      severity: hard ? 'high' : 'medium',
      text:
        `мороз до ${fmt(day.tmin)} °C` +
        (hard ? ' (сильный мороз)' : ` (порог ${fmt(th.frostThresholdC)} °C)`),
    });
  }

  if (day.wind !== null && day.wind >= th.windThresholdKmh) {
    out.push({
      kind: 'wind',
      severity: day.wind >= th.windThresholdKmh + 20 ? 'high' : 'medium',
      text: `ветер до ${fmt(day.wind)} км/ч (порог ${fmt(th.windThresholdKmh)} км/ч)`,
    });
  }

  const wet = (day.precip ?? 0) >= th.rainThresholdMm;
  const precipText = `осадки ${fmt(day.precip)} мм`;
  if (wet) {
    out.push({
      kind: 'rain',
      severity: (day.precip ?? 0) >= th.rainThresholdMm * 5 ? 'high' : 'medium',
      text: `${precipText}, ${describeCode(day.code)}`,
    });
  } else if (isWetCode(day.code) && (day.precip ?? 0) > 0) {
    out.push({
      kind: 'rain',
      severity: 'medium',
      text: `${describeCode(day.code)}, ${precipText}`,
    });
  }

  return out;
}

/** Погодные предупреждения для конкретной задачи. */
export function taskWeatherWarnings(task, forecast, thresholds) {
  if (!task?.due_date) return [];
  const day = forecast.find((f) => f.day === task.due_date);
  if (!day) {
    return [
      {
        kind: 'info',
        severity: 'low',
        text: `прогноз на ${task.due_date} пока недоступен (Open-Meteo отдаёт ~16 суток)`,
      },
    ];
  }
  return evaluateDay(day, thresholds);
}

export function formatDayLine(day, label = '') {
  if (!day) return '—';
  const parts = [
    `мин ${fmt(day.tmin)} °C`,
    `макс ${fmt(day.tmax)} °C`,
    `ветер ${fmt(day.wind)} км/ч`,
    `осадки ${fmt(day.precip)} мм`,
    describeCode(day.code),
  ];
  return `${label}${parts.join(' · ')}`;
}

export function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const r = Math.round(Number(n) * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

export const SEVERITY_ICON = { high: '🔴', medium: '🟡', low: 'ℹ️' };
