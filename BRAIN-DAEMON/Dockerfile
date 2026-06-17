# brain-daemon — demo image: inference daemon in BRAIN_DEMO_MODE (no GPU, no llama-server, no model).
#
# NOTE: outside demo mode brain-daemon targets AMD Strix Halo hardware (gfx1151, UMA, sysfs thermal —
# see BRAIN-DAEMON/README.md). This image exists ONLY to run the fake demo path inside the
# one-command stack; it does not and cannot exercise the real hardware backends in a container.
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
# DEMO_MODE: canned responses, no GPU/subprocess. Config is optional in demo mode (falls back to defaults).
ENV BRAIN_DEMO_MODE=1
EXPOSE 4321
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "4321"]
