"""
Entrypoint brain-daemon (conforme CONVENTIONS §2 : entry point a la racine = main.py).

Ce fichier est un shim tres fin : toute la logique FastAPI reste dans daemon.py
(ne pas refactorer en Phase 4 — Phase 5 pour toucher a la logique).

Usage :
  uvicorn main:app --host 0.0.0.0 --port 4321

Le systemd unit et le healthcheck nexusctl pointent vers ce module.
"""
import sys

if sys.version_info < (3, 10):
    sys.stderr.write(
        "brain-daemon requires Python 3.10+ — the code uses `X | None` runtime "
        "type annotations that raise TypeError at import time under 3.9.\n"
        f"Detected Python {sys.version_info.major}.{sys.version_info.minor}. "
        "macOS ships 3.9 as `python3`; create a venv with a newer interpreter "
        "(see DEMO.md).\n"
    )
    raise SystemExit(1)

from daemon import app  # noqa: F401,E402  (re-export pour uvicorn main:app)
