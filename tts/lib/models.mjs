// * Реестр моделей и задач для time-to-solution бенчмарка (omp vs pi).
// * provider-префикс для omp/pi: openrouter/... или llama-server/...
// ! slug'и сверены в Task 1 (CONTRACT.md): все 6 OpenRouter рабочие, включая deepseek/deepseek-v3.2.
// ! local=true -> фаза B/C, требует загрузки модели в единственный RTX 3090 (сериализация).
export const MODELS = [
  { key: "ds-3.2",         model: "openrouter/deepseek/deepseek-v3.2",      thinking: "high", local: false },
  { key: "ds-v4-pro",      model: "openrouter/deepseek/deepseek-v4-pro",    thinking: "high", local: false },
  { key: "sonnet-4.5",     model: "openrouter/anthropic/claude-sonnet-4.5", thinking: "high", local: false },
  { key: "sonnet-5",       model: "openrouter/anthropic/claude-sonnet-5",   thinking: "high", local: false },
  { key: "opus-4.8",       model: "openrouter/anthropic/claude-opus-4.8",   thinking: "high", local: false },
  { key: "haiku",          model: "openrouter/anthropic/claude-haiku-4.5",  thinking: "high", local: false },
  { key: "ornith-35b",     model: "llama-server/ornith-1.0-35b",            thinking: "high", local: true, phase: "B" },
  { key: "qwen-coder-next", model: "llama-server/qwen3-coder-next",         thinking: "off",  local: true, phase: "C" },
];

// * Лестница задач. Rust x3 (edit/bugfix/feature), TS/bun x2 (cli/webapi).
// * timeoutMs = верхняя граница на всю ячейку (single + guided-дошагивание вместе).
export const TASKS = [
  { id: "r1-edit",    lang: "rust", timeoutMs: 15 * 60000 },
  { id: "r2-bugfix",  lang: "rust", timeoutMs: 15 * 60000 },
  { id: "r3-feature", lang: "rust", timeoutMs: 15 * 60000 },
  { id: "t4-cli",     lang: "ts",   timeoutMs: 20 * 60000 },
  { id: "t5-webapi",  lang: "ts",   timeoutMs: 20 * 60000 },
];

export const HARNESSES = ["omp", "pi"];
export const STEER_CAP = 3; // * раундов дошагивания до внешнего green, затем fail

// * ---- hx: сравнение харнессов omp / codex на одних и тех же моделях (подписка openai-codex) ----
// * id модели у каждого харнесса свой: omp — «провайдер/модель», codex — голый slug из его каталога.
// * Цены — прейскурант OpenRouter за 1M токенов (у подписки реальная цена нулевая, считаем эквивалент по списку);
// * cached = чтение из кэша промпта. Надбавка за контекст >272k не учитывается (прогоны далеко ниже).
export const HX_MODELS = {
  sol:  { omp: "openai-codex/gpt-6.1-sol", codex: "gpt-6.1-sol", price: { in: 2.0,  cached: 0.10, out: 10.0 } },
  luna: { omp: "openai-codex/gpt-6-luna",  codex: "gpt-6-luna",  price: { in: 0.10, cached: 0.01, out: 0.50 } },
};
export const HX_HARNESSES = ["omp", "codex"];

// * Цена прогона по общей таблице: одинаковая формула для обоих харнессов, чтобы цена зависела только от токенов.
export function estCost(metrics, modelKey) {
  const p = HX_MODELS[modelKey]?.price;
  if (!p || !metrics) return null;
  return ((metrics.tokensIn || 0) * p.in + (metrics.tokensCached || 0) * p.cached + (metrics.tokensOut || 0) * p.out) / 1e6;
}
