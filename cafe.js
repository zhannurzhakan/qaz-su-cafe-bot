// Логика бота кофейни qaz.su без привязки к Telegram.
//
// Здесь: загрузка system prompt и меню, запросы к OpenRouter с запасными моделями,
// память диалога, разбор и проверка брони, запись в bookings.csv.

import fs from "node:fs";
import path from "node:path";
import { BASE_DIR, getLogger } from "./logger.js";
import {
  buildFacts, checkAnswer, fallbackText, polish, reminderFor, repairNote, withNote,
} from "./guard.js";
import {
  FIELDS, INTAKE_TEXTS, INTAKE_TRIGGER_RE, QUESTIONS, RETRY_REMINDER,
  buildIntakePrompt, isYes, parseIntakeJson, parseNo,
} from "./intake.js";
import { REASONING_OFF, REASONING_ON, reasoningForChat } from "./reasoning.js";

const log = getLogger("cafe");

export { BASE_DIR };
export const PROMPT_PATH = path.join(BASE_DIR, "system_prompt.md");
export const MENU_PATH = path.join(BASE_DIR, "menu.md");
export const BOOKINGS_PATH = path.join(BASE_DIR, "bookings.csv");

// В Казахстане с марта 2024 года единое время UTC+5, перехода на летнее время нет.
// «Время Караганды» хранится как Date, у которого UTC-поля равны местным: читаем через getUTC*.
const TZ_OFFSET_MS = 5 * 3600 * 1000;
export const nowKZ = () => new Date(Date.now() + TZ_OFFSET_MS);

// Данные кофейни, которые нужны коду для проверки брони.
// Они должны совпадать с разделом «О кофейне» в system_prompt.md.
export const CAFE_PHONE = "+7 7212 50-60-70";
const OPENING_HOURS = [ // 0 = понедельник … 6 = воскресенье
  ["08:00", "22:00"],
  ["08:00", "22:00"],
  ["08:00", "22:00"],
  ["08:00", "22:00"],
  ["08:00", "22:00"],
  ["09:00", "23:00"],
  ["09:00", "23:00"],
];
const LAST_BOOKING_BEFORE_CLOSE_MIN = 60;
const MAX_GUESTS = 8;
const BOOKING_DAYS_AHEAD = 14;
const HOLD_MINUTES = 15;

const HISTORY_LIMIT = 20; // сколько последних сообщений чата помнит бот
const GUARD_ATTEMPTS = 3; // запросов к модели на один ответ: пустой ответ или нарушение правил — повтор

// Бесплатные модели OpenRouter: основная и запасные, по порядку.
export const DEFAULT_MODELS = [
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "baidu/ernie-5.5-flash-preview:free",
  "nvidia/nemotron-3.5-super-vl:free",
  "dots-studio/dots-3-note-preview:free",
  "google/gemma-4-31b-it:free",
];
const RATE_LIMIT_COOLDOWN_MS = 60_000; // столько не трогаем модель после ответа 429

const WEEKDAYS_RU = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];
const WEEKDAYS_KZ = ["дүйсенбі", "сейсенбі", "сәрсенбі", "бейсенбі", "жұма", "сенбі", "жексенбі"];
const MONTHS_RU = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля",
  "августа", "сентября", "октября", "ноября", "декабря"];
const MONTHS_KZ = ["қаңтар", "ақпан", "наурыз", "сәуір", "мамыр", "маусым", "шілде",
  "тамыз", "қыркүйек", "қазан", "қараша", "желтоқсан"];
const KAZAKH_LETTERS = /[әғқңөұүһіӘҒҚҢӨҰҮҺІ]/;

// ---------- даты ----------
// День хранится строкой «ГГГГ-ММ-ДД», время — «ЧЧ:ММ».

const pad = (n) => String(n).padStart(2, "0");
const isoDate = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const hhmm = (d) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
const dayMs = (iso) => Date.parse(`${iso}T00:00:00Z`);
const weekday = (iso) => (new Date(dayMs(iso)).getUTCDay() + 6) % 7; // 0 = понедельник
const addDays = (iso, n) => isoDate(new Date(dayMs(iso) + n * 86_400_000));
const minutes = (hm) => {
  const [h, m] = hm.split(":");
  return Number(h) * 60 + Number(m);
};
const fromMinutes = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

export function detectLang(text) {
  return KAZAKH_LETTERS.test(text) ? "kz" : "ru";
}

export function humanDate(iso, lang) {
  const [, m, d] = iso.split("-").map(Number);
  const wd = weekday(iso);
  if (lang === "kz") return `${d} ${MONTHS_KZ[m - 1]}, ${WEEKDAYS_KZ[wd]}`;
  return `${WEEKDAYS_RU[wd]}, ${d} ${MONTHS_RU[m - 1]}`;
}

