FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

COPY agent-service/requirements.txt ./requirements.txt
# pywinpty is only needed by the Windows-only interactive terminal endpoint.
RUN sed -i '/^pywinpty/d' requirements.txt \
    && pip install --no-cache-dir -r requirements.txt
COPY agent-service/app ./app

RUN useradd --system --uid 10002 cloudtool-agent \
    && mkdir -p /app/data \
    && chown -R cloudtool-agent:cloudtool-agent /app

USER cloudtool-agent
EXPOSE 8004
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8004", "--workers", "1"]
