// Простой логгер: консоль + файл logs/bot.log (только если вызвали enableFileLog).
// В логи не пишем тексты сообщений гостей, телефоны и токены.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(BASE_DIR, "logs");
const LOG_FILE = path.join(LOG_DIR, "bot.log");
const MAX_BYTES = 1_000_000;
const BACKUPS = 3;

let toFile = false;
let consolePrefix = "";

/** Включает запись в файл. Старый лог ротируется при старте, если он больше 1 МБ. */
export function enableFileLog() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  try {
    if (fs.statSync(LOG_FILE).size > MAX_BYTES) {
      for (let i = BACKUPS; i >= 1; i--) {
        const from = i === 1 ? LOG_FILE : `${LOG_FILE}.${i - 1}`;
        if (fs.existsSync(from)) fs.renameSync(from, `${LOG_FILE}.${i}`);
      }
    }
  } catch {
    // файла ещё нет
  }
  toFile = true;
}

/** Добавляет префикс к строкам в консоли (нужно скрипту проверки сценариев). */
export function setConsolePrefix(prefix) {
  consolePrefix = prefix;
}

function write(level, name, message, { file = true } = {}) {
  const line = `${new Date().toISOString().replace("T", " ").slice(0, 19)} ${level} ${name}: ${message}`;
  const out = level === "ERROR" || level === "CRITICAL" || level === "WARNING" ? console.error : console.log;
  out(consolePrefix ? `${consolePrefix}(${message})` : line);
  if (toFile && file) {
    try {
      fs.appendFileSync(LOG_FILE, line + "\n");
    } catch {
      // лог не должен ронять бота
    }
  }
}

export function getLogger(name) {
  return {
    info: (m) => write("INFO", name, m),
    // Только в консоль: в размышлении бывают тексты гостей и телефоны, в файл их не пишем.
    thinking: (m) => write("THINK", name, m, { file: false }),
    warn: (m) => write("WARNING", name, m),
    error: (m) => write("ERROR", name, m),
    critical: (m) => write("CRITICAL", name, m),
  };
}
