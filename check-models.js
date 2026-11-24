// Проверка бесплатных моделей OpenRouter с ключом из .env.
//
//   npm run models:list                      # только список бесплатных моделей
//   npm run models                           # проверить модели из OPENROUTER_MODELS (или список по умолчанию)
//   node --env-file=.env check-models.js model/a:free ...   # проверить конкретные модели
//
// Ключ берётся из .env и никуда не выводится. Каждая проверка — это один запрос
// к модели, а у бесплатного тарифа OpenRouter есть дневной лимит запросов.

import { DEFAULT_MODELS } from "./cafe.js";

const KEY = process.env.OPENROUTER_API_KEY ?? "";
const BASE = "https://openrouter.ai/api/v1";
const HEADERS = { Authorization: `Bearer ${KEY}`, "X-Title": "qaz.su cafe bot" };

async function keyInfo() {
  const r = await fetch(`${BASE}/key`, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) return console.log(`key: HTTP ${r.status}`);
  const d = (await r.json()).data ?? {};
  console.log(`key: ok | free_tier=${d.is_free_tier} | limit=${d.limit} | usage=${d.usage} | rate_limit=${JSON.stringify(d.rate_limit)}`);
}

async function listFreeModels() {
  const r = await fetch(`${BASE}/models`, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`models: HTTP ${r.status}`);
  const out = (await r.json()).data
    .filter((m) => m.id.endsWith(":free") && (m.architecture?.output_modalities ?? ["text"]).includes("text"))
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const m of out) console.log(`${m.id}  ctx=${m.context_length}`);
}

async function probe(model) {
  const body = {
    model,
    messages: [
      { role: "system", content: "Отвечай одним коротким предложением по-русски." },
      { role: "user", content: "Сколько будет 2+2?" },
    ],
    max_tokens: 300,
    // у "думающих" моделей без этого весь лимит токенов уходит на рассуждения
    reasoning: { enabled: false, exclude: true },
  };
  const t = Date.now();
  let r;
  try {
    r = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    return console.log(`FAIL  ${model}: ${e.name}`);
  }
  const dt = ((Date.now() - t) / 1000).toFixed(1);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return console.log(`FAIL  ${model}: HTTP ${r.status} ${String(data.error?.message ?? "").slice(0, 120)}`);
  if (data.error) return console.log(`FAIL  ${model}: ${String(data.error.message).slice(0, 120)}`);
  const text = (data.choices?.[0]?.message?.content ?? "").trim().replaceAll("\n", " ");
  console.log(`${text ? "OK   " : "EMPTY"} ${model}  ${dt}s  -> ${text.slice(0, 80)}`);
}

if (!KEY) {
  console.error("OPENROUTER_API_KEY не найден в .env");
  process.exit(1);
}
await keyInfo();
const args = process.argv.slice(2);
if (args[0] === "--list") {
  await listFreeModels();
} else {
  const fromEnv = (process.env.OPENROUTER_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const m of args.length ? args : fromEnv.length ? fromEnv : DEFAULT_MODELS) await probe(m);
}
