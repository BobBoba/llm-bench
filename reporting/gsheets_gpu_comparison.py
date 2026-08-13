"""Push a GPU relative-performance comparison (vs owned RTX 3090) into its own tab
of the shared Google Sheet (same SID as the LLM benchmark, gsheets-sheet-id.txt).

Source specs (checked live via Exa, not from memory):
  * RTX PRO 6000 Blackwell Workstation Edition — NVIDIA official datasheet PDF
    (single-precision 125 TFLOPS, 1792 GB/s, 96GB GDDR7); FP16 Tensor dense derived
    from the official "4000 AI TOPS" FP4-sparse headline via Blackwell's precision
    scaling (FP16->FP8->FP4 each 2x, sparsity 2x => FP16 dense = AI TOPS / 8).
  * All other cards — cross-checked against NVIDIA datasheets + community spec
    tables (github.com/carsonpo/gpus, inference.sh/gpus, openmetal.io).

Market purchase prices (checked live via Exa, июль 2026, USD, per-card "street"
figures — real listings vary widely, see market_note per row for the source range):
  * RTX 3090: eBay/Jawa/r-hardwareswap used-market consensus (InsiderLLM, pcprice.watch,
    craftrigs.com) — ~$1,000 typical used, $1,488 new (Amazon, increasingly rare).
  * T4: Newegg/Amazon list $837-885, но GPUDojo/GPUPoet price-history показывает
    падение до $550-600 (EOL-карта, нестабильная цена).
  * L4: широкий разброс между enterprise-реселлерами (CDW $7.3-11.2k) и
    boutique/refurb (itcreations $2.76k, neobitti $3.1k) — реальная "уличная" цена
    ближе к $3-4k.
  * A10/A10G: Newegg $2,999, NetworkOutlet $1,997, GPUPoet running average ~$2,067-2,100.
  * L40S: gpucost.org market price ~$9.0k (MSRP $8.0k), CDW list $8,499.99,
    gpupoet lowest avg $6,400. NVIDIA не публикует официальный MSRP для дата-центр
    GPU — OEM-embedded list price (Lenovo/Cisco) доходит до $39-52k, но это цена
    "зашитая" в серверную конфигурацию, не цена отдельной карты для частного лица.
  * A100 80GB: очень широкий разброс — новый PCIe $9.5-14k, refurb $4.8-8.5k,
    SXM (только через enterprise-канал) $10-20k+.
  * RTX PRO 6000 Blackwell: NVIDIA marketplace $13,250 (Tom's Hardware: цена выросла
    на 55% за год против MSRP), Newegg $11.8-14k, Microcenter $12,999 (уценка с $15k),
    B&H $10,499 — берём ~$12,500 как ориентир.
  * H200: $28-45k в зависимости от PCIe/SXM и поставщика; Cloud Ninjas продаёт
    конкретную PCIe-карту NVL 141GB за $39,774. Часть поставщиков (Cloud Ninjas)
    требует корпоративное оформление (GTC paperwork) перед покупкой — частному лицу
    практически недоступна вне серверного б/у рынка.

Плюс блок buyable consumer/prosumer 24GB+ карт (реально покупаемых частным лицом,
без корпоративной закупки) — специфика точности:
  * RTX 3090 Ti / RTX 4090: NVIDIA + community-трекеры (bestvaluegpu.com,
    gpudojo.com, craftrigs.com). FP16 Tensor dense для 4090 (165 TFLOPS) — выбрано
    так, чтобы остаться ЗАМЕТНО ниже официальных 312 TFLOPS dense у A100 (иначе
    получился бы абсурдный вывод "4090 быстрее A100 на тензорах", чего не бывает).
  * RTX 5090: FP16 dense 209.5 TFLOPS — комьюнити-таблица (github.com/carsonpo/gpus),
    ниже точность — Nvidia не публикует dense-число для GeForce.
  * RX 7900 XTX / Radeon PRO W7900: официальные AMD-числа (122.8 / 61.32 TFLOPS).
    W7800 FP32/FP16 НЕ найдены напрямую — оценены масштабированием по числу
    stream processors от W7900 — помечено как оценка.
  * Titan RTX: FP16 Tensor dense 130 TFLOPS — ОФИЦИАЛЬНО подтверждено
    (nvidia.com/titan/titan-rtx и Newegg product page оба цитируют "130 Tensor
    TFLOPs"), не оценка, как считалось раньше.
  * Intel Arc Pro B60: FP32/INT8 — Intel ОФИЦИАЛЬНЫЙ datasheet. FP16 (98.5 TFLOPS)
    — производная оценка INT8/2, Intel не публикует отдельное FP16-число.

ВТОРОЙ РАУНД ПРОВЕРКИ (июль 2026) — прямые страницы магазинов вместо агрегаторов.
Первый раунд цен опирался на price-tracker/blog сайты (gpudojo.com, gpupoet.com,
bestvaluegpu.com, craftrigs.com и т.п.) — по запросу пользователя перепроверено
через ФАКТИЧЕСКИЕ листинги Amazon/Newegg/eBay/Microcenter/CentralComputer
(via Exa web_search_exa/web_fetch_exa). Существенные расхождения с первым
раундом (обновлено в ROWS ниже):
  * RTX 5090: было $2800 (оценка по блогам) → ПОДТВЕРЖДЕНО $3,829-4,099.99
    (MSI Vanguard SOC / Ventus 3X, оба напрямую с Amazon.com) — на 35-45% дороже,
    чем предполагалось.
  * Titan RTX: было $650 (оценка) → ПОДТВЕРЖДЕНО $920 (ReSpec.io, прямой листинг)
    до $1,600 (eBay UK, "10 available") — реальный рынок заметно дороже.
  * RX 7900 XTX: было $1200 новая (оценка по блогам) → ПОДТВЕРЖДЕНО $899.99
    (Sapphire Pulse, "Ships from and sold by Amazon.com" — самый надёжный тип
    листинга) — на четверть дешевле, чем предполагалось.
  * Nvidia T4: было $600 (оценка по тренду) → ПОДТВЕРЖДЕНО Newegg $885.00
    прямым листингом (хотя карта явно снимается с продаж).
  * RTX 3090 / RTX 3090 Ti: подтверждено близко к оценке — Amazon-листинги
    MSI/EVGA $1,589.95-1,789.00.
  * Intel Arc Pro B60: подтверждено близко к оценке — Newegg $659.99 и
    CentralComputer $649.99, оба прямые листинги.
  * RTX 4090: подтверждено с широким разбросом $1,750-3,295 в зависимости от
    AIB-модели и продавца — характерно для карты в устойчивом дефиците.
Остальные позиции (A10G Newegg, L40S CDW, RTX PRO 6000 Blackwell Newegg/B&H/
Microcenter, W7800/W7900 B&H) уже были взяты с прямых страниц ритейлеров в
первом раунде — не переоценивались повторно.

ТРЕТИЙ РАУНД (июль 2026) — живой браузер (Playwright), не текстовый скрапинг Exa,
и конкретно amazon.ES (реальный рынок пользователя, Испания, доставка в Марбелью),
а не amazon.com. Два важных открытия:
  1. Один из "подтверждённых" во втором раунде листингов amazon.com (MSI RTX 5090
     Vanguard SOC, $4,099.99) при живом заходе в браузер оказался "Currently
     unavailable" — Exa вернула устаревший закэшированный текст страницы. Второй
     листинг (Ventus 3X) прямо заявляет "This item cannot be shipped to your
     selected delivery location" для Испании. Текстовый скрапинг НЕ ловит такие
     вещи (out-of-stock, geo-restriction) — только реальный рендеринг страницы.
  2. Цены на amazon.es систематически ВЫШЕ, чем на amazon.com в пересчёте по
     курсу (~1.08 USD/EUR, ориентировочно) — на 15-70% в зависимости от карты.
     Это НЕ ошибка/дефицит, а системная разница: испанская цена уже включает
     21% IVA (НДС), плюс менее конкурентный рынок комплектующих в EU-рознице
     по сравнению с США. Для пользователя, реально покупающего в Испании,
     цена amazon.es — единственная релевантная, а не amazon.com.
Подтверждённые вживую цены на amazon.es (доставка Marbella 29660, курс ~1.08
USD/EUR для конвертации — ориентировочный, не финальный обменный курс):
  * RTX 3090: реалистичные предложения (marketplace) €1,549-1,769; штучные
    редкие/коллекционные листинги доходят до €4,092 (не репрезентативно, выброс).
  * RTX 3090 Ti: EVGA FTW3 Hybrid €1,637.21, EVGA KINGPIN €1,974.06.
  * RTX 4090: ASUS ROG Strix / Gigabyte OC €3,489.99 в основной рознице,
    marketplace-предложения от €2,399-2,499.
  * RTX 5090: €4,389.99 (Gigabyte OC) — €4,784.31 (ASUS TUF OC).
  * RX 7900 XTX (настоящая 24GB-версия, не спутать с 7900 XT 20GB, который
    Amazon подмешивает в те же результаты поиска): €1,466.00.
  * Intel Arc Pro B60 24GB: €731.55 (ASRock Creator, рекомендованная цена
    €789.00).
  * Titan RTX: НЕ НАЙДЕНА на amazon.es вообще — поиск возвращает не тот товар
    (GTX Titan X, другая карта 2015 года). Карта практически недоступна как
    реальная опция для покупки в Испании — отброшена как нерелевантная для
    итоговой рекомендации, хотя в таблице оставлена с прежней US-оценкой
    ($920-1,600) и явной пометкой недоступности в ES-рознице.
  * Датацентр/workstation-карты (T4, L4, A10G, L40S, A100, RTX PRO 6000
    Blackwell, W7800, W7900) не перепроверялись на amazon.es — эти карты
    реалистично приобретаются через специализированных B2B-поставщиков/импорт,
    а не через розничный Amazon в любой стране.

    .venv-gsheets/bin/python gsheets_gpu_comparison.py
"""
import os
from googleapiclient.discovery import build
from gsheets_common import credentials

