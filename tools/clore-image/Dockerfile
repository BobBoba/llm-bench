# Generic CUDA llama-server image for public GGUF models.
# Target GPUs: x86-64 NVIDIA, including RTX 5090/Blackwell (sm_120a).
FROM nvidia/cuda:13.0.2-cudnn-devel-ubuntu24.04 AS build
# CUDA 13.0 supports 120a, but not 121a. Include 86 for local RTX 3090 smoke tests.
#
# Список архитектур и зачем каждая. Арендованная карта — это то, что было на рынке в тот
# день, а отсутствие архитектуры даёт не медленный запасной путь, а жёсткий отказ:
# `CUDA error: no kernel image is available for execution on the device`, причём всплывает
# он только на первом декоде, уже после успешной загрузки модели. Ровно так прежний список
# `86-real;120a-real` повёл себя на CMP 170HX (GA100 = sm_80): ядра sm_86 на sm_80 не идут,
# а суффикс `-real` означает «только бинарные ядра», поэтому и PTX для JIT не осталось.
#   80   — A100, A30, CMP 170HX (серверный Ampere, GA100)
#   86   — RTX 3090, A10, A40 (потребительский и рабочий Ampere)
#   89   — RTX 4090, L40S (Ada)
#   90a  — H100, H200 (Hopper; вариант с `a` несёт специфичные для архитектуры возможности,
#          которыми пользуются ядра llama.cpp, обычная 90 их молча потеряет)
#   120a — RTX 5090 (потребительский Blackwell)
# `80-virtual` дополнительно кладёт в образ PTX, который драйвер может собрать на лету под
# любую архитектуру ≥ sm_80, не попавшую в список. Цена — одна медленная первая загрузка
# вместо падения; для железа, выбираемого в аренду за минуту, это верный размен.
ARG CMAKE_CUDA_ARCHITECTURES="80-real;86-real;89-real;90a-real;120a-real;80-virtual"
# The CUDA image has the driver stub as stubs/libcuda.so. The final link needs
# libcuda.so.1; this symlink is build-only. Clore's NVIDIA Container Toolkit
# supplies the real driver library at runtime.
ENV STUB=/usr/local/cuda/targets/x86_64-linux/lib/stubs
RUN ln -sf "$STUB/libcuda.so" "$STUB/libcuda.so.1"
RUN apt-get update && apt-get install -y --no-install-recommends \
        git cmake g++ \
    && rm -rf /var/lib/apt/lists/*
# Версия llama.cpp закреплена. Причина: пересборка ради ОДНОГО изменения (список архитектур)
# не должна заодно притаскивать новый upstream — иначе при разнице в поведении непонятно,
# что её вызвало. Обновлять сознательно: --build-arg LLAMA_CPP_REF=<sha или master>.
# ! Только ПОЛНЫЙ sha или имя ветки: `git fetch --depth 1 origin <короткий sha>` не работает,
#   и запасной путь «|| fetch master» МОЛЧА подменял закреплённую версию свежим master —
#   образ собирался не тем, что просили, а узнать об этом можно было только по --version.
#   Теперь при недостижимой ссылке сборка падает, а не притворяется успешной.
ARG LLAMA_CPP_REF=master
RUN git init /opt/llama.cpp \
    && git -C /opt/llama.cpp remote add origin https://github.com/ggml-org/llama.cpp \
    && git -C /opt/llama.cpp fetch --depth 1 origin "${LLAMA_CPP_REF}" \
    && git -C /opt/llama.cpp checkout FETCH_HEAD \
    && git -C /opt/llama.cpp log -1 --format='llama.cpp commit: %H' \
    && cmake -B /opt/llama.cpp/build -S /opt/llama.cpp \
        -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_CUDA_ARCHITECTURES="${CMAKE_CUDA_ARCHITECTURES}" \
        -DCMAKE_EXE_LINKER_FLAGS="-L${STUB} -Wl,-rpath-link,${STUB} -lcuda" \
    && cmake --build /opt/llama.cpp/build --target llama-server --config Release -j"$(nproc)"

FROM nvidia/cuda:13.0.2-cudnn-runtime-ubuntu24.04
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates libgomp1 python3 python3-pip \
    && python3 -m pip install --break-system-packages --no-cache-dir huggingface_hub \
    && rm -rf /var/lib/apt/lists/* /root/.cache
RUN mkdir -p /models
VOLUME ["/models"]
# llama-server is a thin launcher that loads sibling shared libraries.
COPY --from=build /opt/llama.cpp/build/bin/ /opt/bin/
RUN echo /opt/bin > /etc/ld.so.conf.d/llama-server.conf && ldconfig
COPY run-llama.py /opt/run-llama.py
COPY download-model.sh /opt/download-model.sh
COPY README.md /README.md
RUN chmod 0755 /opt/run-llama.py /opt/download-model.sh
EXPOSE 8080
CMD ["/opt/run-llama.py"]

# Диагностический набор для наблюдения за арендованной картой по SSH. Слой намеренно последний:
# правка списка инструментов не должна инвалидировать ни сборку llama.cpp, ни слои выше.
#
# ЗАЧЕМ ВООБЩЕ. Арендованная машина наблюдается только изнутри: ни Zabbix-агента, ни доступа к
# хосту там нет, а веб-панель Clore показывает счёт, но не то, чем занята карта. Без этих
# пакетов любая проверка вырождалась в трёхэтажные однострочники на `urllib` — именно из-за
# отсутствия `curl` проверка здоровья в рунбуке была расписана на пять строк питона.
#   nvtop     — занятость SM, видеопамяти и питания по времени; `nvidia-smi` даёт только срез
#   btop      — процессоры, память, диск и сеть в одном экране; RSS процесса виден без /proc
#   htop      — запасной вариант: btop требует юникодного терминала, htop идёт везде
#   iotop     — упирается ли загрузка модели в диск (13 ГиБ читаются с сетевого хранилища)
#   mc        — навигация по /models без десяти вызовов ls через ssh
#   curl      — проверки /health и /v1/*; отсутствие ощущалось на каждой диагностике
#   jq        — разбор ответов /slots и /props, где иначе не видно занятости слотов
#   ncdu      — диск арендованной машины конечен, а модели по 13 ГиБ копятся молча
#   tmux      — держать nvtop и журнал между подключениями; SSH к Clore рвётся при простое
#   iproute2  — `ss`: проверить, что сервер слушает именно 127.0.0.1, а не 0.0.0.0
#   lsof      — кто держит файл модели, когда её не удаётся заменить
#   rsync     — переносить веса между арендами вместо повторной выкачки с Hugging Face
#   less, vim-tiny, bash-completion, procps — минимум для правки конфига и чтения журнала
RUN apt-get update && apt-get install -y --no-install-recommends \
        nvtop btop htop iotop mc curl jq ncdu tmux iproute2 lsof rsync \
        less vim-tiny bash-completion procps \
    && rm -rf /var/lib/apt/lists/*
