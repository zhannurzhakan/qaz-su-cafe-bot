// Сравнение одной бесплатной модели OpenRouter с выключенным и включённым рассуждением
// на трёх трудных вопросах из test_cases.md (раздел «Трудные вопросы»).
//
//   node --env-file=.env compare.js
//   node --env-file=.env compare.js --model <id>
//
// Всего 6 запросов (3 вопроса × 2 режима), без повторов. Ключ берётся из .env и нигде не печатается.
// Результат дописывается в конец comparison.md: прошлое содержимое файла не трогается,
// а раздел этого скрипта при повторном запуске заменяется.
// Файлы бота не меняются: из cafe.js только импорт.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CafeAssistant, BASE_DIR } from "./cafe.js";

const MODEL_DEFAULT = "nvidia/nemotron-3-ultra-550b-a55b:free";
const argModel = process.argv.indexOf("--model");
const MODEL = argModel > 0 ? process.argv[argModel + 1] : MODEL_DEFAULT;

const here = path.dirname(fileURLToPath(import.meta.url));
const CASES_PATH = path.join(here, "test_cases.md");
const REPORT_PATH = path.join(here, "comparison.md");
const SECTION_MARK = "## Трудные вопросы: reasoning none и high (compare.js)";

const MODES = [
  ["none", { effort: "none" }],
  ["high", { effort: "high" }],
];

