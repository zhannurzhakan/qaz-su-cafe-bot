// Telegram-бот кофейни qaz.su. Без зависимостей, нужен Node.js 20.6+.
// Запуск: npm start

import fs from "node:fs";
import path from "node:path";
import {
  BASE_DIR, DEFAULT_MODELS, EDIT_TEXTS, LLM, CafeAssistant, menuForTelegram,
} from "./cafe.js";
import { enableFileLog, getLogger } from "./logger.js";

enableFileLog();
const log = getLogger("bot");

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
const API_KEY = (process.env.OPENROUTER_API_KEY ?? "").trim();
if (!TOKEN || !API_KEY) {
  console.error("Заполните TELEGRAM_BOT_TOKEN и OPENROUTER_API_KEY в .env (образец — .env.example)");
  process.exit(1);
}

const BTN_MENU = "Меню";
const BTN_BOOK = "Забронировать столик";
const MAIN_KEYBOARD = {
  keyboard: [[{ text: BTN_MENU }, { text: BTN_BOOK }]],
  resize_keyboard: true,
  is_persistent: true,
};
const MENU_RE = /^\s*(меню|мәзір)\s*$/iu;
const BOOK_RE = /^\s*Забронировать столик\s*$/u;

const START_TEXT =
  "Здравствуйте! Сәлеметсіз бе! ☕\n" +
  "Я помощник кофейни qaz.su в Караганде: подскажу по меню и ценам, расскажу об акциях " +
  "и забронирую столик. Пишите по-русски или по-казахски.\n\n" +
  "Кнопки внизу: «Меню» — полное меню с ценами, «Забронировать столик» — бронь за минуту.";
const RESET_TEXT = "История диалога очищена, начнём заново. Чем могу помочь?\nДиалог тарихы тазартылды.";

// Сообщения-«события» чата (кто-то вошёл, закрепили сообщение…): на них бот молчит.
const SERVICE_KEYS = [
  "new_chat_members", "left_chat_member", "new_chat_title", "new_chat_photo", "delete_chat_photo",
  "group_chat_created", "supergroup_chat_created", "channel_chat_created", "pinned_message",
  "migrate_to_chat_id", "migrate_from_chat_id", "message_auto_delete_timer_changed",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Telegram API ----------

class TelegramError extends Error {
  constructor(method, data) {
    super(`Telegram ${method}: ${data.description ?? "ошибка"}`);
    this.code = data.error_code;
  }
}

async function tg(method, params = {}, timeoutMs = 40_000) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({ ok: false, error_code: res.status }));
  if (!data.ok) throw new TelegramError(method, data);
  return data.result;
}

// ---------- состояние ----------

const models = (process.env.OPENROUTER_MODELS ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const assistant = new CafeAssistant(new LLM(API_KEY, models.length ? models : DEFAULT_MODELS));
const draftMessages = new Map(); // chatId -> id сообщения с кнопками «Подтвердить / Изменить»

// ---------- помощники ----------

const confirmKeyboard = (draftId) => ({
  inline_keyboard: [[
    { text: "✅ Подтвердить · Растау", callback_data: `confirm:${draftId}` },
    { text: "✏️ Изменить · Өзгерту", callback_data: `edit:${draftId}` },
  ]],
});

function send(chatId, text, extra = {}) {
  return tg("sendMessage", { chat_id: chatId, text, reply_markup: MAIN_KEYBOARD, ...extra });
}

/** Показывает «печатает…», пока модель думает. */
async function withTyping(chatId, fn) {
  const ping = () => tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
  ping();
  const timer = setInterval(ping, 4000);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

async function dropOldButtons(chatId) {
  const messageId = draftMessages.get(chatId);
  draftMessages.delete(chatId);
  if (messageId) {
    await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId }).catch(() => {});
  }
}

async function sendReply(chatId, reply) {
  if (reply.confirmId !== null || reply.saved !== null) await dropOldButtons(chatId);
  const markup = reply.confirmId !== null ? confirmKeyboard(reply.confirmId) : MAIN_KEYBOARD;
  const msg = await send(chatId, reply.text, { reply_markup: markup });
  if (reply.confirmId !== null) draftMessages.set(chatId, msg.message_id);
}

function askAi(chatId, user, text, setLang = true) {
  // Один чат — одна задача за раз, чтобы история не перемешивалась.
  return assistant.session(chatId).mutex.run(async () => {
    const reply = await withTyping(chatId, () =>
      assistant.chat(chatId, text, { username: user?.username ?? "", setLang }));
    await sendReply(chatId, reply);
  });
}

// ---------- обработчики ----------

