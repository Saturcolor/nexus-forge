"""
Configuration des logs : fichier (rotation journalière, 30 jours) + console.
Fichier : logs/mercury.log (créé au démarrage).
"""
import logging
import logging.handlers
import sys
from pathlib import Path

LOG_DIR = Path(__file__).resolve().parent.parent / "logs"
LOG_FILE = LOG_DIR / "mercury.log"
LOG_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
DATE_FORMAT = "%Y-%m-%d %H:%M:%S"


def setup_logging(level: int = logging.INFO) -> logging.Logger:
    """Configure le logging global ; retourne le logger de l'app."""
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    root = logging.getLogger()
    root.setLevel(level)
    if root.handlers:
        return logging.getLogger("mercury")

    formatter = logging.Formatter(LOG_FORMAT, datefmt=DATE_FORMAT)

    ch = logging.StreamHandler(sys.stderr)
    ch.setLevel(level)
    ch.setFormatter(formatter)
    root.addHandler(ch)

    fh = logging.handlers.TimedRotatingFileHandler(
        LOG_FILE,
        when="midnight",
        interval=1,
        backupCount=30,
        encoding="utf-8",
    )
    fh.setLevel(level)
    fh.setFormatter(formatter)
    root.addHandler(fh)

    logger = logging.getLogger("mercury")
    logger.setLevel(level)
    # Éviter le flood INFO des requêtes HTTP sortantes (httpx)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    return logger
