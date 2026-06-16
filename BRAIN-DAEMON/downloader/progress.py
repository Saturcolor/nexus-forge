"""Exception de cancel (garde pour future impl) — le progress est pollé
directement depuis le disque dans jobs.py, pas via tqdm."""


class DownloadCancelled(Exception):
    """Raised quand le user demande cancel pendant un download en cours."""
