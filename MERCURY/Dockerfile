# Mercury — demo image: broker API + admin UI, in DEMO_MODE (no real LLM backend).

# Stage 1 — build the admin frontend (served statically by the backend).
FROM node:22 AS frontend
WORKDIR /fe
COPY frontend/ ./
RUN npm install && npm run build

# Stage 2 — python runtime.
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
# Built SPA — main.py mounts it at "/" (StaticFiles html=True).
COPY --from=frontend /fe/dist ./frontend/dist
# DEMO_MODE: canned responses, no GPU/cloud. Config falls back to config.yaml.example.
ENV MERCURY_DEMO_MODE=1
EXPOSE 17890
CMD ["python", "main.py"]
