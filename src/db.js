import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tasks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  code              TEXT    NOT NULL UNIQUE,
  area              TEXT    NOT NULL,
  order_no          TEXT,
  title             TEXT    NOT NULL,
  work_type         TEXT,
  assignee          TEXT,
  due_date          TEXT,
  due_time          TEXT,
  status            TEXT    NOT NULL DEFAULT 'open',
  weather_check     INTEGER NOT NULL DEFAULT 0,
  lat               REAL,
  lon               REAL,
  city              TEXT,
  source_chat_id    INTEGER,
  source_message_id INTEGER,
  raw_text          TEXT,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL,
  closed_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_due     ON tasks(status, due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_area    ON tasks(area);
CREATE INDEX IF NOT EXISTS idx_tasks_order   ON tasks(order_no);
CREATE INDEX IF NOT EXISTS idx_tasks_assign  ON tasks(assignee);

CREATE TABLE IF NOT EXISTS chat_settings (
  chat_id        INTEGER PRIMARY KEY,
  tz             TEXT    NOT NULL,
  digest_time    TEXT    NOT NULL,
  digest_enabled INTEGER NOT NULL DEFAULT 1,
  city           TEXT,
  lat            REAL,
  lon            REAL
);

CREATE TABLE IF NOT EXISTS areas (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id       INTEGER NOT NULL,
  name          TEXT    NOT NULL,
  name_key      TEXT    NOT NULL,
  city          TEXT,
  lat           REAL,
  lon           REAL,
  weather_check INTEGER NOT NULL DEFAULT 0,
  UNIQUE (chat_id, name_key)
);

CREATE TABLE IF NOT EXISTS weather_cache (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,
  lat         REAL    NOT NULL,
  lon         REAL    NOT NULL,
  day         TEXT    NOT NULL,
  tmin        REAL,
  tmax        REAL,
  wind        REAL,
  precip      REAL,
  code        INTEGER,
  fetched_at  TEXT    NOT NULL,
  UNIQUE (chat_id, lat, lon, day)
);

CREATE TABLE IF NOT EXISTS digests (
  chat_id     INTEGER NOT NULL,
  digest_date TEXT    NOT NULL,
  sent_at     TEXT    NOT NULL,
  PRIMARY KEY (chat_id, digest_date)
);

CREATE TABLE IF NOT EXISTS alerts (
  chat_id    INTEGER NOT NULL,
  kind       TEXT    NOT NULL,
  alert_date TEXT    NOT NULL,
  ref        TEXT    NOT NULL,
  sent_at    TEXT    NOT NULL,
  PRIMARY KEY (chat_id, kind, alert_date, ref)
);

CREATE TABLE IF NOT EXISTS task_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL,
  payload    TEXT,
  created_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id);
