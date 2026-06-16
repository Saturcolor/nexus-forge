"""Voice profiles store : SQLite + WAV refs on disk.

Schema :
  id           TEXT PK    'clone:<slug>' (URL-safe, stable)
  name         TEXT       human label ("Alice", "GLaDOS")
  ref_path     TEXT       path to reference WAV (5-15s)
  ref_text    TEXT        transcript of the reference
  language     TEXT       ISO code or 'auto'
  instruct     TEXT       optional voice-design instruct ("warm tone, slow")
  description  TEXT       optional free-form description
  master       TEXT       DSP preset id ('warm'/'broadcast'/'raw'/...)
  tags         TEXT       JSON-array, freeform
  created_at   INTEGER    unix epoch s
  locked       INTEGER    0|1 — if 1, ref_path is canonical and shouldn't be replaced

Profiles live under VOICES_DIR (default ~/.local/share/brain-daemon/voices).
The DB lives at <VOICES_DIR>/profiles.db. Profile ids prefixed 'clone:' so Mercury
can detect them in the voice= field and route to OmniVoice instead of Kokoro.
"""
from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import time
from pathlib import Path
from typing import Optional

logger = logging.getLogger("brain-daemon")

DEFAULT_VOICES_DIR = os.path.expanduser("~/.local/share/brain-daemon/voices")


_SCHEMA = """
CREATE TABLE IF NOT EXISTS voice_profiles (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  ref_path     TEXT,
  ref_text     TEXT,
  language     TEXT DEFAULT 'auto',
  instruct     TEXT,
  description  TEXT,
  master       TEXT DEFAULT 'raw',
  speed        REAL DEFAULT 1.0,
  tags         TEXT DEFAULT '[]',
  created_at   INTEGER NOT NULL,
  locked       INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_profiles_created ON voice_profiles (created_at DESC);
"""

# Migrations idempotentes pour les DBs existantes créées avant l'ajout d'une colonne.
# Liste : (col_name, ddl_fragment). On essaie chaque ALTER, on ignore "duplicate column".
_MIGRATIONS: list[tuple[str, str]] = [
    ("speed", "ALTER TABLE voice_profiles ADD COLUMN speed REAL DEFAULT 1.0"),
]


def _slug(s: str) -> str:
    s = s.strip().lower()
    s = re.sub(r"[^a-z0-9]+", "_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    return s or "voice"


class VoiceProfileStore:
    """Thin SQLite wrapper. All paths absolute under voices_dir."""

    def __init__(self, voices_dir: str = DEFAULT_VOICES_DIR):
        self.voices_dir = Path(voices_dir).expanduser()
        self.voices_dir.mkdir(parents=True, exist_ok=True)
        self.db_path = self.voices_dir / "profiles.db"
        self._conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript(_SCHEMA)
        self._run_migrations()
        logger.info("VoiceProfileStore: %s", self.db_path)

    def _run_migrations(self) -> None:
        existing = {r[1] for r in self._conn.execute("PRAGMA table_info(voice_profiles)").fetchall()}
        for col_name, ddl in _MIGRATIONS:
            if col_name in existing:
                continue
            try:
                self._conn.execute(ddl)
                self._conn.commit()
                logger.info("VoiceProfileStore: migrated column '%s'", col_name)
            except sqlite3.OperationalError as e:
                # Race or already-applied — log and continue
                logger.warning("VoiceProfileStore migration '%s' skipped: %s", col_name, e)

    def list(self) -> list[dict]:
        rows = self._conn.execute(
            "SELECT * FROM voice_profiles ORDER BY created_at DESC"
        ).fetchall()
        return [self._row_to_dict(r) for r in rows]

    def get(self, profile_id: str) -> Optional[dict]:
        row = self._conn.execute(
            "SELECT * FROM voice_profiles WHERE id = ?", (profile_id,)
        ).fetchone()
        return self._row_to_dict(row) if row else None

    def create(
        self,
        *,
        name: str,
        ref_wav_bytes: Optional[bytes],
        ref_text: Optional[str],
        language: str = "auto",
        instruct: Optional[str] = None,
        description: Optional[str] = None,
        master: str = "raw",
        speed: float = 1.0,
        tags: Optional[list[str]] = None,
    ) -> dict:
        """Create a profile. Writes ref WAV under voices_dir/<id>.wav."""
        base_id = "clone:" + _slug(name)
        profile_id = base_id
        i = 2
        while self.get(profile_id) is not None:
            profile_id = f"{base_id}_{i}"
            i += 1

        ref_path: Optional[str] = None
        if ref_wav_bytes:
            fname = f"{profile_id.replace(':', '_')}.wav"
            full = self.voices_dir / fname
            full.write_bytes(ref_wav_bytes)
            ref_path = str(full)

        self._conn.execute(
            """INSERT INTO voice_profiles
               (id, name, ref_path, ref_text, language, instruct, description, master, speed, tags, created_at, locked)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)""",
            (
                profile_id, name, ref_path, ref_text, language,
                instruct, description, master, float(speed), json.dumps(tags or []),
                int(time.time()),
            ),
        )
        self._conn.commit()
        logger.info("VoiceProfile created: %s (ref=%s)", profile_id, bool(ref_path))
        return self.get(profile_id)  # type: ignore[return-value]

    def update(self, profile_id: str, **fields) -> Optional[dict]:
        allowed = {"name", "ref_text", "language", "instruct", "description", "master", "speed", "tags", "locked"}
        sets, vals = [], []
        for k, v in fields.items():
            if k not in allowed:
                continue
            if k == "tags":
                v = json.dumps(v or [])
            elif k == "speed" and v is not None:
                try:
                    v = float(v)
                except (TypeError, ValueError):
                    continue
            sets.append(f"{k} = ?")
            vals.append(v)
        if not sets:
            return self.get(profile_id)
        vals.append(profile_id)
        self._conn.execute(
            f"UPDATE voice_profiles SET {', '.join(sets)} WHERE id = ?", vals,
        )
        self._conn.commit()
        return self.get(profile_id)

    def delete(self, profile_id: str) -> bool:
        row = self.get(profile_id)
        if not row:
            return False
        if row.get("ref_path"):
            try:
                Path(row["ref_path"]).unlink(missing_ok=True)
            except Exception as e:
                logger.warning("Failed to remove ref WAV %s: %s", row["ref_path"], e)
        self._conn.execute("DELETE FROM voice_profiles WHERE id = ?", (profile_id,))
        self._conn.commit()
        logger.info("VoiceProfile deleted: %s", profile_id)
        return True

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict:
        d = dict(row)
        try:
            d["tags"] = json.loads(d.get("tags") or "[]")
        except Exception:
            d["tags"] = []
        d["locked"] = bool(d.get("locked"))
        try:
            d["speed"] = float(d.get("speed") if d.get("speed") is not None else 1.0)
        except (TypeError, ValueError):
            d["speed"] = 1.0
        return d

    def close(self):
        try:
            self._conn.close()
        except Exception:
            pass
