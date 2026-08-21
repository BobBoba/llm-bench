#!/usr/bin/env python3
"""Измеритель параметров llama-server. Один прогон = список конфигураций из JSON-файла.

Почему на Python, а не на bash с curl: в контейнере Clore нет curl, зато есть python3. Заодно
выигрыш по существу — /completion возвращает объект `timings` с готовыми скоростями, поэтому
цифры берутся из ответа сервера, а не разбираются регулярками из журнала.

Каждая точка меряется одинаково: прогрев, затем одиночный запрос, затем N одновременных.
Снимаются VRAM, RSS процесса и загрузка GPU во время генерации — пара «RSS + простой GPU»
это единственный надёжный признак утечки KV-кэша в оперативную память (замер на 3090 19.08:
видеопамять выглядела нормально, а скорость падала втрое).
"""
import json, os, signal, subprocess, sys, threading, time, urllib.request, urllib.error

BIN = "/opt/bin/llama-server"
MODEL = "/models/Qwen3.8-27B-UD-Q3_K_XL.gguf"
PORT = 8099
KEY = open("/root/.apikey").read().strip()
PROMPT = ("Write a detailed technical description of how a modern turbofan jet engine works, "
          "covering the fan, compressor, combustor and turbine stages.")


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


# Белый список путей: urllib понимает и file://, поэтому URL не должен собираться из чего-то,
# что приходит извне. Схема и хост здесь константы, а путь ограничен этим словарём.
ENDPOINTS = {"completion": f"http://127.0.0.1:{PORT}/completion",
             "health": f"http://127.0.0.1:{PORT}/health"}


def post(endpoint, body, timeout=1800):
    req = urllib.request.Request(ENDPOINTS[endpoint],
                                 data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json",
                                          "Authorization": f"Bearer {KEY}"})
    with urllib.request.urlopen(req, timeout=timeout) as r:  # nosec B310 — URL из ENDPOINTS
        return json.load(r)


def healthy():
    try:
        req = urllib.request.Request(ENDPOINTS["health"],
                                     headers={"Authorization": f"Bearer {KEY}"})
        with urllib.request.urlopen(req, timeout=3) as r:  # nosec B310 — URL из ENDPOINTS
            return json.load(r).get("status") == "ok"
    except Exception:
        return False


def wait_gpu_free(limit=800, tries=80):
    # ! kill только ОТПРАВЛЯЕТ сигнал: занятый сервер умирает не сразу, и следующая точка
    #   стартует поверх него, меряя две модели на одной карте правдоподобными числами.
    for _ in range(tries):
        n = subprocess.run(["pgrep", "-x", "llama-server"], capture_output=True).returncode
        if gpu() < limit and n != 0:
            return True
        time.sleep(3)
    return False


def probe(prompt, n_predict, cache=False):
    t0 = time.time()
    r = post("completion", {"prompt": prompt, "n_predict": n_predict,
                             "temperature": 0, "cache_prompt": cache})
    return {"wall": round(time.time() - t0, 2), "t": r.get("timings", {}),
            "predicted": r.get("tokens_predicted"), "evaluated": r.get("tokens_evaluated")}


def run_point(name, args, concurrency=2, n_predict=300, long_prompt=None, model=MODEL):
    if not wait_gpu_free():
        return {"name": name, "error": "карта не освободилась"}
    log = open(f"/tmp/log-{name}.txt", "w")
    proc = subprocess.Popen([BIN, "-m", model, "--host", "127.0.0.1", "--port", str(PORT),
                             "--api-key", KEY] + args, stdout=log, stderr=subprocess.STDOUT)
    for _ in range(150):
        time.sleep(2)
        if healthy():
            break
        if proc.poll() is not None:
            return {"name": name, "error": "процесс завершился при загрузке",
                    "tail": open(f"/tmp/log-{name}.txt").read()[-600:]}
    else:
        proc.send_signal(signal.SIGTERM)
        return {"name": name, "error": "не дождались готовности"}

    # ! Точка может умереть В ПРОЦЕССЕ, а не при загрузке: например при ручном --n-cpu-moe
    #   автоподборщик размещения отключается ("tensor_buft_overrides already set by user"),
    #   и нехватка памяти всплывает уже на первом decode. Одна такая точка не должна ронять
    #   всю кампанию — иначе теряются и уже снятые, и все последующие измерения.
    res = {"name": name, "args": " ".join(args), "vram_idle": gpu()}
    slots = [l for l in open(f"/tmp/log-{name}.txt") if "n_ctx_slot" in l]
    res["slots"] = slots[0].split("initializing,")[-1].strip() if slots else "?"

    probe(PROMPT, 100)                                   # прогрев
    utils = []
    stop = threading.Event()
    def sample():
        while not stop.is_set():
            utils.append(gpu("utilization.gpu"))
            time.sleep(0.4)
    th = threading.Thread(target=sample, daemon=True); th.start()

    one = probe(PROMPT, n_predict)
    res["single_tps"] = round(one["t"].get("predicted_per_second", 0), 1)

    outs = [None] * concurrency
    def worker(i):
        outs[i] = probe(PROMPT + f" Detail aspect number {i}.", n_predict)
    t0 = time.time()
    ths = [threading.Thread(target=worker, args=(i,)) for i in range(concurrency)]
    [t.start() for t in ths]; [t.join() for t in ths]
    wall = time.time() - t0
    stop.set(); th.join(timeout=2)

    res["conc_total_tps"] = round(concurrency * n_predict / wall, 1)
    res["conc_each_tps"] = [round(o["t"].get("predicted_per_second", 0), 1) for o in outs if o]
    res["gpu_util_top"] = sorted(utils)[-3:] if utils else []
    res["rss_mib"] = rss_mib(proc.pid)
    res["vram_peak"] = gpu()

    if long_prompt:
        lp = probe(long_prompt, 32)
        res["long_prompt_tok"] = lp["evaluated"]
        res["prefill_tps"] = round(lp["t"].get("prompt_per_second", 0), 1)

    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=60)
    except subprocess.TimeoutExpired:
        proc.kill()
    return res


def main():
    cfg = json.load(open(sys.argv[1]))
    out_path = sys.argv[2]
    long_prompt = None
    if cfg.get("long_prompt_sentences"):
        import random
        r = random.Random(11)
        w = ["ledger", "turbine", "harbor", "quartz", "meadow", "cipher", "anvil", "lantern",
             "glacier", "pylon", "marrow", "fathom", "bramble", "zenith", "kiln", "verdict"]
        long_prompt = " ".join(
            f"Record {i}: the {r.choice(w)} {r.choice(w)} measured {r.randint(1000,9999)} units."
            for i in range(cfg["long_prompt_sentences"]))

    results = []
    for point in cfg["points"]:
        try:
            res = run_point(point["name"], point["args"].split(),
                            concurrency=point.get("concurrency", 2),
                            n_predict=point.get("n_predict", 300),
                            long_prompt=long_prompt if point.get("long") else None,
                            model=point.get("model", MODEL))
        except Exception as e:
            res = {"name": point["name"], "error": f"{type(e).__name__}: {e}"}
            subprocess.run(["pkill", "-x", "llama-server"])
        results.append(res)
        with open(out_path, "w") as f:
            json.dump(results, f, ensure_ascii=False, indent=1)
        print(json.dumps(res, ensure_ascii=False), flush=True)
    print("ЗАВЕРШЕНО", flush=True)


if __name__ == "__main__":
    main()
