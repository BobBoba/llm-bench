// Генератор «наполнителя» для длинноконтекстных вариантов тяжёлых задач.
//
// ЗАЧЕМ. Обычные задачи набора дают короткий промпт и меряют глубину рассуждения, но не работу
// с длинным контекстом. У локальных моделей второе — узкое место: замерено, что `gemma-4-31B`
// на окне 262144 выдаёт 8.3 т/с против 94.8 на 32768, то есть окно стоит ей одиннадцатикратного
// замедления. Вопрос «доставляет ли локальная модель решение за разумное время на длинном
// контексте» без такой нагрузки просто не задаётся.
//
// КАК. Целевой модуль закапывается в правдоподобный репозиторий из сгенерированных соседних
// модулей. Наполнитель ОБЯЗАН быть настоящим кодом, а не шумом: строки-заглушки модель
// пропускает по одному взгляду, и длина контекста перестаёт что-либо нагружать. Поэтому
// генерируются осмысленные модули с типами, функциями и комментариями того же языка.
//
// ДЕТЕРМИНИРОВАННО. Генератор без случайности: все модели обязаны видеть побайтово одинаковый
// вход, иначе сравнение между ними теряет смысл. Разнообразие даёт позиционный переклад
// шаблонов, а не генератор случайных чисел.

const DOMAINS = [
  ['orders', 'Order', 'заказ'], ['billing', 'Invoice', 'счёт'], ['routing', 'Route', 'маршрут'],
  ['pricing', 'Quote', 'котировка'], ['inventory', 'Lot', 'партия'], ['ledger', 'Entry', 'проводка'],
  ['sessions', 'Session', 'сессия'], ['limits', 'Bucket', 'лимит'], ['audit', 'Record', 'запись'],
  ['feeds', 'Tick', 'тик'], ['accounts', 'Account', 'счёт клиента'], ['reports', 'Sheet', 'отчёт'],
];

// Позиция целевого модуля в списке файлов. Класть его первым нельзя — модель прочитала бы начало
// и остановилась; класть последним тоже, иначе достаточно прочитать хвост. Треть от конца
// заставляет держать в поле зрения и то, что до, и то, что после.
const TARGET_FRACTION = 0.66;

function rustModule(i, [dom, Ty, ru]) {
  const n = i + 1;
  return `// Модуль ${dom}: ${ru}. Сгенерирован как часть репозитория.
#[derive(Debug, Clone, PartialEq)]
pub struct ${Ty}${n} {
    pub id: u64,
    pub label: String,
    pub amount: i64,
    pub flags: u32,
}

impl ${Ty}${n} {
    pub fn new(id: u64, label: &str, amount: i64) -> Self {
        ${Ty}${n} { id, label: label.to_string(), amount, flags: 0 }
    }

    /// Помечает признак и возвращает предыдущее состояние.
    pub fn set_flag(&mut self, bit: u32) -> bool {
        let was = self.flags & (1 << bit) != 0;
        self.flags |= 1 << bit;
        was
    }

    pub fn scaled(&self, factor: i64) -> i64 {
        self.amount.saturating_mul(factor)
    }
}

/// Суммирует значения, пропуская помеченные признаком ${n % 8}.
pub fn total_${dom}_${n}(items: &[${Ty}${n}]) -> i64 {
    items.iter()
        .filter(|it| it.flags & (1 << ${n % 8}) == 0)
        .map(|it| it.amount)
        .fold(0i64, |a, b| a.saturating_add(b))
}

/// Разбивает на группы по остатку идентификатора.
pub fn bucket_${dom}_${n}(items: &[${Ty}${n}], buckets: usize) -> Vec<Vec<u64>> {
    let mut out = vec![Vec::new(); buckets.max(1)];
    for it in items {
        let idx = (it.id as usize) % buckets.max(1);
        out[idx].push(it.id);
    }
    out
}
`;
}

function tsModule(i, [dom, Ty, ru]) {
  const n = i + 1;
  return `// Модуль ${dom}: ${ru}. Сгенерирован как часть репозитория.
export interface ${Ty}${n} {
  readonly id: number;
  readonly label: string;
  amount: number;
  flags: number;
}

export function make${Ty}${n}(id: number, label: string, amount: number): ${Ty}${n} {
  return { id, label, amount, flags: 0 };
}

/** Помечает признак и возвращает предыдущее состояние. */
export function setFlag${n}(it: ${Ty}${n}, bit: number): boolean {
  const was = (it.flags & (1 << bit)) !== 0;
  it.flags |= 1 << bit;
  return was;
}

/** Суммирует значения, пропуская помеченные признаком ${n % 8}. */
export function total${Ty}${n}(items: ReadonlyArray<${Ty}${n}>): number {
  return items
    .filter((it) => (it.flags & (1 << ${n % 8})) === 0)
    .reduce((a, it) => a + it.amount, 0);
}

/** Разбивает на группы по остатку идентификатора. */
export function bucket${Ty}${n}(items: ReadonlyArray<${Ty}${n}>, buckets: number): number[][] {
  const k = Math.max(1, buckets);
  const out: number[][] = Array.from({ length: k }, () => []);
  for (const it of items) out[it.id % k]!.push(it.id);
  return out;
}
`;
}

