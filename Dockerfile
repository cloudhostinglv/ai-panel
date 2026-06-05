# CloudHosting AI Panel — slim, non-root image.
FROM python:3.12-slim

# No bytecode files, unbuffered logs.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PANEL_PORT=8080

WORKDIR /app

# Install deps first for layer caching.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# App code (no secrets are baked in; the API key only ever lands in /data).
COPY app.py i18n.py providers.py ./
COPY templates/ ./templates/
COPY static/ ./static/
COPY locales/ ./locales/

# Run as a non-root user. uid/gid 10001 is unprivileged; the shared /data volume
# must be writable by this uid on the host (chown it at provision time).
RUN useradd --uid 10001 --user-group --no-create-home --shell /usr/sbin/nologin panel \
 && mkdir -p /data && chown panel:panel /data
USER panel

EXPOSE 8080

# PANEL_PORT is read by the shell at start; default 8080. Plain HTTP — TLS is
# terminated by Caddy in front. PANEL_PASSWORD must be set or the app exits.
CMD ["sh", "-c", "exec uvicorn app:app --host 0.0.0.0 --port ${PANEL_PORT:-8080}"]