async function onMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (text === undefined) {
    if (SERVICE_KEYS.some((k) => k in msg)) return;
    await send(chatId,
      "Пока я понимаю только текст. Напишите, пожалуйста, сообщением 🙂\n" +
      "Әзірге тек мәтінді түсінемін.");
    return;
  }

  if (msg.entities?.some((e) => e.type === "bot_command" && e.offset === 0)) {
    const command = text.split(/[\s@]/)[0].slice(1).toLowerCase();
    if (command === "start") {
      assistant.reset(chatId);
      await dropOldButtons(chatId);
      await send(chatId, START_TEXT);
    } else if (command === "reset") {
      assistant.reset(chatId);
      await dropOldButtons(chatId);
      await send(chatId, RESET_TEXT);
    }
    return; // остальные команды игнорируем
  }

  if (MENU_RE.test(text)) {
    await send(chatId, menuForTelegram(), { parse_mode: "HTML" });
  } else if (BOOK_RE.test(text)) {
    await askAi(chatId, msg.from, BTN_BOOK, false);
  } else {
    await askAi(chatId, msg.from, text);
  }
}

async function onButton(q) {
  const m = /^(confirm|edit):(\d+)$/.exec(q.data ?? "");
  const chatId = q.message?.chat.id;
  if (!m || chatId === undefined) {
    await tg("answerCallbackQuery", { callback_query_id: q.id }).catch(() => {});
    return;
  }
  const [, action, rawId] = m;
  const draftId = Number(rawId);
  const clearButtons = () =>
    tg("editMessageReplyMarkup", { chat_id: chatId, message_id: q.message.message_id }).catch(() => {});

  if (!assistant.isCurrentDraft(chatId, draftId)) {
    await tg("answerCallbackQuery", {
      callback_query_id: q.id,
      text: "Эта бронь уже неактуальна · Бұл брондау өзекті емес",
    }).catch(() => {});
    await clearButtons();
    return;
  }

  await tg("answerCallbackQuery", { callback_query_id: q.id }).catch(() => {});
  await clearButtons();
  draftMessages.delete(chatId);

  if (action === "confirm") {
    const reply = await assistant.session(chatId).mutex.run(async () =>
      assistant.confirm(chatId, draftId, { username: q.from?.username ?? "" }));
    if (reply) await sendReply(chatId, reply);
  } else {
    const text = assistant.session(chatId).lang === "kz" ? EDIT_TEXTS[1] : EDIT_TEXTS[0];
    await askAi(chatId, q.from, text, false);
  }
}

async function handleUpdate(update) {
  const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
  try {
    if (update.message) await onMessage(update.message);
    else if (update.callback_query) await onButton(update.callback_query);
  } catch (e) {
    log.error(`Ошибка при обработке обновления: ${e.stack ?? e.message}`);
    if (chatId !== undefined) {
      await send(chatId, "Ой, что-то пошло не так. Попробуйте ещё раз или нажмите /reset.").catch(() => {});
    }
  }
}

// ---------- одна копия бота ----------

const PID_FILE = path.join(BASE_DIR, "bot.pid");

function acquireSingleInstanceLock() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, "utf-8"));
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0); // процесс жив?
        return false;
      } catch (e) {
        if (e.code === "EPERM") return false; // жив, но чужой
      }
    }
  } catch {
    // файла нет
  }
  fs.writeFileSync(PID_FILE, String(process.pid));
  return true;
}

function releaseLock() {
  try {
    if (Number(fs.readFileSync(PID_FILE, "utf-8")) === process.pid) fs.unlinkSync(PID_FILE);
  } catch {
    // уже удалён
  }
}

function shutdown(code = 0) {
  releaseLock();
  process.exit(code);
}

// ---------- запуск ----------

async function main() {
  if (!acquireSingleInstanceLock()) {
    console.error("Бот уже запущен на этом компьютере (см. bot.pid). Остановите его и запустите снова.");
    process.exit(1);
  }
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  const me = await tg("getMe");
  log.info(`Подключился к Telegram как @${me.username}`);
  log.info(`Модели: ${(models.length ? models : DEFAULT_MODELS).join(", ")}`);
  await tg("setMyCommands", {
    commands: [
      { command: "start", description: "Начать сначала / Басынан бастау" },
      { command: "reset", description: "Очистить историю диалога / Тарихты тазарту" },
    ],
  }).catch((e) => log.warn(`setMyCommands: ${e.message}`));
  log.info("Бот запущен. Остановить: Ctrl+C");

  let offset = 0;
  for (;;) {
    try {
      const updates = await tg(
        "getUpdates",
        { offset, timeout: 30, allowed_updates: ["message", "callback_query"] },
        45_000,
      );
      for (const u of updates) {
        offset = u.update_id + 1;
        handleUpdate(u); // не ждём: чаты обрабатываются параллельно
      }
    } catch (e) {
      if (e.code === 409) {
        log.critical("С этим токеном уже работает другая копия бота (возможно, на другом компьютере). Останавливаюсь.");
        shutdown(1);
      }
      if (e.code === 401) {
        log.critical("Telegram не принял токен бота. Проверьте TELEGRAM_BOT_TOKEN в .env.");
        shutdown(1);
      }
      log.warn(`Polling: ${e.message}`);
      await sleep(5000);
    }
  }
}

main().catch((e) => {
  log.critical(`Не удалось запустить бота: ${e.message}`);
  shutdown(1);
});
