#!/usr/bin/env python3
"""Пропускная способность при ПАРАЛЛЕЛЬНОЙ АГЕНТНОЙ нагрузке: длинные контексты, не короткие.

ЗАЧЕМ ОТДЕЛЬНЫЙ ЗАМЕР. Прежние измерения параллельности гоняли промпты по 27 токенов —
это меряет только декодирование. В агентной работе каждая сессия держит десятки-сотни тысяч
токенов, и слоты конкурируют за ОБЩИЙ пул KV: при нехватке ячеек движок пишет
`failed to find a memory slot ... retrying with smaller batch size` и сериализует запросы.
Значит для параллельной работы важен не только `--parallel`, но и ёмкость пула.

ВАЖНАЯ ПОПРАВКА к выводу 19.08 («пул сверх родного окна бесполезен»): он верен для ОДНОЙ
длинной сессии, потому что слот капится по n_ctx_train. При N слотах N длинных сессий требуют
N×длина ячеек, и вот тут пул сверх окна начинает работать. На 3090 его нельзя было поднять
(утечка в ОЗУ), на 5090 запас есть — это и проверяем.

Каждая точка: N одновременных РАЗНЫХ промптов заданной длины, замер суммарной скорости,
скорости на запрос, и признаков вытеснения (повторная предобработка вместо попадания в кэш).
"""
import json, random, subprocess, sys, threading, time, urllib.request

BIN = "/opt/bin/llama-server"
MODEL = "/models/Qwen3.8-27B-UD-Q3_K_XL.gguf"
PORT = 8099
KEY = open("/root/.apikey").read().strip()
URL = f"http://127.0.0.1:{PORT}/completion"
HEALTH = f"http://127.0.0.1:{PORT}/health"


def gpu(field="memory.used"):
    out = subprocess.run(["nvidia-smi", f"--query-gpu={field}", "--format=csv,noheader,nounits"],
                         capture_output=True, text=True).stdout.strip()
    return int(out.splitlines()[0]) if out else -1


def rss_mib(pid):
    try:
        for line in open(f"/proc/{pid}/status"):
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) // 1024
    except OSError:
        pass
    return -1


def make_prompt(seed, sentences):
    r = random.Random(seed)
    w = ["ledger", "turbine", "harbor", "quartz", "meadow", "cipher", "anvil", "lantern",
         "glacier", "pylon", "marrow", "fathom", "bramble", "zenith", "kiln", "verdict"]
    body = " ".join(f"Record {seed}-{i}: the {r.choice(w)} {r.choice(w)} measured {r.randint(1000,9999)} units."
                    for i in range(sentences))
    return body + "\n\nSummarise the three highest measured values you saw above."


# ! Таймаут держим умеренным. Час (как было) означает, что подвисший сервер крадёт час
#   стенного времени на КАЖДЫЙ застрявший запрос: при восьми сессиях кампания встаёт
#   намертво, а карта простаивает. Наблюдалось на точке с перегруженным пулом, где сервер
#   умер под пробуксовкой, а шесть рабочих потоков остались висеть на мёртвых сокетах.
def post(body, timeout=900):
    req = urllib.request.Request(URL, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json",
                                          "Authorization": f"Bearer {KEY}"})
    with urllib.request.urlopen(req, timeout=timeout) as r:  # nosec B310 — URL константа на loopback
        return json.load(r)


def healthy():
    try:
        req = urllib.request.Request(HEALTH, headers={"Authorization": f"Bearer {KEY}"})
        with urllib.request.urlopen(req, timeout=3) as r:  # nosec B310 — URL константа на loopback
            return json.load(r).get("status") == "ok"
    except Exception:
        return False


def wait_free():
    for _ in range(80):
        if gpu() < 800 and subprocess.run(["pgrep", "-x", "llama-server"], capture_output=True).returncode != 0:
            return True
        time.sleep(3)
    return False


def run_point(pool, slots, conc, sentences, n_predict=200, extra=None):
    if not wait_free():
        return {"error": "карта не освободилась"}
    tag = f"{pool}-{slots}-{conc}" + ("-" + extra.replace(" ", "").replace("-", "") if extra else "")
    log = open(f"/tmp/cc-{tag}.log", "w")
    proc = subprocess.Popen([BIN, "-m", MODEL, "--host", "127.0.0.1", "--port", str(PORT),
                             "--api-key", KEY, "-c", str(pool), "--cache-type-k", "q4_0",
                             "--cache-type-v", "q4_0", "--flash-attn", "on", "--jinja",
                             "-ngl", "-1", "--kv-unified", "--parallel", str(slots),
                             "--spec-type", "draft-mtp", "--spec-draft-n-max", "2",
                             "--min-p", "0", "--top-k", "20", "--top-p", "0.95", "--temp", "1.0"]
                            + (extra.split() if extra else []),
                            stdout=log, stderr=subprocess.STDOUT)
    for _ in range(200):
        time.sleep(2)
        if healthy():
            break
        if proc.poll() is not None:
            return {"error": "процесс завершился при загрузке"}
    else:
        proc.terminate()
        return {"error": "не дождались готовности"}

    vram_idle = gpu()
    prompts = [make_prompt(100 + i, sentences) for i in range(conc)]
    outs = [None] * conc
    utils = []
    stop = threading.Event()

    def sample():
        while not stop.is_set():
            utils.append(gpu("utilization.gpu"))
            time.sleep(0.5)

    def worker(i):
        try:
            outs[i] = post({"prompt": prompts[i], "n_predict": n_predict,
                            "temperature": 0, "cache_prompt": True})
        except Exception as e:
            outs[i] = {"error": str(e)[:120]}

    th = threading.Thread(target=sample, daemon=True); th.start()
    t0 = time.time()
    ths = [threading.Thread(target=worker, args=(i,)) for i in range(conc)]
    [t.start() for t in ths]; [t.join() for t in ths]
    wall = time.time() - t0
    stop.set(); th.join(timeout=2)

    ok = [o for o in outs if o and "timings" in o]
    res = {
        "pool": pool, "slots": slots, "conc": conc, "extra": extra or "",
        "prompt_tok": ok[0]["tokens_evaluated"] if ok else None,
        "vram": vram_idle, "vram_peak": gpu(), "rss": rss_mib(proc.pid),
        "wall_s": round(wall, 1),
        "total_gen_tps": round(sum(o["timings"]["predicted_n"] for o in ok) / wall, 1) if ok else 0,
        "total_prefill_tps": round(sum(o["timings"]["prompt_n"] for o in ok) / wall, 1) if ok else 0,
        "each_gen_tps": [round(o["timings"]["predicted_per_second"], 1) for o in ok],
        "gpu_util_median": sorted(utils)[len(utils) // 2] if utils else None,
        "errors": [o.get("error") for o in outs if o and "error" in o],
    }
    # прямой признак нехватки ячеек: движок сам сообщает о дроблении пакета
    txt = open(f"/tmp/cc-{tag}.log", errors="replace").read()
    res["cell_pressure"] = txt.count("failed to find a memory slot")
    proc.terminate()
    try:
        proc.wait(timeout=90)
    except subprocess.TimeoutExpired:
        proc.kill()
    return res


def main():
    points = json.load(open(sys.argv[1]))
    out_path = sys.argv[2]
    results = []
    for p in points:
        r = run_point(**p)
        results.append(r)
        json.dump(results, open(out_path, "w"), ensure_ascii=False, indent=1)
        print(json.dumps(r, ensure_ascii=False), flush=True)
    print("ЗАВЕРШЕНО", flush=True)


if __name__ == "__main__":
    main()