`;

const nowUtc = () => new Date().toISOString();

/**
 * SQLite из коробки умеет LOWER()/LIKE только для ASCII: LOWER('ЦЕХ 2')
 * возвращает 'ЦЕХ 2', поэтому регистронезависимый поиск по русским текстам
 * не работал. Регистрируем свою функцию приведения к нижнему регистру.
 */
export const ruLower = (value) => (value === null || value === undefined ? null : String(value).toLowerCase());

/** Экранирование спецсимволов LIKE (% и _), чтобы поиск по «100%» работал. */
function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const STATUS_LABELS = {
  open: 'в работе',
  done: 'выполнена',
  cancelled: 'отменена',
};

export class Store {
  constructor(file) {    this.file = file;
    if (file !== ':memory:') {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.function('ru_lower', { deterministic: true }, ruLower);
    this.db.exec(SCHEMA);
    this.stmts = prepare(this.db);
    this.#dynamicCache = new Map();
  }

  #dynamicCache;

  #cached(sql) {
    let stmt = this.#dynamicCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.#dynamicCache.set(sql, stmt);
    }
    return stmt;
  }

  close() {
    this.db.close();
  }

  // ---------------------------------------------------------------- задачи --

  nextCode() {
    const row = this.db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM tasks').get();
    return `T-${String(Number(row.n)).padStart(4, '0')}`;
  }

  createTask(t) {
    const ts = nowUtc();
    const code = t.code ?? this.nextCode();
    const info = this.stmts.insertTask.run({
      code,
      area: t.area ?? 'Не указан',
      order_no: t.orderNo ?? null,
      title: t.title ?? '',
      work_type: t.workType ?? null,
      assignee: t.assignee ?? null,
      due_date: t.dueDate ?? null,
      due_time: t.dueTime ?? null,
      status: 'open',
      weather_check: t.weatherCheck ? 1 : 0,
      lat: t.lat ?? null,
      lon: t.lon ?? null,
      city: t.city ?? null,
      source_chat_id: t.chatId ?? null,
      source_message_id: t.messageId ?? null,
      raw_text: t.rawText ?? null,
      created_at: ts,
      updated_at: ts,
    });
    const id = Number(info.lastInsertRowid);
    this.addEvent(id, 'created', t.rawText ?? null);
    return this.getTask(id);
  }

  getTask(id) {
    return this.stmts.getTask.get(Number(id)) ?? null;
  }

  getTaskByCode(code) {
    if (!code) return null;
    const cleaned = String(code).trim().replace(/^#/, '').toUpperCase();
    const withPrefix = /^T-/.test(cleaned) ? cleaned : `T-${cleaned.replace(/^T/, '').padStart(4, '0')}`;
    return (
      this.stmts.getTaskByCode.get(cleaned, cleaned) ??
      this.stmts.getTaskByCode.get(withPrefix, withPrefix) ??
      null
    );
  }

  updateTask(id, patch) {
    const allowed = [
      'area', 'order_no', 'title', 'work_type', 'assignee',
      'due_date', 'due_time', 'status', 'weather_check', 'lat', 'lon', 'city',
    ];
    const entries = Object.entries(patch).filter(
      ([k, v]) => allowed.includes(k) && v !== undefined,
    );
    if (entries.length === 0) return this.getTask(id);
    const setSql = entries.map(([k]) => `${k} = @${k}`).join(', ');
    const params = Object.fromEntries(
      entries.map(([k, v]) => [k, k === 'weather_check' ? (v ? 1 : 0) : v]),
    );
    params.id = Number(id);
    params.updated_at = nowUtc();
    this.db.prepare(`UPDATE tasks SET ${setSql}, updated_at = @updated_at WHERE id = @id`).run(params);
    this.addEvent(id, 'updated', JSON.stringify(patch));
    return this.getTask(id);
  }

  setStatus(id, status) {
    const ts = nowUtc();
    this.db
      .prepare('UPDATE tasks SET status = ?, updated_at = ?, closed_at = ? WHERE id = ?')
      .run(status, ts, status === 'open' ? null : ts, Number(id));
    this.addEvent(id, status === 'open' ? 'reopened' : status, null);
    return this.getTask(id);
  }

  deleteTask(id) {
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(Number(id));
  }

  /**
   * @param {object} f
   *   status: 'open' | 'done' | 'all'
   *   area, assignee, orderNo: подстрока
   *   dueFrom, dueTo: 'YYYY-MM-DD'
   *   overdueBefore: 'YYYY-MM-DD' — только просроченные на эту дату
   *   limit
   */
  listTasks(f = {}) {
    const where = [];
    const p = {};
    const status = f.status ?? 'open';
    if (status !== 'all') {
      where.push('status = @status');
      p.status = status;
    }
    if (f.area) {
      where.push("ru_lower(area) LIKE @area ESCAPE '\\'");
      p.area = `%${escapeLike(ruLower(f.area))}%`;
    }
    if (f.assignee) {
      where.push("ru_lower(COALESCE(assignee, '')) LIKE @assignee ESCAPE '\\'");
      p.assignee = `%${escapeLike(ruLower(f.assignee))}%`;
    }
    if (f.orderNo) {
      where.push("ru_lower(COALESCE(order_no, '')) LIKE @orderNo ESCAPE '\\'");
      p.orderNo = `%${escapeLike(ruLower(f.orderNo))}%`;
    }
    if (f.search) {
      where.push(
        "(ru_lower(title) LIKE @search ESCAPE '\\' OR ru_lower(area) LIKE @search ESCAPE '\\' " +
          "OR ru_lower(COALESCE(order_no, '')) LIKE @search ESCAPE '\\' " +
          "OR ru_lower(COALESCE(assignee, '')) LIKE @search ESCAPE '\\')",
      );
      p.search = `%${escapeLike(ruLower(f.search))}%`;
    }
    if (f.dueFrom) {
      where.push('due_date IS NOT NULL AND due_date >= @dueFrom');
      p.dueFrom = f.dueFrom;
    }
    if (f.dueTo) {
      where.push('due_date IS NOT NULL AND due_date <= @dueTo');
      p.dueTo = f.dueTo;
    }
    if (f.overdueBefore) {
      where.push('due_date IS NOT NULL AND due_date < @overdueBefore');
      p.overdueBefore = f.overdueBefore;
    }
    if (f.dueIsNull) where.push('due_date IS NULL');
    p.limit = Math.min(Number(f.limit ?? 50), 500);

    const sql = `
      SELECT * FROM tasks
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY (due_date IS NULL), due_date ASC, due_time ASC, id ASC
      LIMIT @limit`;
    return this.#cached(sql).all(p);
  }

  /** Задачи, по которым нужен прогноз: открытые, с датой, с включённой проверкой. */
  tasksNeedingWeather({ from, to }) {
    return this.stmts.tasksNeedingWeather.all({ from, to });
  }

  // ------------------------------------------------------------- настройки --

  getSettings(chatId) {
    return this.stmts.getSettings.get(Number(chatId)) ?? null;
  }

  ensureSettings(chatId, cfg) {
    const existing = this.getSettings(chatId);
    if (existing) return existing;
    this.db
      .prepare(
        `INSERT INTO chat_settings (chat_id, tz, digest_time, digest_enabled, city, lat, lon)
         VALUES (?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        Number(chatId),
        cfg.tz,
        cfg.digestTime,
        cfg.weather.defaultCity,
        cfg.weather.defaultLat,
        cfg.weather.defaultLon,
      );
    return this.getSettings(chatId);
  }

  updateSettings(chatId, patch) {
    const allowed = ['tz', 'digest_time', 'digest_enabled', 'city', 'lat', 'lon'];
    const entries = Object.entries(patch).filter(([k, v]) => allowed.includes(k) && v !== undefined);
    if (entries.length === 0) return this.getSettings(chatId);
    const setSql = entries.map(([k]) => `${k} = @${k}`).join(', ');
    const params = Object.fromEntries(
      entries.map(([k, v]) => [k, k === 'digest_enabled' ? (v ? 1 : 0) : v]),
    );
    params.chat_id = Number(chatId);
    this.db.prepare(`UPDATE chat_settings SET ${setSql} WHERE chat_id = @chat_id`).run(params);
    return this.getSettings(chatId);
  }

  allChatsWithDigest() {
    return this.stmts.allChatsWithDigest.all();
  }

  // --------------------------------------------------------------- участки --

  listAreas(chatId) {
    return this.stmts.listAreas.all(Number(chatId));
  }

  /**
   * Участки чата вместе с числом задач — для команды /areas.
   */
  listAreasDetailed(chatId) {
    return this.db
      .prepare(
        `SELECT a.*,
           (SELECT COUNT(*) FROM tasks t
             WHERE t.source_chat_id = a.chat_id AND t.status = 'open'
               AND t.area IS NOT NULL AND ru_lower(t.area) = a.name_key) AS open_tasks,
           (SELECT COUNT(*) FROM tasks t
             WHERE t.source_chat_id = a.chat_id
               AND t.area IS NOT NULL AND ru_lower(t.area) = a.name_key) AS total_tasks
         FROM areas a
         WHERE a.chat_id = ?
         ORDER BY a.name`,
      )
      .all(Number(chatId));
  }

  /**
   * Приводит справочник участков в соответствие с задачами: участок, названный
   * в любой задаче, но отсутствующий в areas, — добавляется.
   *
   * Нужно потому, что до исправления участок заводился только для работ с
   * проверкой погоды, и в базах уже накопились задачи с «висящими» участками.
   * Метод идемпотентен: существующие участки и их флаги не меняются.
   *
   * @returns {number} сколько участков добавлено
   */
  syncAreasFromTasks() {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT source_chat_id AS chat_id, area
           FROM tasks
          WHERE source_chat_id IS NOT NULL
            AND area IS NOT NULL AND TRIM(area) <> '' AND area <> 'Не указан'`,
      )
      .all();
    let added = 0;
    for (const r of rows) {
      const existing = this.stmts.getArea.get(Number(r.chat_id), ruLower(String(r.area).trim()));
      if (!existing) {
        this.upsertArea(r.chat_id, r.area, {});
        added += 1;
      }
    }
    return added;
  }

  getArea(chatId, name) {
    if (!name) return null;
    return this.stmts.getArea.get(Number(chatId), ruLower(String(name).trim())) ?? null;
  }

  upsertArea(chatId, name, patch = {}) {
    const clean = String(name).trim();
    const key = ruLower(clean);
    const existing = this.stmts.getArea.get(Number(chatId), key);
    if (existing) {
      const allowed = ['city', 'lat', 'lon', 'weather_check'];
      const entries = Object.entries(patch).filter(([k, v]) => allowed.includes(k) && v !== undefined);
      if (entries.length) {
        const setSql = entries.map(([k]) => `${k} = @${k}`).join(', ');
        const params = Object.fromEntries(
          entries.map(([k, v]) => [k, k === 'weather_check' ? (v ? 1 : 0) : v]),
        );
        params.id = existing.id;
        this.db.prepare(`UPDATE areas SET ${setSql} WHERE id = @id`).run(params);
      }
      return this.getArea(chatId, clean);
    }
    this.db
      .prepare(
        `INSERT INTO areas (chat_id, name, name_key, city, lat, lon, weather_check)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (chat_id, name_key) DO NOTHING`,
      )
      .run(
        Number(chatId),
        clean,
        key,
        patch.city ?? null,
        patch.lat ?? null,
        patch.lon ?? null,
        patch.weather_check ? 1 : 0,
      );
    return this.getArea(chatId, clean);
  }

  /** Участок по названию из текста (учитывает регистр и частичные совпадения). */
  matchArea(chatId, text) {
    if (!text) return null;
    const needle = ruLower(String(text).trim());
    const areas = this.listAreas(chatId);
    return (
      areas.find((a) => a.name_key === needle) ??
      areas.find((a) => needle.includes(a.name_key)) ??
      areas.find((a) => a.name_key.includes(needle)) ??
      null
    );
  }

  // -------------------------------------------------------------- прогнозы --

  saveForecast(chatId, lat, lon, days) {
    const ts = nowUtc();
    for (const d of days) {
      this.stmts.upsertWeather.run({
        chat_id: Number(chatId),
        lat,
        lon,
        day: d.day,
        tmin: d.tmin ?? null,
        tmax: d.tmax ?? null,
        wind: d.wind ?? null,
        precip: d.precip ?? null,
        code: d.code ?? null,
        fetched_at: ts,
      });
    }
  }

  getForecast(chatId, lat, lon, day, maxAgeMinutes = 180) {
    const row = this.stmts.getWeather.get(Number(chatId), lat, lon, day);
    if (!row) return null;
    const ageMin = (Date.now() - Date.parse(row.fetched_at)) / 60000;
    if (ageMin > maxAgeMinutes) return null;
    return row;
  }

  // ---------------------------------------------------------------- сводка --

  markDigestSent(chatId, dateISO) {
    this.stmts.markDigest.run(Number(chatId), dateISO, nowUtc());
  }

  digestSentAt(chatId, dateISO) {
    return this.stmts.getDigest.get(Number(chatId), dateISO)?.sent_at ?? null;
  }

  // --------------------------------------------------------------- алерты --

  /** true — алерт с таким ключом ещё не отправлялся сегодня. */
  alertIsNew(chatId, kind, dateISO, ref) {
    return !this.stmts.getAlert.get(Number(chatId), kind, dateISO, String(ref));
  }

  markAlert(chatId, kind, dateISO, ref) {
    this.stmts.markAlert.run(Number(chatId), kind, dateISO, String(ref), nowUtc());
  }

  clearOldAlerts(beforeISO) {
    return this.db.prepare('DELETE FROM alerts WHERE alert_date < ?').run(beforeISO).changes;
  }

  // ---------------------------------------------------------------- события --

  addEvent(taskId, kind, payload) {
    this.stmts.addEvent.run(Number(taskId), kind, payload ?? null, nowUtc());
  }

  events(taskId) {
    return this.stmts.listEvents.all(Number(taskId));
  }
}

function prepare(db) {
  return {
    insertTask: db.prepare(`
      INSERT INTO tasks (code, area, order_no, title, work_type, assignee, due_date, due_time,
                         status, weather_check, lat, lon, city, source_chat_id, source_message_id,
                         raw_text, created_at, updated_at)
      VALUES (@code, @area, @order_no, @title, @work_type, @assignee, @due_date, @due_time,
              @status, @weather_check, @lat, @lon, @city, @source_chat_id, @source_message_id,
              @raw_text, @created_at, @updated_at)`),
    getTask: db.prepare('SELECT * FROM tasks WHERE id = ?'),
    getTaskByCode: db.prepare('SELECT * FROM tasks WHERE code = ? OR code = ?'),
    tasksNeedingWeather: db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'open' AND weather_check = 1 AND due_date IS NOT NULL
        AND due_date >= @from AND due_date <= @to`),
    getSettings: db.prepare('SELECT * FROM chat_settings WHERE chat_id = ?'),
    allChatsWithDigest: db.prepare('SELECT * FROM chat_settings WHERE digest_enabled = 1'),
    listAreas: db.prepare('SELECT * FROM areas WHERE chat_id = ? ORDER BY name'),
    getArea: db.prepare('SELECT * FROM areas WHERE chat_id = ? AND name_key = ?'),
    upsertWeather: db.prepare(`
      INSERT INTO weather_cache (chat_id, lat, lon, day, tmin, tmax, wind, precip, code, fetched_at)
      VALUES (@chat_id, @lat, @lon, @day, @tmin, @tmax, @wind, @precip, @code, @fetched_at)
      ON CONFLICT (chat_id, lat, lon, day) DO UPDATE SET
        tmin = excluded.tmin, tmax = excluded.tmax, wind = excluded.wind,
        precip = excluded.precip, code = excluded.code, fetched_at = excluded.fetched_at`),
    getWeather: db.prepare(
      'SELECT * FROM weather_cache WHERE chat_id = ? AND lat = ? AND lon = ? AND day = ?',
    ),
    markDigest: db.prepare(`
      INSERT INTO digests (chat_id, digest_date, sent_at) VALUES (?, ?, ?)
      ON CONFLICT (chat_id, digest_date) DO UPDATE SET sent_at = excluded.sent_at`),
    getDigest: db.prepare('SELECT * FROM digests WHERE chat_id = ? AND digest_date = ?'),
    getAlert: db.prepare(
      'SELECT * FROM alerts WHERE chat_id = ? AND kind = ? AND alert_date = ? AND ref = ?',
    ),
    markAlert: db.prepare(`
      INSERT INTO alerts (chat_id, kind, alert_date, ref, sent_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (chat_id, kind, alert_date, ref) DO UPDATE SET sent_at = excluded.sent_at`),
    addEvent: db.prepare(
      'INSERT INTO task_events (task_id, kind, payload, created_at) VALUES (?, ?, ?, ?)',
    ),
    listEvents: db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY id'),
  };
}

export { STATUS_LABELS };
