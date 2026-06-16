"""Expose la version de MERCURY depuis le fichier VERSION."""

from pathlib import Path

_DEFAULT_VERSION = "0.0.0"
_VERSION_FILE = Path(__file__).resolve().parent.parent / "VERSION"


def _read_version() -> str:
    try:
        version = _VERSION_FILE.read_text(encoding="utf-8").strip()
        return version or _DEFAULT_VERSION
    except OSError:
        return _DEFAULT_VERSION


__version__ = _read_version()