/** Первое и последнее время, на которое можно забронировать стол в этот день. */
export function bookingWindow(iso) {
  const [open, close] = OPENING_HOURS[weekday(iso)];
  return [open, fromMinutes(minutes(close) - LAST_BOOKING_BEFORE_CLOSE_MIN)];
}

// ---------- system prompt и меню ----------

/** system_prompt.md с подставленным menu.md. {{NOW}} заполняется при каждом запросе. */
function loadPromptTemplate() {
  const prompt = fs.readFileSync(PROMPT_PATH, "utf-8");
  const menu = fs.readFileSync(MENU_PATH, "utf-8").trim();
  for (const placeholder of ["{{MENU}}", "{{NOW}}"]) {
    if (!prompt.includes(placeholder)) throw new Error(`В system_prompt.md нет ${placeholder}`);
  }
  return prompt.replaceAll("{{MENU}}", () => menu);
}

function nowBlock(now) {
  const today = isoDate(now);
  const lines = [
    `Сейчас: ${humanDate(today, "ru")} ${now.getUTCFullYear()} г., ${hhmm(now)} (время Караганды).`,
    `Календарь броней на ${BOOKING_DAYS_AHEAD + 1} дней (дата — день недели — время, на которое можно забронировать):`,
  ];
  for (let i = 0; i <= BOOKING_DAYS_AHEAD; i++) {
    const d = addDays(today, i);
    const [first, last] = bookingWindow(d);
    const mark = i === 0 ? " (сегодня)" : i === 1 ? " (завтра)" : "";
    lines.push(`• ${d} — ${WEEKDAYS_RU[weekday(d)]}${mark} — ${first}–${last}`);
  }
  return lines.join("\n");
}

const escapeHtml = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** menu.md → HTML для Telegram: заголовки жирным, пункты списка с «•». */
export function menuForTelegram() {
  const out = [];
  for (const raw of fs.readFileSync(MENU_PATH, "utf-8").split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith("## ")) out.push("", `<b>${escapeHtml(line.slice(3))}</b>`);
    else if (line.startsWith("# ")) out.push(`<b>${escapeHtml(line.slice(2))}</b>`);
    else if (line.startsWith("- ")) out.push("• " + escapeHtml(line.slice(2)));
    else if (line) out.push(escapeHtml(line));
  }
  return out.join("\n").trim();
}

// ---------- OpenRouter ----------

export class LLMUnavailable extends Error {}

export class LLM {
  constructor(apiKey, models) {
    this.apiKey = apiKey;
    this.models = models;
    this.cooldown = new Map(); // модель -> время (мс), до которого её не трогаем
  }

  /** Возвращает {text, model, reasoning}. Модели перебираются по порядку при 429, ошибках и пустом ответе. */
  // maxTokens с запасом: модель сначала пишет размышление, потом ответ.
  // reasoning — параметр OpenRouter: по умолчанию выключено, для брони и расчётов включает cafe.js.
  async complete(messages, { temperature = 0.3, maxTokens = 1800, reasoning = REASONING_OFF } = {}) {
    const now = Date.now();
    const ready = this.models.filter((m) => (this.cooldown.get(m) ?? 0) <= now);
    for (const model of ready.length ? ready : this.models) {
      const body = {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        reasoning,
      };
      const started = Date.now();
      let res;
      try {
        res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            "X-Title": "qaz.su cafe bot",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(45_000),
        });
      } catch (e) {
        log.warn(`${model}: ${e.name}`);
        continue;
      }
      if (res.status === 429) {
        this.cooldown.set(model, Date.now() + RATE_LIMIT_COOLDOWN_MS);
        log.warn(`${model}: 429, переключаюсь на запасную модель`);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new LLMUnavailable(`OpenRouter отклонил ключ: HTTP ${res.status}`);
      }
      if (res.status !== 200) {
        log.warn(`${model}: HTTP ${res.status}`);
        continue;
      }
      let data;
      try {
        data = await res.json();
      } catch {
        log.warn(`${model}: ответ не JSON`);
        continue;
      }
      if (data.error) { // OpenRouter иногда отдаёт ошибку провайдера с кодом 200
        const code = data.error.code;
        if (code === 429) this.cooldown.set(model, Date.now() + RATE_LIMIT_COOLDOWN_MS);
        log.warn(`${model}: ошибка провайдера ${code}`);
        continue;
      }
      const message = data.choices?.[0]?.message ?? {};
      const text = message.content ?? "";
      if (typeof text !== "string" || !text.trim()) {
        log.warn(`${model}: пустой ответ`);
        continue;
      }
      log.info(`ответила ${model} за ${((Date.now() - started) / 1000).toFixed(1)} с`);
      return { text, model, reasoning: (message.reasoning ?? message.reasoning_content ?? "").trim() };
    }
    throw new LLMUnavailable("ни одна модель не ответила");
  }
}