// Вопросы: «### 3.x Название» и строка «Гость: …» из раздела «Трудные вопросы».
function loadQuestions() {
  const md = fs.readFileSync(CASES_PATH, "utf-8");
  const start = md.search(/^## [^#\n]*Трудные вопросы/mu);
  if (start < 0) throw new Error("В test_cases.md нет раздела «Трудные вопросы»");
  const rest = md.slice(start).split("\n").slice(1).join("\n");
  const section = rest.split(/^## /mu)[0];
  const out = [];
  for (const block of section.split(/^### /mu).slice(1)) {
    const title = block.split("\n")[0].trim();
    const m = block.match(/^Гость:\s*(.+)$/mu);
    if (m) out.push({ title, question: m[1].trim() });
  }
  if (out.length !== 3) throw new Error(`Ожидалось 3 вопроса, найдено ${out.length}`);
  return out;
}

// Настоящий system prompt бота (меню и календарь подставлены), подсунув заглушку вместо модели.
// Требование писать <размышление> убираем: единственная разница между запусками — параметр reasoning.
async function realSystemPrompt() {
  let captured = "";
  const stub = { async complete(messages) { captured = messages[0].content; return { text: "<ответ>ок</ответ>", model: "stub" }; } };
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cafe-compare-")), "bookings.csv");
  await new CafeAssistant(stub, tmp).chat(1, "Привет", { username: "test", setLang: true });
  return captured
    .split("\n")
    .filter((l) => !/<размышление>|<ответ>|размышление опущены/u.test(l))
    .join("\n") + "\n\nОтвечай сразу готовым текстом для гостя, без служебных тегов.";
}

async function ask(system, question, reasoning) {
  const started = Date.now();
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json", "X-Title": "qaz.su cafe bot" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: system }, { role: "user", content: question }],
        temperature: 0.3,
        max_tokens: 4000,
        reasoning,
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const seconds = (Date.now() - started) / 1000;
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      const why = data.error?.message ?? "";
      return { seconds, error: `HTTP ${res.status}${why ? `: ${String(why).slice(0, 200)}` : ""}` };
    }
    const m = data.choices?.[0]?.message ?? {};
    return {
      seconds,
      answer: (m.content ?? "").trim(),
      reasoning: (m.reasoning ?? m.reasoning_content ?? "").trim(),
      completionTokens: data.usage?.completion_tokens ?? null,
      reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      actualModel: data.model ?? MODEL,
    };
  } catch (e) {
    return { seconds: (Date.now() - started) / 1000, error: e.name === "TimeoutError" ? "таймаут 180 с" : `${e.name}: ${e.message}` };
  }
}

const fmt = (s) => (s == null ? "—" : s.toFixed(1));
const quote = (text) => (text ? text.split("\n").map((l) => `> ${l}`.trimEnd()).join("\n") : "> (пусто)");

function renderReport(results) {
  const lines = [
    SECTION_MARK,
    "",
    `Модель: \`${MODEL}\` (OpenRouter), температура 0.3, max_tokens 4000, один запуск, 6 запросов без повторов.`,
    "System prompt тот же, что у бота (меню и календарь подставлены), но без требования писать `<размышление>`: так единственное отличие между запусками — параметр `reasoning`.",
    "",
    "- `none`: `reasoning: { effort: \"none\" }`",
    "- `high`: `reasoning: { effort: \"high\" }`",
    "",
    "Вопросы взяты из раздела «3. Трудные вопросы» в `test_cases.md`. Скрипт: `compare.js`, запуск `node --env-file=.env compare.js`.",
    "",
    "### Сводка",
    "",
    "| Вопрос | Режим | Время, с | Токенов всего | Из них рассуждение | Длина ответа, симв. |",
    "|---|---|---|---|---|---|",
  ];
  for (const r of results) {
    for (const [label] of MODES) {
      const x = r[label];
      if (x.error) lines.push(`| ${r.title} | ${label} | ${fmt(x.seconds)} | ошибка | ошибка | — |`);
      else lines.push(`| ${r.title} | ${label} | ${fmt(x.seconds)} | ${x.completionTokens ?? "—"} | ${x.reasoningTokens} | ${x.answer.length} |`);
    }
  }
  const avg = (label, pick) => {
    const ok = results.map((r) => r[label]).filter((x) => !x.error);
    return ok.length === results.length ? ok.reduce((a, x) => a + pick(x), 0) / ok.length : null;
  };
  lines.push(
    "",
    `Среднее время: none — ${fmt(avg("none", (x) => x.seconds))} с, high — ${fmt(avg("high", (x) => x.seconds))} с («—»: среднее не считается, если хотя бы один запрос режима закончился ошибкой).`,
    "",
    "### Полные ответы и рассуждения",
  );
  for (const r of results) {
    lines.push("", `#### ${r.title}`, "", `Гость: ${r.question}`);
    for (const [label] of MODES) {
      const x = r[label];
      lines.push("", `**reasoning ${label}**`);
      if (x.error) {
        lines.push("", `Ошибка запроса (${fmt(x.seconds)} с): ${x.error}`);
        continue;
      }
      lines.push(
        "",
        `Время ${fmt(x.seconds)} с, токенов всего ${x.completionTokens ?? "—"}, из них рассуждение ${x.reasoningTokens}.`,
        "",
        "Ответ:",
        quote(x.answer),
        "",
        "Рассуждение (`message.reasoning`):",
        quote(x.reasoning),
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

function writeReport(text) {
  let current = fs.existsSync(REPORT_PATH) ? fs.readFileSync(REPORT_PATH, "utf-8") : "";
  const at = current.indexOf(SECTION_MARK);
  if (at >= 0) current = current.slice(0, at);
  current = current.replace(/\s*$/u, "");
  fs.writeFileSync(REPORT_PATH, `${current ? `${current}\n\n` : ""}${text}`);
}

async function main() {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error("OPENROUTER_API_KEY не найден в .env");
    return 1;
  }
  const questions = loadQuestions();
  const system = await realSystemPrompt();
  console.log(`Модель: ${MODEL}. Вопросов: ${questions.length}, запросов: ${questions.length * MODES.length}\n`);

  const results = [];
  for (const q of questions) {
    const row = { ...q };
    for (const [label, reasoning] of MODES) {
      process.stdout.write(`${q.title} | ${label} ... `);
      const r = await ask(system, q.question, reasoning);
      row[label] = r;
      console.log(r.error ? `ОШИБКА ${r.error}` : `${fmt(r.seconds)} с, токенов ${r.completionTokens ?? "?"}, рассуждение ${r.reasoningTokens}`);
    }
    results.push(row);
  }
  writeReport(renderReport(results));
  console.log(`\nГотово: таблица в ${path.relative(BASE_DIR, REPORT_PATH)}`);
  return 0;
}

process.exitCode = await main();
