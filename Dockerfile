# Image of the langfAIx backend, built straight from the repository:
#
#   docker build -t langfaix-backend .
#
# The image also contains the Word add-in's pages, which the backend serves under /addin/.
# (backend/Dockerfile builds the same image from the archive made by deploy/pack-backend.ps1,
# for Docker hosts that cannot build from a Git checkout.)

FROM python:3.14.7-slim-bookworm

# No .pyc files; unbuffered logs, so they show up in `docker logs` at once.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /srv

# Install dependencies first: when only code changes, this layer comes from the cache.
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app ./app

# The add-in's pages, in the same layout as the repo, so that
# `import "../browser-extension/lib/xxx.js"` in word-addin/ resolves on the server too.
# The backend only serves .html, .js, .css and .png files from here (see find_addin_files
# in backend/app/main.py); tests and node_modules are excluded by .dockerignore.
COPY word-addin ./app/static/addin/word-addin
COPY browser-extension/lib ./app/static/addin/browser-extension/lib

# Do not run as root: a compromised service then holds limited rights.
RUN useradd --system --no-create-home appuser
USER appuser

EXPOSE 8000

# Health check: GET /healthz every 30 seconds.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz')"

# 0.0.0.0: accept connections from other containers (the reverse proxy).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