// ---------- бронь ----------

const DRAFT_RE = /<booking_draft>\s*(\{.*?\})\s*(?:<\/booking_draft>)?/s;
const CONFIRMED_RE = /<booking_confirmed>\s*(\{.*?\})\s*(?:<\/booking_confirmed>)?/s;
const LEFTOVER_RE = /<\/?booking_(?:draft|confirmed)>|```(?:json)?\s*```|```(?:json)?\s*$/gs;

export class BookingError extends Error {
  constructor(code, kw = {}) {
    super(code);
    this.code = code;
    this.kw = kw;
  }
}

const BOOKING_ERRORS = {
  bad: ["не получилось разобрать данные брони", "брондау деректерін түсіне алмадым"],
  name: ["не хватает имени", "есіміңіз жетіспейді"],
  past: ["это время уже прошло", "бұл уақыт өтіп кетті"],
  too_far: [`бронь принимаем не дальше чем на ${BOOKING_DAYS_AHEAD} дней вперёд`,
    `брондауды ${BOOKING_DAYS_AHEAD} күннен артық алдын ала қабылдамаймыз`],
  hours: ["в этот день столик можно забронировать с {first} до {last}",
    "бұл күні үстелді {first} мен {last} аралығында брондауға болады"],
  guests: [`через бота бронируем столик на 1–${MAX_GUESTS} гостей, для большой компании позвоните ${CAFE_PHONE}`,
    `бот арқылы 1–${MAX_GUESTS} адамға брондаймыз, үлкен компания үшін ${CAFE_PHONE} нөміріне қоңырау шалыңыз`],
  phone: ["номер телефона неполный", "телефон нөмірі толық емес"],
  // ошибки отдельных полей при приёме заявки
  bad_date: ["не получилось понять дату", "күнін түсіне алмадым"],
  bad_time: ["не получилось понять время", "уақытын түсіне алмадым"],
  bad_guests: ["не получилось понять число гостей", "қонақ санын түсіне алмадым"],
  phone_len: ["в номере телефона должно быть 11 цифр", "телефон нөмірінде 11 сан болуы керек"],
};

// Эти фразы шлёт кнопка «Изменить» (см. bot.js).
export const EDIT_TEXTS = ["Хочу изменить данные брони", "Брондау деректерін өзгерткім келеді"];

export function normalizePhone(raw) {
  let digits = String(raw).replace(/\D/g, "");
  if (digits.length === 11 && digits[0] === "8") digits = "7" + digits.slice(1);
  if (digits.length === 10 && digits[0] === "7") digits = "7" + digits;
  return "+" + digits;
}

/** Разбирает JSON из служебного блока модели. Бросает BookingError("bad"), если данные не годятся. */
export function parseBooking(rawJson) {
  const bad = () => new BookingError("bad");
  let d;
  try {
    d = JSON.parse(rawJson);
  } catch {
    throw bad();
  }
  if (!d || typeof d !== "object" || Array.isArray(d)) throw bad();
  for (const k of ["name", "date", "time", "guests", "phone"]) {
    if (d[k] === undefined || d[k] === null) throw bad();
  }
  const name = String(d.name).trim();

  const day = String(d.date).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || isoDate(new Date(dayMs(day))) !== day) throw bad();

  const tm = /^(\d{1,2}):(\d{2})$/.exec(String(d.time).trim());
  if (!tm || Number(tm[1]) > 23 || Number(tm[2]) > 59) throw bad();
  const time = `${pad(Number(tm[1]))}:${tm[2]}`;

  if (typeof d.guests === "string" && !d.guests.trim()) throw bad();
  const g = Number(d.guests);
  if (!Number.isFinite(g)) throw bad();

  return { name, day, time, guests: Math.trunc(g), phone: normalizePhone(d.phone) };
}

const sameBooking = (a, b) =>
  !!a && !!b && a.name === b.name && a.day === b.day && a.time === b.time &&
  a.guests === b.guests && a.phone === b.phone;

/** Проверяет правила кофейни. now — время Караганды (см. nowKZ). */
export function validateBooking(b, now) {
  if (!b.name) throw new BookingError("name");
  if (!(b.guests >= 1 && b.guests <= MAX_GUESTS)) throw new BookingError("guests");
  const digits = b.phone.slice(1);
  if (!(/^\d+$/.test(digits) && digits.length >= 10 && digits.length <= 15) ||
      (digits.startsWith("7") && digits.length !== 11)) {
    throw new BookingError("phone");
  }
  if (Date.parse(`${b.day}T${b.time}:00Z`) <= now.getTime()) throw new BookingError("past");
  if (b.day > addDays(isoDate(now), BOOKING_DAYS_AHEAD)) throw new BookingError("too_far");
  const [first, last] = bookingWindow(b.day);
  if (!(first <= b.time && b.time <= last)) throw new BookingError("hours", { first, last });
}

const ERROR_FOLLOW_UP = { // что спросить после ошибки
  bad: ["Давайте уточним данные ещё раз: имя, дата и время, число гостей, телефон.",
    "Деректерді қайта нақтылайық: есім, күні мен уақыты, қонақ саны, телефон."],
  name: ["Как вас зовут?", "Есіміңіз кім?"],
  phone: ["Напишите, пожалуйста, номер полностью, например +7 701 123 45 67.",
    "Нөміріңізді толық жазыңыз, мысалы +7 701 123 45 67."],
  guests: ["", ""],
};

/** «Извините, не могу принять бронь: <причина>.» без вопроса в конце. */
function rejectText(err, lang) {
  const i = lang === "kz" ? 1 : 0;
  const reason = BOOKING_ERRORS[err.code][i].replace(/\{(\w+)\}/g, (_, k) => err.kw[k] ?? "");
  const head = lang === "kz" ? "Кешіріңіз, брондауды қабылдай алмаймын" : "Извините, не могу принять бронь";
  return `${head}: ${reason}.`;
}

export function errorText(err, lang) {
  const i = lang === "kz" ? 1 : 0;
  const fallback = ["Давайте подберём другое время или дату?", "Басқа уақыт немесе күн таңдайық па?"];
  const follow = (ERROR_FOLLOW_UP[err.code] ?? fallback)[i];
  return `${rejectText(err, lang)} ${follow}`.trim();
}

function summaryText(b, lang) {
  if (lang === "kz") {
    return "Брондау деректерін тексеріңіз:\n" +
      `• Есім: ${b.name}\n• Күні мен уақыты: ${humanDate(b.day, "kz")}, ${b.time}\n` +
      `• Қонақтар: ${b.guests}\n• Телефон: ${b.phone}\nБәрі дұрыс па?`;
  }
  return "Проверьте, пожалуйста, данные брони:\n" +
    `• Имя: ${b.name}\n• Дата и время: ${humanDate(b.day, "ru")}, ${b.time}\n` +
    `• Гостей: ${b.guests}\n• Телефон: ${b.phone}\nВсё верно?`;
}

/** Какое поле заявки переспросить после ошибки проверки. */
function fieldForError(err, draft, now) {
  const map = {
    name: "name", guests: "guests", phone: "phone", too_far: "date", hours: "time",
    past: draft.date === isoDate(now) ? "time" : "date", // прошло только время или вся дата
  };
  return map[err.code] ?? "date";
}

/** Итог заявки (без вопроса в конце). */
function intakeSummary(b, lang) {
  if (lang === "kz") {
    return "Брондау деректерін тексеріңіз:\n" +
      `• Есім: ${b.name}\n• Күні мен уақыты: ${humanDate(b.day, "kz")}, ${b.time}\n` +
      `• Қонақтар: ${b.guests}\n• Телефон: ${b.phone}`;
  }
  return "Проверьте, пожалуйста, данные брони:\n" +
    `• Имя: ${b.name}\n• Дата и время: ${humanDate(b.day, "ru")}, ${b.time}\n` +
    `• Гостей: ${b.guests}\n• Телефон: ${b.phone}`;
}

function confirmedText(b, lang) {
  if (lang === "kz") {
    return `Дайын, ${b.name}! Брондау жазылды: ${humanDate(b.day, "kz")}, ${b.time}, ${b.guests} адам. ` +
      `Үстелді ${HOLD_MINUTES} минут ұстаймыз. Брондауды болдырмау не ауыстыру — ${CAFE_PHONE} телефоны арқылы.`;
  }
  return `Готово, ${b.name}! Бронь записана: ${humanDate(b.day, "ru")}, ${b.time}, гостей: ${b.guests}. ` +
    `Столик держим ${HOLD_MINUTES} минут. Отменить или перенести бронь можно по телефону ${CAFE_PHONE}.`;
}

const BOOKING_FIELDS = ["created_at", "chat_id", "username", "name", "date", "time", "guests", "phone"];

const csvCell = (v) => {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
// Текст от гостя, который Excel принял бы за формулу, пишем с апострофом впереди.
const noFormula = (s) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Дописывает бронь строкой в CSV. false, если такая бронь от этого чата уже есть. */
export function saveBooking(b, chatId, username, filePath, now) {
  const row = {
    created_at: `${isoDate(now)} ${hhmm(now)}:${pad(now.getUTCSeconds())}`,
    chat_id: chatId,
    username: noFormula(username),
    name: noFormula(b.name),
    date: b.day,
    time: b.time,
    guests: b.guests,
    phone: b.phone,
  };
  const line = BOOKING_FIELDS.map((k) => csvCell(row[k])).join(",") + "\r\n";
  if (fs.existsSync(filePath)) {
    const [header, ...old] = parseCsv(fs.readFileSync(filePath, "utf-8").replace(/^﻿/, ""));
    const col = (name) => header.indexOf(name);
    const key = ["chat_id", "date", "time", "name"];
    const mine = [String(chatId), row.date, row.time, row.name];
    for (const r of old) {
      if (key.every((k, i) => r[col(k)] === mine[i])) return false;
    }
    fs.appendFileSync(filePath, line, "utf-8");
  } else {
    // BOM нужен, чтобы Excel правильно показал кириллицу
    fs.writeFileSync(filePath, "﻿" + BOOKING_FIELDS.join(",") + "\r\n" + line, "utf-8");
  }
  return true;
}

// ---------- диалог ----------

/** Очередь: задачи одного чата выполняются по одной. */
class Mutex {
  #tail = Promise.resolve();
  run(fn) {
    const result = this.#tail.then(fn);
    this.#tail = result.catch(() => {});
    return result;
  }
}

class Session {
  history = [];
  pending = null; // бронь, показанная гостю на подтверждение
  pendingId = 0;
  lang = "ru";
  intake = null; // заявка в работе: {state: "collecting" | "confirming", draft, asking}
  mutex = new Mutex();

  push(msg) {
    this.history.push(msg);
    while (this.history.length > HISTORY_LIMIT) this.history.shift();
  }
}

/** Ответ бота: текст, id черновика (если нужны кнопки) и сохранённая бронь. */
const reply = (text, extra = {}) => ({ text, confirmId: null, saved: null, ...extra });

/**
 * Делит ответ модели на размышление и ответ гостю.
 * Есть <ответ> — берём его содержимое. Тегов нет — берём весь текст без <размышление>.
 * Незакрытые теги (ответ обрезан по длине) тоже понимаем.
 */
export function splitReasoning(raw) {
  // Размышление кончается на </размышление>. Если закрывающего тега нет, считаем,
  // что оно идёт до <ответ> или до конца текста (ответ обрезан).
  const THINK = raw.includes("</размышление>")
    ? /<размышление>([\s\S]*?)<\/размышление>/giu
    : /<размышление>([\s\S]*?)(?=<ответ>|$)/giu;
  const thinking = [...raw.matchAll(THINK)].map((m) => m[1].trim()).filter(Boolean).join("\n");
  const rest = raw.replace(THINK, "");
  const m = /<ответ>([\s\S]*?)(?:<\/ответ>|$)/iu.exec(rest);
  const answer = (m ? m[1] : rest.replace(/<\/?ответ>/giu, "")).trim();
  return { thinking, answer };
}

export function cleanText(text) {
  const g = (re) => new RegExp(re.source, "gs");
  return text
    .replace(g(DRAFT_RE), "")
    .replace(g(CONFIRMED_RE), "")
    .replace(LEFTOVER_RE, "")
    .replaceAll("**", "")
    .replaceAll("__", "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export class CafeAssistant {
  constructor(llm, bookingsPath = BOOKINGS_PATH) {
    this.llm = llm;
    this.bookingsPath = bookingsPath;
    this.promptTemplate = loadPromptTemplate();
    this.facts = buildFacts(fs.readFileSync(MENU_PATH, "utf-8"), fs.readFileSync(PROMPT_PATH, "utf-8"));
    this.sessions = new Map();
  }

  session(chatId) {
    let s = this.sessions.get(chatId);
    if (!s) this.sessions.set(chatId, (s = new Session()));
    return s;
  }

  reset(chatId) {
    this.sessions.delete(chatId);
  }

  #systemPrompt(now) {
    return this.promptTemplate.replaceAll("{{NOW}}", () => nowBlock(now));
  }

  #setPending(s, b) {
    s.pending = b;
    return ++s.pendingId;
  }

  #save(s, b, chatId, username, now) {
    if (saveBooking(b, chatId, username, this.bookingsPath, now)) {
      log.info(`бронь сохранена: chat=${chatId} ${b.day} ${b.time}, гостей ${b.guests}`);
    } else {
      log.info(`повтор брони, не дублирую: chat=${chatId}`);
    }
    s.pending = null;
  }

  async chat(chatId, userText, { username = "", setLang = true, now = nowKZ() } = {}) {
    const s = this.session(chatId);
    if (setLang) s.lang = detectLang(userText);

    // Заявка на бронь: уже идёт, или гость только что про неё написал.
    if (s.intake || INTAKE_TRIGGER_RE.test(userText)) {
      const r = await this.#intake(s, chatId, userText, username, now);
      if (r) return r;
      // null — сообщение оказалось не про бронь, отвечаем обычным диалогом
    }

    s.push({ role: "user", content: userText });
    const messages = [{ role: "system", content: this.#systemPrompt(now) }, ...s.history];
    const userTexts = s.history.filter((m) => m.role === "user").map((m) => m.content);
    let answer = "";
    let found = [];
    let note = reminderFor(userText); // напоминание правил; после нарушения к нему добавляется разбор
    // Рассуждение включаем только для расчётов; простые вопросы идут без него (бронь разбирает #extract).
    const reasoning = reasoningForChat(this.facts, userText);
    const options = reasoning === REASONING_ON ? { reasoning, maxTokens: 3500 } : {};
    try {
      for (let attempt = 1; attempt <= GUARD_ATTEMPTS; attempt++) {
        const { text, reasoning: nativeThinking } = await this.llm.complete(withNote(messages, note), options);
        if (nativeThinking) log.thinking(`рассуждение модели (чат ${chatId}):\n${nativeThinking}`);
        const parts = splitReasoning(text);
        if (parts.thinking) log.thinking(`размышление (чат ${chatId}):\n${parts.thinking}`);
        if (!parts.answer) {
          log.warn(`в ответе модели нет текста после размышления (попытка ${attempt})`);
          continue;
        }
        answer = parts.answer;
        found = checkAnswer(this.facts, {
          visible: cleanText(answer), lang: s.lang, userTexts,
          hasConfirmed: CONFIRMED_RE.test(answer), hasDraft: DRAFT_RE.test(answer),
        });
        if (!found.some((v) => v.level !== "log")) break;
        log.warn(`проверка ответа, попытка ${attempt}: ${found.map((v) => v.code).join(", ")}`);
        note = `${reminderFor(userText)}\n${repairNote(found)}`;
      }
    } catch (e) {
      if (!(e instanceof LLMUnavailable)) throw e;
      log.error(`нет ответа от моделей: ${e.message}`);
      s.history.pop();
      return this.#unavailable(s);
    }
    if (!answer) {
      s.history.pop();
      return this.#unavailable(s);
    }
    if (found.some((v) => v.level === "block")) {
      log.warn(`ответ не прошёл проверку, отправляю безопасный текст: ${found.map((v) => v.code).join(", ")}`);
      const text = fallbackText(found, s.lang, CAFE_PHONE);
      s.push({ role: "assistant", content: `<ответ>${text}</ответ>` });
      return reply(text);
    }

    // Дальше работаем только с ответом: блоки брони ищем в нём, а не в размышлении.
    // В историю кладём ответ в тегах, чтобы модель держала формат, но без размышления.
    const raw = `<ответ>${answer}</ответ>`;
    const visible = polish(cleanText(answer));
    const confirmed = CONFIRMED_RE.exec(answer);
    const draft = DRAFT_RE.exec(answer);

    try {
      if (confirmed) {
        const b = parseBooking(confirmed[1]);
        validateBooking(b, now);
        if (sameBooking(s.pending, b)) {
          this.#save(s, b, chatId, username, now);
          s.push({ role: "assistant", content: raw });
          return reply(visible || confirmedText(b, s.lang), { saved: b });
        }
        // модель «подтвердила» то, что гость ещё не видел: сначала показываем данные
        const draftId = this.#setPending(s, b);
        const text = summaryText(b, s.lang);
        s.push({ role: "assistant", content: text });
        return reply(text, { confirmId: draftId });
      }
      if (draft) {
        const b = parseBooking(draft[1]);
        validateBooking(b, now);
        const draftId = this.#setPending(s, b);
        s.push({ role: "assistant", content: raw });
        return reply(visible || summaryText(b, s.lang), { confirmId: draftId });
      }
    } catch (e) {
      if (!(e instanceof BookingError)) throw e;
      log.info(`бронь не прошла проверку: ${e.code}`);
      const text = errorText(e, s.lang);
      s.push({ role: "assistant", content: text });
      return reply(text);
    }

    s.push({ role: "assistant", content: raw });
    return reply(visible);
  }

  #unavailable(s) {
    if (s.lang === "kz") {
      return reply("Кешіріңіз, қазір жауап бере алмай тұрмын — бір минуттан кейін қайталап көріңіз. " +
        `Мәзірді «Меню» батырмасынан көруге болады, ал үстелді ${CAFE_PHONE} арқылы брондауға болады.`);
    }
    return reply("Извините, сейчас не получается ответить — попробуйте через минуту. " +
      `Меню можно открыть кнопкой «Меню», а забронировать столик — по телефону ${CAFE_PHONE}.`);
  }

  // ---------- заявка через JSON ----------

  /** Просит модель вынуть из сообщения данные заявки. null — ответ не удалось разобрать даже со 2-го раза. */
  async #extract(text, it, now) {
    const system = buildIntakePrompt({ todayBlock: nowBlock(now), known: it.draft, asking: it.asking });
    let messages = [{ role: "system", content: system }, { role: "user", content: text }];
    for (let attempt = 1; attempt <= 2; attempt++) {
      // Разбор брони (даты вроде «в пятницу», «завтра», номера телефонов): здесь рассуждение включено всегда.
      // Текст рассуждения не логируем: в нём цитируются имя и телефон гостя.
      const { text: raw } = await this.llm.complete(messages, { temperature: 0, maxTokens: 2500, reasoning: REASONING_ON });
      try {
        return parseIntakeJson(raw);
      } catch (e) {
        log.warn(`заявка: ответ модели не разобран (попытка ${attempt}): ${e.message}`);
        messages = [...messages,
          { role: "assistant", content: raw.slice(0, 500) },
          { role: "user", content: RETRY_REMINDER }];
      }
    }
    return null;
  }

  /** Проверяет одно поле. Возвращает {value} или {error}. draft нужен для связки даты и времени. */
  #checkField(field, v, draft, now) {
    const bad = (code, kw) => ({ error: new BookingError(code, kw) });
    const today = isoDate(now);
    switch (field) {
      case "date": {
        const day = String(v).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || isoDate(new Date(dayMs(day))) !== day) return bad("bad_date");
        if (day < today) return bad("past");
        if (day > addDays(today, BOOKING_DAYS_AHEAD)) return bad("too_far");
        return { value: day };
      }
      case "time": {
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(v).trim());
        if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return bad("bad_time");
        const time = `${pad(Number(m[1]))}:${m[2]}`;
        if (draft.date) {
          const [first, last] = bookingWindow(draft.date);
          if (!(first <= time && time <= last)) return bad("hours", { first, last });
          if (Date.parse(`${draft.date}T${time}:00Z`) <= now.getTime()) return bad("past");
        }
        return { value: time };
      }
      case "guests": {
        const n = typeof v === "string" ? Number(v.trim().replace(",", ".")) : v;
        if (!Number.isInteger(n)) return bad("bad_guests");
        if (n < 1 || n > MAX_GUESTS) return bad("guests");
        return { value: n };
      }
      case "name": {
        const name = String(v).replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
        return name ? { value: name } : bad("name");
      }
      case "phone": {
        const phone = normalizePhone(v);
        return /^\+\d{11}$/.test(phone) ? { value: phone } : bad("phone_len");
      }
    }
    return bad("bad");
  }

  /** Проверяет все собранные поля по порядку. Неподходящие обнуляет. Возвращает список ошибок. */
  #reconcile(draft, now) {
    const errors = [];
    for (const f of FIELDS) {
      if (draft[f] === null) continue;
      const res = this.#checkField(f, draft[f], draft, now);
      if (res.error) {
        errors.push(res.error);
        draft[f] = null;
      } else {
        draft[f] = res.value;
      }
    }
    return errors;
  }

  /** Следующий шаг заявки: спросить недостающее поле или показать итог. */
  #nextStep(s, it, errors, now, { lead = "" } = {}) {
    const i = s.lang === "kz" ? 1 : 0;
    const missing = FIELDS.filter((f) => it.draft[f] === null);

    if (missing.length === 0) {
      const d = it.draft;
      const b = { name: d.name, day: d.date, time: d.time, guests: d.guests, phone: d.phone };
      try {
        validateBooking(b, now); // последняя проверка перед подтверждением
      } catch (e) {
        if (!(e instanceof BookingError)) throw e;
        errors.push(e);
        d[fieldForError(e, d, now)] = null;
        return this.#nextStep(s, it, errors, now, { lead });
      }
      it.state = "confirming";
      it.asking = null;
      const draftId = this.#setPending(s, b);
      const text = `${intakeSummary(b, s.lang)}\n${INTAKE_TEXTS.confirm[i]}`;
      s.push({ role: "assistant", content: text });
      return reply(text, { confirmId: draftId });
    }

    if (errors.some((e) => e.code === "guests")) { // большая компания: дальше только по телефону, число гостей не переспрашиваем
      s.intake = null;
      s.pending = null;
      const text = rejectText(errors.find((e) => e.code === "guests"), s.lang);
      s.push({ role: "assistant", content: text });
      return reply(text);
    }

    it.state = "collecting";
    it.asking = missing[0];
    s.pending = null;
    const parts = [];
    if (errors.length) parts.push(rejectText(errors[0], s.lang));
    else if (lead) parts.push(lead);
    parts.push(QUESTIONS[missing[0]][i]);
    const text = parts.join(" ");
    s.push({ role: "assistant", content: text });
    return reply(text);
  }

  /** Бронь не прошла проверку при подтверждении: убираем неверное поле и спрашиваем заново. */
  #invalidate(s, err, now) {
    const it = s.intake;
    it.draft[fieldForError(err, it.draft, now)] = null;
    return this.#nextStep(s, it, [err], now);
  }

  /** Ведёт заявку. null — сообщение не про бронь, пусть отвечает обычный диалог. */
  async #intake(s, chatId, text, username, now) {
    const i = s.lang === "kz" ? 1 : 0;
    const fresh = !s.intake;
    const it = s.intake ??= {
      state: "collecting",
      draft: { date: null, time: null, guests: null, name: null, phone: null },
      asking: null,
    };
    const drop = () => { if (fresh) s.intake = null; };
    let correction = text;

    if (it.state === "confirming") {
      const trimmed = text.trim();
      if (isYes(trimmed)) {
        s.push({ role: "user", content: text });
        const r = this.#finishIntake(s, chatId, username, now);
        return r;
      }
      const rest = EDIT_TEXTS.includes(trimmed) ? "" : parseNo(trimmed);
      if (rest !== null && rest.length < 3) { // «нет» без уточнения: спрашиваем, что менять
        s.pending = null;
        it.state = "collecting";
        it.asking = null;
        s.push({ role: "user", content: text });
        const answer = INTAKE_TEXTS.whatToFix[i];
        s.push({ role: "assistant", content: answer });
        return reply(answer);
      }
      if (rest !== null) correction = rest; // «нет, телефон другой +7…» — разбираем уточнение
    }

    let data;
    try {
      data = await this.#extract(correction, it, now);
    } catch (e) {
      if (!(e instanceof LLMUnavailable)) throw e;
      log.error(`нет ответа от моделей: ${e.message}`);
      drop();
      return this.#unavailable(s);
    }
    if (data === null) {
      drop();
      const answer = INTAKE_TEXTS.retry[i];
      s.push({ role: "user", content: text });
      s.push({ role: "assistant", content: answer });
      return reply(answer);
    }
    if (data.intent !== "booking") { // гость спрашивает о другом: заявку оставляем
      s.intake = null;
      s.pending = null;
      return null;
    }

    const next = { ...it.draft };
    for (const f of FIELDS) if (data[f] !== null) next[f] = data[f];
    const errors = this.#reconcile(next, now);
    it.draft = next;
    s.push({ role: "user", content: text });
    const lead = fresh && FIELDS.every((f) => next[f] === null) ? INTAKE_TEXTS.start[i] : "";
    return this.#nextStep(s, it, errors, now, { lead });
  }

  /** Гость написал «да» под итогом заявки. */
  #finishIntake(s, chatId, username, now) {
    const b = s.pending;
    try {
      validateBooking(b, now);
    } catch (e) {
      if (!(e instanceof BookingError)) throw e;
      return this.#invalidate(s, e, now);
    }
    this.#save(s, b, chatId, username, now);
    s.intake = null;
    const text = confirmedText(b, s.lang);
    s.push({ role: "assistant", content: text });
    return reply(text, { saved: b });
  }

  /** Кнопка «Подтвердить». null — кнопка устарела. */
  confirm(chatId, draftId, { username = "", now = nowKZ() } = {}) {
    const s = this.session(chatId);
    if (s.pending === null || draftId !== s.pendingId) return null;
    const b = s.pending;
    try {
      validateBooking(b, now);
    } catch (e) {
      if (!(e instanceof BookingError)) throw e;
      if (s.intake) return this.#invalidate(s, e, now);
      s.pending = null;
      return reply(errorText(e, s.lang));
    }
    s.intake = null;
    this.#save(s, b, chatId, username, now);
    const text = confirmedText(b, s.lang);
    s.push({ role: "user", content: "Подтверждаю бронь (нажал кнопку «Подтвердить»)" });
    s.push({ role: "assistant", content: text });
    return reply(text, { saved: b });
  }

  isCurrentDraft(chatId, draftId) {
    const s = this.session(chatId);
    return s.pending !== null && draftId === s.pendingId;
  }
}