HERE = os.path.dirname(os.path.abspath(__file__))
SID = open(os.path.join(HERE, "gsheets-sheet-id.txt")).read().strip()
TAB = "GPU vs RTX3090"

ROWS = [
    dict(cat="Cloud/ЦОД", name="RTX 3090 (own)", arch="Ampere", vram=24, bw=936, fp32=35.6, fp16d=142, fp16s=284,
         price_hr="", price_buy=1780, eur_amzes=1650, market_note="Используется как база сравнения. ПОДТВЕРЖДЕНО живым браузером на amazon.es (доставка Испания): реалистичные marketplace-предложения €1,549-1,769 (типично ~€1,650); единичные редкие листинги до €4,092 — выброс, не репрезентативно. US used-рынок (eBay/Jawa) отдельно оценивался в ~$1,000, но это не тот рынок, где реально покупает пользователь.",
         note="Базовая карта — все коэффициенты относительно неё"),
    dict(cat="Cloud/ЦОД", name="Nvidia T4", arch="Turing", vram=16, bw=320, fp32=8.1, fp16d=65, fp16s=130,
         price_hr=0.5, price_buy=885, eur_amzes="", market_note="ПОДТВЕРЖДЕНО прямым листингом Newegg: $885.00. EOL-карта, региональные листинги (Amazon.in, Amazon renewed) показывают ещё более высокие цены ($1750-2580) — вероятно дефицит новых складских остатков, а не рост ценности карты. На amazon.es не перепроверялась (enterprise-карта, маловероятна в рознице).",
         note="Самая дешёвая, но слабее 3090 по всем метрикам — только лёгкий inference"),
    dict(cat="Cloud/ЦОД", name="Nvidia L4", arch="Ada Lovelace", vram=24, bw=300, fp32=30.3, fp16d=121, fp16s=242,
         price_hr=0.8, price_buy=3500, eur_amzes="", market_note="Большой разброс: refurb/boutique $2.75-3.1k, enterprise-реселлеры (CDW) $7.3-11.2k — берём ~$3.5k как реалистичный ориентир для отдельной карты. На amazon.es не перепроверялась (enterprise-карта, маловероятна в рознице).",
         note="Пропускная способность памяти ниже 3090 — decode-bound задачи (генерация токен-за-токеном) может быть медленнее, несмотря на новее архитектуру"),
    dict(cat="Cloud/ЦОД", name="Nvidia A10G", arch="Ampere", vram=24, bw=600, fp32=31.2, fp16d=125, fp16s=250,
         price_hr=1.0, price_buy=2500, eur_amzes="", market_note="Newegg $2,999, NetworkOutlet $1,997, рыночная средняя ~$2,067-2,100 (GPUPoet). На amazon.es не перепроверялась.",
         note="Сбалансированная, но слабее 3090 — примерно 3/4 от неё"),
    dict(cat="Cloud/ЦОД", name="Nvidia L40S", arch="Ada Lovelace", vram=48, bw=864, fp32=91.6, fp16d=181, fp16s=362,
         price_hr=1.8, price_buy=8500, eur_amzes="", market_note="CDW list $8,499.99, gpucost.org ~$9.0k, вторичный рынок от $6,400. OEM-embedded list price (внутри серверов) доходит до $39-52k — не цена отдельной карты. На amazon.es не перепроверялась.",
         note="Примерно на уровне 3090 по FP16, но 2x VRAM и заметно сильнее на FP8/квантизации"),
    dict(cat="Cloud/ЦОД", name="Nvidia A100 80GB", arch="Ampere", vram=80, bw=2039, fp32=19.5, fp16d=312, fp16s=624,
         price_hr=2.5, price_buy=9000, eur_amzes="", market_note="Очень широкий разброс: новый PCIe $9.5-14k, refurb $4.8-8.5k, SXM (только enterprise-канал) $10-20k+ — берём $9k как середину диапазона нового PCIe. На amazon.es не перепроверялась.",
         note="~2.2x от 3090 по памяти и вычислениям, плюс 80GB VRAM под большие модели/контексты"),
    dict(cat="Cloud/ЦОД", name="Nvidia RTX PRO 6000 Blackwell", arch="Blackwell", vram=96, bw=1792, fp32=125, fp16d=504, fp16s=1008,
         price_hr=2.75, price_buy=12500, eur_amzes="", market_note="NVIDIA marketplace $13,250 (Tom's Hardware: +55% за год к MSRP), Newegg $11.8-14k, Microcenter $12,999 (со скидкой с $15k), B&H $10,499. На amazon.es не перепроверялась.",
         note="Лучшее соотношение цена/производительность в списке; нативный FP4 даёт ещё больший отрыв на квантизованном inference"),
    dict(cat="Cloud/ЦОД", name="Nvidia H200", arch="Hopper", vram=141, bw=4800, fp32=67, fp16d=989, fp16s=1979,
         price_hr=5.0, price_buy=35000, eur_amzes="", market_note="$28-45k в зависимости от PCIe/SXM/поставщика (конкретная PCIe-карта NVL 141GB — $39,774, Cloud Ninjas). Часть поставщиков требует корпоративное оформление перед покупкой — частному лицу практически недоступна вне б/у серверного рынка.",
         note="~6x от 3090, но оправдано только если реально нужны 141GB HBM3e под огромные модели/батчи"),
    # ---- consumer/prosumer 24GB+, реально покупаемые частным лицом ----
    dict(cat="Consumer/купить", name="Nvidia RTX 3090 Ti", arch="Ampere", vram=24, bw=1008, fp32=40, fp16d=160, fp16s="",
         price_hr="", price_buy=1836, eur_amzes=1700, market_note="ПОДТВЕРЖДЕНО живым браузером на amazon.es: EVGA FTW3 Hybrid €1,637.21, EVGA KINGPIN Hybrid €1,974.06 (доставка Marbella, июль 2026). (Amazon.com отдельно показывал $1,589.95-1,699.95 — близко, но это другой рынок.)",
         note="Почти идентична 3090 — небольшой апгрейд по bandwidth, берите ту, что дешевле здесь и сейчас"),
    dict(cat="Consumer/купить", name="Nvidia RTX 4090", arch="Ada Lovelace", vram=24, bw=1008, fp32=82.6, fp16d=165, fp16s=330,
         price_hr="", price_buy=3186, eur_amzes=2950, market_note="ПОДТВЕРЖДЕНО живым браузером на amazon.es: ASUS ROG Strix OC / Gigabyte Gaming OC €3,489.99 в основной рознице, marketplace-предложения (used & new offers) от €2,399-2,499. Amazon.com показывал широкий разброс $1,750-3,295 — испанский рынок стабильно ближе к верхней границе этого диапазона.",
         note="Самая быстрая 24GB карта, но переплата за дефицит — худшая цена/производительность среди consumer-карт здесь"),
    dict(cat="Consumer/купить", name="Nvidia RTX 5090", arch="Blackwell", vram=32, bw=1792, fp32=104.8, fp16d=209.5, fp16s="",
         price_hr="", price_buy=4914, eur_amzes=4550, market_note="ПОДТВЕРЖДЕНО живым браузером на amazon.es: Gigabyte Gaming OC 32G €4,389.99, ASUS TUF Gaming OC €4,784.31 (июль 2026, доставка Marbella). Существенно выше даже подтверждённых amazon.com цен ($3,829-4,099.99) — при живой проверке два конкретных amazon.com-листинга оказались 'Currently unavailable' или 'cannot be shipped to Spain', то есть та цена была не только выше, но и физически недоступна пользователю. MSRP $1999 давно не имеет отношения к реальности. FP16 dense — комьюнити-оценка, ниже точность (Nvidia не публикует для GeForce).",
         note="32GB — единственная карта с реальным запасом сверх 24GB; самый большой прирост производительности, но и самая дорогая"),
    dict(cat="Consumer/купить", name="AMD RX 7900 XTX", arch="RDNA3", vram=24, bw=960, fp32=61.4, fp16d=122.8, fp16s="",
         price_hr="", price_buy=1583, eur_amzes=1466, market_note="ПОДТВЕРЖДЕНО живым браузером на amazon.es: €1,466.00 ('2 used & new offers', реальная 24GB XTX-версия — важно не спутать с похожими листингами RX 7900 XT 20GB и RX 9070 XT 16GB, которые Amazon подмешивает в те же результаты поиска под другим названием). Amazon.com показывал заметно дешевле — $899.99 (Sapphire Pulse, прямая продажа Amazon) — типичный пример разрыва цен US/EU для этой карты.",
         note="Лучшая цена/производительность среди новых consumer-карт — но ROCm/software support слабее CUDA"),
    dict(cat="Consumer/купить", name="AMD Radeon PRO W7900", arch="RDNA3", vram=48, bw=864, fp32=61.32, fp16d=122.6, fp16s="",
         price_hr="", price_buy=3799, eur_amzes="", market_note="AMD/BH официальный datasheet, прямой листинг B&H. FP16 — оценка ×2 от FP32 (double-rate RDNA3). Рынок б/у почти отсутствует (workstation-канал). На amazon.es не перепроверялась.",
         note="48GB — вдвое больше 3090 при похожей производительности на GB; для полных 70B-моделей без квантизации"),
    dict(cat="Consumer/купить", name="AMD Radeon PRO W7800", arch="RDNA3", vram=32, bw=576, fp32=44.7, fp16d=89.4, fp16s="",
         price_hr="", price_buy=2399, eur_amzes="", market_note="B&H прямой листинг: 32GB ECC, 576 GB/s. FP32/FP16 НЕ найдены напрямую — оценены масштабированием stream processors от W7900 — ниже точность. На amazon.es не перепроверялась.",
         note="Компромисс между 7900 XTX и W7900 — больше VRAM чем 3090, но медленнее W7900 из-за узкой 256-bit шины"),
    dict(cat="Consumer/купить", name="Nvidia Titan RTX", arch="Turing", vram=24, bw=672, fp32=16.3, fp16d=130, fp16s="",
         price_hr="", price_buy=1100, eur_amzes="", market_note="ПОДТВЕРЖДЕНО реальными листингами вне ES: ReSpec.io $919.97, eBay UK $1,600 ('10 available, 1 sold'). На amazon.es КАРТА НЕ НАЙДЕНА ВООБЩЕ — поиск 'Titan RTX' возвращает другую карту (GTX Titan X, 2015 года). Практически недоступна как реальная опция покупки в Испании — учитывать с этой оговоркой. FP16 130 TFLOPS подтверждено ОФИЦИАЛЬНО (nvidia.com/titan/titan-rtx и Newegg оба цитируют '130 Tensor TFLOPs'), не оценка.",
         note="Самый дешёвый вход в 24GB по факту оказался НЕ таким дешёвым, а на реальном рынке пользователя (Испания) карта вообще не продаётся — PCIe 3.0, устаревшие драйверы (апр. 2023), нет AV1"),
    dict(cat="Consumer/купить", name="Intel Arc Pro B60 24GB", arch="Xe2/Battlemage", vram=24, bw=456, fp32=12.28, fp16d=98.5, fp16s="",
         price_hr="", price_buy=790, eur_amzes=731, market_note="ПОДТВЕРЖДЕНО живым браузером на amazon.es: ASRock Creator 24GB €731.55 (рекомендованная цена €789.00). Amazon.com/Newegg/CentralComputer показывали $649.99-659.99 — близко, но испанская розница чуть дороже, как и для остальных карт. Intel ОФИЦИАЛЬНЫЙ datasheet для FP32/INT8. FP16 — оценка INT8/2, официально не публикуется. Совсем новая карта (янв. 2026), б/у рынка ещё нет.",
         note="Самая дешёвая НОВАЯ карта с 24GB в списке — но Xe2/XMX software stack для LLM менее зрелый, чем CUDA/ROCm"),
]

