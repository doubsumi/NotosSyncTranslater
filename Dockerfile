# ---- Build stage: frontend -------------------------------------------------
FROM node:20-alpine AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---- Runtime stage: Python backend + static SPA ---------------------------
FROM python:3.12-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    NST_STATIC_DIR=/srv/frontend/dist \
    NST_PORT=5000 \
    NST_HOST=0.0.0.0

WORKDIR /srv

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app ./app
COPY backend/run.py .

COPY --from=frontend /build/dist ./frontend/dist

EXPOSE 5000

# waitress is installed via requirements.txt; run.py prefers it automatically.
CMD ["python", "run.py", "--no-reload"]
