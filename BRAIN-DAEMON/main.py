"""
Entrypoint brain-daemon (conforme CONVENTIONS §2 : entry point a la racine = main.py).

Ce fichier est un shim tres fin : toute la logique FastAPI reste dans daemon.py
(ne pas refactorer en Phase 4 — Phase 5 pour toucher a la logique).

Usage :
  uvicorn main:app --host 0.0.0.0 --port 4321

Le systemd unit et le healthcheck nexusctl pointent vers ce module.
"""

from daemon import app  # noqa: F401  (re-export pour uvicorn main:app)