BASE_BW, BASE_COMPUTE = 936, 142

HEADER = [
    "Категория", "GPU", "Архитектура", "VRAM (GB)", "Пропускная способность памяти (GB/s)",
    "FP32 (TFLOPS)", "FP16 Tensor dense (TFLOPS)", "FP16 Tensor sparse (TFLOPS)",
    "vs 3090 — память (x)", "vs 3090 — вычисления (x)", "vs 3090 — комбинированно (x)",
    "Аренда, $/час", "Аренда, $/месяц (24/7, 730ч)", "Произв-ть аренды на $ (отн. 3090/час)",
    "Рыночная цена владения, $ (ориентир)", "Amazon.es, EUR (проверено вживую браузером)",
    "Окупаемость владения vs аренды, дней (24/7)",
    "Цена владения за 1x относит. производительности, $", "Комментарий", "Источник рыночной цены",
]

HEADER_DOCS = [
    "Cloud/ЦОД — карта из облачного прайс-листа (аренда по часам); Consumer/купить — карта, которую можно реально купить в розницу/на вторичном рынке как частное лицо, без корпоративной закупки.",
    "Модель GPU. Первая строка — базовая, собственная RTX 3090, коэффициенты relative считаются от неё.",
    "Архитектурное поколение (Turing/Ampere/Ada Lovelace/RDNA3/Xe2/Hopper/Blackwell) — определяет эффективность на такт и поддерживаемые точности (FP8/FP4).",
    "Объём видеопамяти. Критично для размера модели/контекста/батча, отдельно от скорости вычислений.",
    "Пиковая пропускная способность памяти. Генерация токенов (decode) в LLM обычно memory-bandwidth-bound — это часто важнее сырых TFLOPS.",
    "Пиковая производительность FP32 (CUDA/shader-ядра). Источник: официальные datasheet производителя, см. колонку источника при отклонениях.",
    "Пиковая производительность специализированных FP16-блоков (Tensor Cores/AI Accelerators/XMX) без structured sparsity. Часть значений для consumer-карт — производные оценки, см. источник.",
    "То же с 2:4 structured sparsity (где поддерживается — только Nvidia Ampere+). Пусто = не поддерживается архитектурой (AMD/Intel/Turing).",
    "Отношение пропускной способности памяти к RTX 3090 (936 GB/s). >1 = быстрее для memory-bound (decode) нагрузок.",
    "Отношение FP16 (dense) к RTX 3090 (142 TFLOPS). >1 = быстрее для compute-bound (prefill/training) нагрузок.",
    "Геометрическое среднее двух коэффициентов выше — грубая оценка практического ускорения для смешанной LLM-нагрузки (не заменяет реальный бенчмарк).",
    "Цена аренды в облаке, $/час — из прайс-листа instance types (скриншот пользователя). Пусто = карта не сдаётся в аренду как отдельный облачный instance type (consumer-карты).",
    "Цена аренды при непрерывной работе 24/7 в течение месяца — $/час × 730 часов (стандартная норма пересчёта в облачном биллинге, напр. AWS). Не учитывает скидки за резервирование/spot — только on-demand ставка.",
    "Комбинированный коэффициент производительности, делённый на цену аренды. Пусто там, где аренды нет.",
    "Ориентировочная цена покупки карты, USD. Для строк с заполненной колонкой Amazon.es — это она же, пересчитанная по курсу ~1.08 USD/EUR (ориентировочно); иначе — цена с Amazon.com/Newegg/B&H/CDW или community-оценка, см. источник.",
    "РЕАЛЬНАЯ цена, увиденная вживую через браузер (Playwright) на amazon.es при доставке в Испанию (Marbella), июль 2026 — не текстовый скрапинг, не агрегатор. Пусто = карта не проверялась на amazon.es (обычно enterprise/workstation-канал, нереалистично покупать через розничный Amazon) или не найдена в продаже там (см. комментарий по Titan RTX).",
    "Через сколько часов непрерывной (24/7) работы покупка карты окупается против аренды по указанной почасовой цене. 'н/д' = для карты нет облачной аренды для сравнения. Не учитывает электричество/охлаждение/простой.",
    "Рыночная цена покупки, делённая на комбинированный коэффициент производительности — сколько стоит купить один 'условный 3090-эквивалент' производительности в собственность. Ниже = выгоднее для владения. Считается для ВСЕХ карт, включая те без аренды.",
    "Практическое замечание по применимости карты для LLM-инференса/обучения.",
    "Диапазон цен и продавцы, на основе которых выбран ориентир в колонке рыночной цены; для расчётных (не официальных) спеков — явная пометка.",
]


