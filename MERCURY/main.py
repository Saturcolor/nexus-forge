#!/usr/bin/env python3
"""
Point d'entrée : charge la config, lance le worker, monte l'app FastAPI et uvicorn.
Usage : python main.py
"""
import sys
import os
import asyncio
from pathlib import Path

if sys.version_info < (3, 10):
    sys.stderr.write(
        "Mercury requires Python 3.10+ — the code uses `X | None` runtime type "
        "annotations that raise TypeError at import time under 3.9.\n"
        f"Detected Python {sys.version_info.major}.{sys.version_info.minor}. "
        "macOS ships 3.9 as `python3`; create a venv with a newer interpreter "
        "(see DEMO.md).\n"
    )
    raise SystemExit(1)

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from config.logging_config import setup_logging

log = setup_logging()

from routing.router import load_config, get_config
from app_queue.request_queue import init_queue
from data import db as db_module


def main():
    db_module.load_db()
    config_path = Path(os.environ.get("MERCURY_CONFIG") or (ROOT / "config.yaml"))
    if not config_path.exists():
        example = ROOT / "config.yaml.example"
        if example.exists():
            log.warning("config.yaml absent — démarrage sur %s (exemple/démo)", example.name)
            config_path = example
    load_config(config_path)
    config = get_config()
    log.info("Config chargée depuis %s", config_path)
    host = config.get("server_host", "0.0.0.0")
    port = config.get("server_port", 17890)

    init_queue()

    from core.server import create_app, mount_admin_routes, mount_static
    app = create_app()
    mount_admin_routes(app)
    static_dir = ROOT / "frontend" / "dist"
    mount_static(app, static_dir)

    import uvicorn
    log.info("Démarrage sur %s:%s", host, port)
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()
