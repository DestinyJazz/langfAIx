# Image of the langfAIx backend (FastAPI).

# Official Python, slim variant. The same Python version the tests run on.
FROM python:3.14.7-slim-bookworm

# No .pyc files; unbuffered logs, so they show up in `docker logs` at once.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /srv

# Install dependencies first: when only code changes, this layer comes from the cache.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Do not run as root: a compromised service then holds limited rights.
RUN useradd --system --no-create-home appuser
USER appuser

EXPOSE 8000

# Health check: GET /healthz every 30 seconds.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz')"

# 0.0.0.0: accept connections from other containers (the reverse proxy).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