def build_rows():
    out = [HEADER]
    for r in ROWS:
        bw_x = round(r["bw"] / BASE_BW, 2)
        compute_x = round(r["fp16d"] / BASE_COMPUTE, 2)
        combo_x = round((bw_x * compute_x) ** 0.5, 2)
        price_hr_month = round(r["price_hr"] * 730, 2) if r["price_hr"] != "" else ""
        perf_per_usd_hr = round(combo_x / r["price_hr"], 2) if r["price_hr"] != "" else ""
        breakeven_days = round(r["price_buy"] / r["price_hr"] / 24, 1) if r["price_hr"] != "" else "н/д"
        cost_per_unit_owned = round(r["price_buy"] / combo_x, 0)
        out.append([
            r["cat"], r["name"], r["arch"], r["vram"], r["bw"], r["fp32"], r["fp16d"], r["fp16s"],
            bw_x, compute_x, combo_x,
            r["price_hr"], price_hr_month, perf_per_usd_hr,
            r["price_buy"], r["eur_amzes"], breakeven_days, cost_per_unit_owned,
            r["note"], r["market_note"],
        ])
    return out


def main():
    sheets = build("sheets", "v4", credentials=credentials())
    ss = sheets.spreadsheets()

    meta = ss.get(spreadsheetId=SID, fields="sheets(properties(title,sheetId))").execute()
    existing = {sh["properties"]["title"]: sh["properties"]["sheetId"] for sh in meta["sheets"]}

    if TAB not in existing:
        rep = ss.batchUpdate(spreadsheetId=SID, body={"requests": [
            {"addSheet": {"properties": {"title": TAB}}}
        ]}).execute()
        sid = rep["replies"][0]["addSheet"]["properties"]["sheetId"]
    else:
        sid = existing[TAB]

    data = build_rows()
    ss.values().update(spreadsheetId=SID, range=f"'{TAB}'!A1",
                        valueInputOption="RAW", body={"values": data}).execute()

    fmt = [
        {"updateSheetProperties": {"properties": {
            "sheetId": sid, "gridProperties": {"frozenRowCount": 1, "frozenColumnCount": 1}},
            "fields": "gridProperties.frozenRowCount,gridProperties.frozenColumnCount"}},
        {"repeatCell": {
            "range": {"sheetId": sid, "startRowIndex": 0, "endRowIndex": 1},
            "cell": {"userEnteredFormat": {"textFormat": {"bold": True},
                     "backgroundColor": {"red": 0.85, "green": 0.89, "blue": 0.95},
                     "wrapStrategy": "WRAP", "verticalAlignment": "MIDDLE"}},
            "fields": "userEnteredFormat(textFormat,backgroundColor,wrapStrategy,verticalAlignment)"}},
        {"updateDimensionProperties": {
            "range": {"sheetId": sid, "dimension": "COLUMNS", "startIndex": 0, "endIndex": 1},
            "properties": {"pixelSize": 220}, "fields": "pixelSize"}},
        {"autoResizeDimensions": {"dimensions": {
            "sheetId": sid, "dimension": "COLUMNS", "startIndex": 1, "endIndex": len(HEADER)}}},
        {"updateCells": {
            "range": {"sheetId": sid, "startRowIndex": 0, "endRowIndex": 1,
                      "startColumnIndex": 0, "endColumnIndex": len(HEADER_DOCS)},
            "rows": [{"values": [{"note": d} for d in HEADER_DOCS]}], "fields": "note"}},
    ]
    ss.batchUpdate(spreadsheetId=SID, body={"requests": fmt}).execute()

    print(f"pushed tab '{TAB}': {len(data) - 1} rows")
    print(f"https://docs.google.com/spreadsheets/d/{SID}/edit")


if __name__ == "__main__":
    main()
