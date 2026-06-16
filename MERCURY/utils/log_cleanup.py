"""
Nettoyage automatique des anciens fichiers de logs texte rotated.
Cible : mercury.log.YYYY-MM-DD (rotation produite par TimedRotatingFileHandler).

⚠️ Les fichiers d'usage `usage_*.jsonl` sont explicitement EXCLUS — ils servent
à alimenter le dashboard (graph d'évolution, breakdowns) et ne doivent jamais
être supprimés par ce mécanisme.
"""
import logging
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

LOG_DIR = Path(__file__).resolve().parent.parent / "logs"
# Fichiers de rotation produits par TimedRotatingFileHandler : "mercury.log.2026-04-18"
_ROTATED_PATTERN = re.compile(r"^mercury\.log\.(\d{4}-\d{2}-\d{2})$")
# Garde-fou : on ne touche jamais aux JSONL d'usage.
_USAGE_PATTERN = re.compile(r"^usage_\d{4}-\d{2}-\d{2}\.jsonl$")


def cleanup_old_logs(retention_days: int) -> int:
    """Supprime les fichiers `mercury.log.YYYY-MM-DD` plus vieux que retention_days.
    Les `usage_*.jsonl` sont toujours conservés.
    Retourne le nombre de fichiers supprimés. 0 ou négatif = pas de nettoyage."""
    if retention_days <= 0:
        return 0
    if not LOG_DIR.exists():
        return 0

    cutoff = datetime.now(timezone.utc).date() - timedelta(days=retention_days)
    removed = 0

    for f in LOG_DIR.iterdir():
        if _USAGE_PATTERN.match(f.name):
            continue  # garde-fou explicite : ne jamais toucher aux usage JSONL
        match = _ROTATED_PATTERN.match(f.name)
        if not match:
            continue
        try:
            file_date = datetime.strptime(match.group(1), "%Y-%m-%d").date()
            if file_date < cutoff:
                f.unlink()
                removed += 1
                logger.info("Log cleanup: supprimé %s (> %d jours)", f.name, retention_days)
        except (ValueError, OSError) as e:
            logger.debug("Log cleanup: skip %s: %s", f.name, e)

    return removed
