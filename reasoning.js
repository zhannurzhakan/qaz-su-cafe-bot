// Когда включать встроенное рассуждение модели (параметр reasoning у OpenRouter).
// Включено: разбор брони и расчёты из нескольких позиций. Для простых вопросов выключено:
// так ответ быстрее и без лишних токенов. Здесь только чистые функции, подключение в cafe.js.

export const REASONING_OFF = { enabled: false, exclude: true };
export const REASONING_ON = { effort: "high" };

// Просьба посчитать: «сколько будет», «итого», «сумма», «сколько с меня», по-казахски «барлығы», «қанша төлеймін».
const CALC_RE = new RegExp([
  "сколько\\s+(?:\\p{L}+\\s+){0,3}(?:будет|получится|выйдет|выходит|всего|заплат\\p{L}*|платить|итого|с\\s+(?:меня|нас))",
  "итог|в\\s+сумме|посчита|подсчита|общ\\p{L}+\\s+(?:сумм|стоимост)|суммарн|сумм[аеуы](?![\\p{L}])",
  "қанша\\s+(?:төле|болады|шығады)|барлығы|жалпы\\s+(?:сома|баға)|есепте|қосқанда",
].join("|"), "iu");

// Вопрос о цене: нужен вместе с двумя и более позициями, иначе «капучино и латте» без вопроса не расчёт.
const PRICE_ASK_RE = /сколько|цен[аыу]|стоит|стоят|стоимост|почем|₸|тенге|қанша|баға/iu;

/** Сколько разных позиций (и добавок) меню названо в тексте. facts — результат buildFacts из guard.js. */
function menuItemsMentioned(facts, text) {
  const t = text.toLowerCase().replaceAll("ё", "е");
  return facts.items.filter((i) => i.re.test(t)).length;
}

/** Нужен ли расчёт: просьба посчитать или цена нескольких позиций сразу. */
export function isCalculation(facts, text) {
  if (CALC_RE.test(text)) return true;
  return PRICE_ASK_RE.test(text) && menuItemsMentioned(facts, text) >= 2;
}

/** Режим reasoning для обычного диалога (бронь разбирается отдельно: там reasoning включён всегда). */
export function reasoningForChat(facts, text) {
  return isCalculation(facts, text) ? REASONING_ON : REASONING_OFF;
}
