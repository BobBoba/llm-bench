// Полный набор ТЯЖЁЛЫХ задач кампании hard0804: 3 языка × (edit, edit-long, algo, conc) = 12.
//
// Здесь же собираются ГОТОВЫЕ ПРОМПТЫ для одношота — раннер их не трогает, поэтому каждый
// вариант промпта существует ровно в одном месте и все модели гарантированно видят один и тот
// же текст (для edit-long это критично: наполнитель детерминирован, см. context-filler.js).
//
// edit-long — контролируемая пара к edit: тот же дефект, та же доработка, те же скрытые тесты;
// отличается ТОЛЬКО длина контекста (~64k токенов: целевой модуль закопан в сгенерированный
// репозиторий). Разница метрик edit-long − edit изолирует стоимость длинного контекста —
// именно то расхождение local vs cloud, которое ищем.

const { TASKS: RUST } = require('./tasks-hard-rust.js');
const { TASKS: TS } = require('./tasks-hard-ts.js');
const { TASKS: JULIA } = require('./tasks-hard-julia.js');
const { TASKS: CSHARP } = require('./tasks-hard-csharp.js');
const { TASKS: BASH } = require('./tasks-hard-bash.js');
const { TASKS: PWSH } = require('./tasks-hard-pwsh.js');
const { buildRepo } = require('./context-filler.js');

// ~64k токенов при ≈3.6 символа/токен на смеси кода и русских комментариев.
// Проверено замером: 231790 символов = 184 файла, целевой — 121-й.
const APPROX_CHARS = 232000;

// Имена целевых файлов совпадают с теми, что названы в спецификациях edit-задач, —
// поэтому текст спецификации переиспользуется в edit-long ДОСЛОВНО, без правок.
const TARGET_NAME = { rust: 'src/lib.rs', ts: 'lib.ts', julia: 'lib.jl', csharp: 'Lib.cs', bash: 'lib.sh', pwsh: 'Lib.ps1' };
const FENCE = { rust: 'rust', ts: 'ts', julia: 'julia', csharp: 'csharp', bash: 'bash', pwsh: 'powershell' };

// Шелл-наборы — укороченные, без edit-long: вопрос длинного контекста уже закрыт кампанией
// hard0804 на системных языках, а шелл-репозиторий на 63k токенов нереалистичен.
const NO_LONG = new Set(['bash', 'pwsh']);

function shortEditPrompt(t) {
  return `${t.spec}\n\nТекущее содержимое ${TARGET_NAME[t.lang]}:\n\`\`\`${FENCE[t.lang]}\n${t.starter}\n\`\`\``;
}

function longEditVariant(t) {
  const repo = buildRepo(t.lang, TARGET_NAME[t.lang], t.starter, APPROX_CHARS);
  const preamble =
    `Ниже — дамп репозитория из ${repo.files.length} файлов (разделитель «===== ФАЙЛ: имя =====»).\n` +
    `Задача относится ТОЛЬКО к файлу ${TARGET_NAME[t.lang]} — найдите его в дампе. Остальные файлы — ` +
    `контекст проекта, менять их не нужно.\n\n${t.spec}\n\n`;
  return {
    ...t,
    key: 'edit-long',
    kind: 'edit-long',
    prompt: preamble + repo.text,
    // Метаданные дампа — уходят в записи результатов, чтобы отчёт мог показать масштаб контекста.
    repoFiles: repo.files.length,
    repoChars: repo.chars,
    targetIndex: repo.targetIndex,
  };
}

function withPrompts(tasks) {
  const out = [];
  for (const t of tasks) {
    if (t.kind === 'edit') {
      out.push({ ...t, prompt: shortEditPrompt(t) });
      if (!NO_LONG.has(t.lang)) out.push(longEditVariant(t));
    } else {
      out.push({ ...t, prompt: t.spec });
    }
  }
  return out;
}

const ALL = [
  ...withPrompts(RUST), ...withPrompts(TS), ...withPrompts(JULIA),
  ...withPrompts(CSHARP), ...withPrompts(BASH), ...withPrompts(PWSH),
];

module.exports = { ALL, TARGET_NAME };