function juliaModule(i, [dom, Ty, ru]) {
  const n = i + 1;
  return `# Модуль ${dom}: ${ru}. Сгенерирован как часть репозитория.
struct ${Ty}${n}
    id::Int
    label::String
    amount::Int
    flags::UInt32
end

${Ty}${n}(id::Int, label::String, amount::Int) = ${Ty}${n}(id, label, amount, UInt32(0))

"Возвращает копию с поднятым признаком."
function set_flag_${n}(x::${Ty}${n}, bit::Int)
    ${Ty}${n}(x.id, x.label, x.amount, x.flags | (UInt32(1) << bit))
end

"Суммирует значения, пропуская помеченные признаком ${n % 8}."
function total_${dom}_${n}(items::Vector{${Ty}${n}})
    s = 0
    for it in items
        if it.flags & (UInt32(1) << ${n % 8}) == 0
            s += it.amount
        end
    end
    return s
end

"Разбивает на группы по остатку идентификатора."
function bucket_${dom}_${n}(items::Vector{${Ty}${n}}, buckets::Int)
    k = max(1, buckets)
    out = [Int[] for _ in 1:k]
    for it in items
        push!(out[mod(it.id, k) + 1], it.id)
    end
    return out
end
`;
}

function csharpModule(i, [dom, Ty, ru]) {
  const n = i + 1;
  return `// Модуль ${dom}: ${ru}. Сгенерирован как часть репозитория.
public sealed class ${Ty}${n}
{
    public ulong Id { get; }
    public string Label { get; }
    public long Amount { get; set; }
    public uint Flags { get; private set; }

    public ${Ty}${n}(ulong id, string label, long amount)
    {
        Id = id;
        Label = label;
        Amount = amount;
    }

    /// <summary>Помечает признак и возвращает предыдущее состояние.</summary>
    public bool SetFlag(int bit)
    {
        bool was = (Flags & (1u << bit)) != 0;
        Flags |= 1u << bit;
        return was;
    }

    public long Scaled(long factor)
    {
        try { checked { return Amount * factor; } }
        catch (OverflowException) { return Amount > 0 == factor > 0 ? long.MaxValue : long.MinValue; }
    }
}

public static class ${Ty}${n}Ops
{
    /// <summary>Суммирует значения, пропуская помеченные признаком ${n % 8}.</summary>
    public static long Total(IReadOnlyList<${Ty}${n}> items)
    {
        long s = 0;
        foreach (var it in items)
            if ((it.Flags & (1u << ${n % 8})) == 0)
                s += it.Amount;
        return s;
    }

    /// <summary>Разбивает на группы по остатку идентификатора.</summary>
    public static List<List<ulong>> Bucket(IReadOnlyList<${Ty}${n}> items, int buckets)
    {
        int k = Math.Max(1, buckets);
        var outp = new List<List<ulong>>();
        for (int i = 0; i < k; i++) outp.Add(new List<ulong>());
        foreach (var it in items) outp[(int)(it.Id % (ulong)k)].Add(it.Id);
        return outp;
    }
}
`;
}

const GEN = { rust: rustModule, ts: tsModule, julia: juliaModule, csharp: csharpModule };
const EXT = { rust: 'rs', ts: 'ts', julia: 'jl', csharp: 'cs' };

/**
 * Собирает текст репозитория с закопанным целевым модулем.
 *   lang        — 'rust' | 'ts' | 'julia'
 *   targetName  — имя файла целевого модуля (то, что модель обязана вернуть)
 *   targetBody  — его содержимое
 *   approxChars — желаемый размер контекста в символах (примерно 4 символа на токен)
 * Возвращает { text, files, targetIndex }.
 */
function buildRepo(lang, targetName, targetBody, approxChars) {
  const gen = GEN[lang];
  const ext = EXT[lang];
  const filler = [];
  let size = targetBody.length;
  let i = 0;
  while (size < approxChars) {
    const dom = DOMAINS[i % DOMAINS.length];
    const body = gen(i, dom);
    filler.push({ name: `${dom[0]}_${i + 1}.${ext}`, body });
    size += body.length + 80;
    i += 1;
    if (i > 400) break;                     // страховка от бесконечного цикла
  }
  const at = Math.min(filler.length, Math.floor(filler.length * TARGET_FRACTION));
  const files = [...filler.slice(0, at), { name: targetName, body: targetBody }, ...filler.slice(at)];
  const text = files
    .map((f) => `===== ФАЙЛ: ${f.name} =====\n${f.body}`)
    .join('\n');
  return { text, files, targetIndex: at, chars: text.length };
}

module.exports = { buildRepo, DOMAINS };
