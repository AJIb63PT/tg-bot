/**
 * Тонкий клиент Telegram Bot API на голом fetch — без npm-зависимостей.
 * Умеет long polling, HTML-разметку, инлайн-кнопки и отправку файлов.
 */

const API = 'https://api.telegram.org';
const MAX_LEN = 4000;

export class Telegram {
  constructor(token, logger = console) {
    if (!token) throw new Error('Не задан BOT_TOKEN');
    this.token = token;
    this.base = `${API}/bot${token}`;
    this.log = logger;
    this.me = null;
  }

  async call(method, payload = {}, { retries = 2, timeoutMs = 30000 } = {}) {
    let attempt = 0;
    for (;;) {
      try {
        const res = await fetch(`${this.base}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const json = await res.json().catch(() => null);
        if (json?.ok) return json.result;

        const code = json?.error_code ?? res.status;
        const desc = json?.description ?? res.statusText;

        // 429 — нас просят подождать.
        if (code === 429 && attempt < retries + 2) {
          const wait = (json?.parameters?.retry_after ?? 3) + 1;
          this.log.warn?.(`Telegram 429: ждём ${wait} с`);
          await sleep(wait * 1000);
          attempt += 1;
          continue;
        }
        // Сетевые/серверные сбои — повторяем.
        if (code >= 500 && attempt < retries) {
          await sleep(1000 * (attempt + 1));
          attempt += 1;
          continue;
        }
        throw new TelegramError(desc, code, method, payload);
      } catch (e) {
        if (e instanceof TelegramError) throw e;
        if (attempt < retries) {
          await sleep(1000 * (attempt + 1));
          attempt += 1;
          continue;
        }
        throw new Error(`Telegram ${method}: ${e.message}`);
      }
    }
  }

  async getMe() {
    this.me = await this.call('getMe');
    return this.me;
  }

  async setMyCommands(commands) {
    return this.call('setMyCommands', { commands });
  }

  /** Отправляет текст, разбивая длинные сообщения по лимиту Telegram. */
  async sendMessage(chatId, text, { keyboard = null, parseMode = 'HTML', disablePreview = true } = {}) {
    const chunks = splitMessage(String(text ?? ''), MAX_LEN);
    const results = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const isLast = i === chunks.length - 1;
      results.push(
        await this.call('sendMessage', {
          chat_id: chatId,
          text: chunks[i],
          parse_mode: parseMode,
          link_preview_options: { is_disabled: disablePreview },
          ...(isLast && keyboard ? { reply_markup: keyboard } : {}),
        }),
      );
    }
    return results[results.length - 1];
  }

  async editMessageText(chatId, messageId, text, { keyboard = null, parseMode = 'HTML' } = {}) {
    return this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: String(text).slice(0, MAX_LEN),
      parse_mode: parseMode,
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  }

  async answerCallbackQuery(id, text = '') {
    return this.call('answerCallbackQuery', { callback_query_id: id, text: text.slice(0, 190) });
  }

  async sendChatAction(chatId, action = 'typing') {
    try {
      return await this.call('sendChatAction', { chat_id: chatId, action }, { retries: 0 });
    } catch {
      return null;
    }
  }

  async sendDocument(chatId, filePath, caption = '') {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const buf = fs.readFileSync(filePath);
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', caption);
    form.append(
      'document',
      new Blob([buf]),
      path.basename(filePath),
    );
    const res = await fetch(`${this.base}/sendDocument`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(60000),
    });
    const json = await res.json().catch(() => null);
    if (!json?.ok) throw new Error(`sendDocument: ${json?.description ?? res.statusText}`);
    return json.result;
  }

  /**
   * Бесконечный long polling.
   * @param {(update:object)=>Promise<void>} onUpdate
   */
  async poll(onUpdate, { signal, timeoutSec = 30 } = {}) {
    let offset = 0;
    // Сбрасываем «зависшие» апдейты, накопившиеся пока бот был выключен.
    try {
      const pending = await this.call('getUpdates', { offset: -1, timeout: 0 });
      if (pending?.length) offset = pending[pending.length - 1].update_id + 1;
    } catch {
      /* не критично */
    }

    while (!signal?.aborted) {
      try {
        const updates = await this.call(
          'getUpdates',
          { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] },
          { retries: 1, timeoutMs: (timeoutSec + 15) * 1000 },
        );
        for (const u of updates ?? []) {
          offset = u.update_id + 1;
          try {
            await onUpdate(u);
          } catch (e) {
            this.log.error?.('Ошибка обработки апдейта: ' + (e?.stack ?? e));
          }
        }
      } catch (e) {
        if (signal?.aborted) break;
        this.log.warn?.('poll: ' + e.message);
        await sleep(3000);
      }
    }
  }
}

export class TelegramError extends Error {
  constructor(description, code, method, payload) {
    super(`Telegram ${method} [${code}]: ${description}`);
    this.name = 'TelegramError';
    this.code = code;
    this.description = description;
    this.payload = payload;
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Режет сообщение по границам строк/абзацев, не ломая HTML-теги. */
export function splitMessage(text, max = MAX_LEN) {
  if (text.length <= max) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length) parts.push(rest);
  return parts;
}
