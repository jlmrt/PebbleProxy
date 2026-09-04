FROM python:3.12.11-slim-bookworm

ARG TARGETARCH

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    NEEDLE_TELEMETRY=0 \
    DO_NOT_TRACK=1 \
    HF_HUB_OFFLINE=1 \
    NEEDLE_LIB_PATH=/opt/needle/libneedle.so

WORKDIR /app

COPY requirements.txt ./
COPY fetch_engine.py ./

RUN pip install --no-cache-dir --no-deps --require-hashes -r requirements.txt && \
    python fetch_engine.py "$TARGETARCH" /opt/needle/libneedle.so && \
    test -s /opt/needle/libneedle.so && \
    rm fetch_engine.py && \
    useradd --uid 1000 --create-home --shell /usr/sbin/nologin needle

COPY --chown=needle:needle server.py ./

USER needle

EXPOSE 8090

CMD ["python", "server.py"]
