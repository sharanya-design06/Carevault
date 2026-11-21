FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

WORKDIR /app

COPY ai_service/requirements.txt /app/ai_service/requirements.txt
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir -r /app/ai_service/requirements.txt

COPY ai_service/ /app/ai_service/
COPY db_drug_interactions.csv /app/db_drug_interactions.csv
COPY public/ /app/public/

RUN useradd --create-home --uid 10001 carevault \
    && chown -R carevault:carevault /app
USER carevault

CMD ["sh", "-c", "exec uvicorn ai_service.app:app --host 0.0.0.0 --port ${PORT:-8080}"]
