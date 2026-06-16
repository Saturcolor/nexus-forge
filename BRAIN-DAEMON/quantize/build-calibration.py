#!/usr/bin/env python3
"""
build-calibration.py — construit un corpus de calibration custom depuis
shared-memory (ou n'importe quel dossier de markdown/txt).

v2 (2026-04-17) — refonte qualité :
  - filtres bruit étendus (bridge Claude, relevant-memories, panels runtime…)
  - dédup quasi-doublons via MinHash+LSH (datasketch)
  - équilibrage des buckets (cap ratio par sous-dossier)
  - qualité paragraphe : min 80 ch, alnum-ratio, split phrases si > max
  - drop du bloc ## Summary quand ## Full Conversation suit (dédup structurel)
  - --dry-run (pas d'écriture + sample pour inspection)
  - manifest JSON à côté de la sortie

Usage :
  ./build-calibration.py                               # utilise config.yaml
  ./build-calibration.py --source ~/autre/dossier
  ./build-calibration.py --dry-run --stats
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import sys
from datetime import datetime, timezone

# Windows: force stdout/stderr UTF-8 pour que rich puisse écrire → ✓ ⚠ ─ sans crash cp1252
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import yaml
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.progress import Progress, SpinnerColumn, BarColumn, TextColumn, MofNCompleteColumn

# datasketch est optionnel — si absent on retombe sur dédup SHA1 exact seul.
try:
    from datasketch import MinHash, MinHashLSH  # type: ignore
    HAS_DATASKETCH = True
except ImportError:
    HAS_DATASKETCH = False

console = Console()

SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_PATH = SCRIPT_DIR / "config.yaml"
SCRIPT_VERSION = "2.0.0"


# ────────────────────────────────────────────────────────────────────────────
# Filtres ligne par ligne / bloc par bloc
# ────────────────────────────────────────────────────────────────────────────

# Frontmatter YAML en tête de fichier
RE_FRONTMATTER = re.compile(r"\A---\r?\n.*?\r?\n---\r?\n", re.DOTALL)

# Blocs ### TOOL (...) jusqu'au prochain ### ou fin de fichier (conversations)
RE_TOOL_BLOCK = re.compile(
    r"^###\s+TOOL\s*\(.*?\)\s*\n.*?(?=^###\s+(USER|ASSISTANT|TOOL|SYSTEM)\s*\(|\Z)",
    re.MULTILINE | re.DOTALL,
)

# En-têtes de tour dans conversations consolidées (on les drop entièrement,
# sinon "USER" et "ASSISTANT" deviennent des tokens sur-représentés)
RE_TURN_HEADER = re.compile(
    r"^###\s+(USER|ASSISTANT|SYSTEM)\s*\(.*?\)\s*\n",
    re.MULTILINE,
)

# Headers bridge Claude app (exports type "discussions.anthropic.com")
# "**You:**" ou "**Assistant:**" seuls sur leur ligne.
RE_BRIDGE_TURN = re.compile(r"^\*\*(You|Assistant):\*\*\s*$", re.MULTILINE)

# Header de fichier "# Conversation Archive — DATE"
RE_CONV_ARCHIVE_HEADER = re.compile(
    r"^#\s+Conversation Archive\s+[—\-].*$", re.MULTILINE
)

# Bloc métadonnées session Mastermind/Telegram — du header jusqu'au
# prochain titre ou double blank. Attrape :
#   # Session: 2026-02-28 09:46:27 UTC
#   - **Session Key**: ...
#   - **Session ID**: ...
#   - **Source**: telegram
RE_SESSION_META_BLOCK = re.compile(
    r"^#\s+Session:\s+\d{4}-\d{2}-\d{2}.*?(?=\n\s*##|\n\s*\n\s*\n|\Z)",
    re.DOTALL | re.MULTILINE,
)

# Blocs <relevant-memories>...</relevant-memories> (memory injection agent)
RE_RELEVANT_MEMORIES = re.compile(
    r"<relevant-memories>.*?</relevant-memories>", re.DOTALL | re.IGNORECASE
)

# Blocs <system-reminder>...</system-reminder>
RE_SYSTEM_REMINDER = re.compile(
    r"<system-reminder>.*?</system-reminder>", re.DOTALL | re.IGNORECASE
)

# Panels Mastermind runtime : "**Options actives de la session**" ou
# "**Runtime**" suivis d'un code fence. Contenu = /think, Tok/s, Modèle, etc.
RE_MASTERMIND_PANEL = re.compile(
    r"\*\*(?:Options actives de la session|Runtime)\*\*\s*\n```[^\n]*\n.*?\n```",
    re.DOTALL,
)

# Bloc ## Summary jusqu'au début de ## Full Conversation. Les archives
# Mastermind contiennent les DEUX : le Summary est une synthèse LLM du
# Full Conversation — drop le Summary pour éviter near-duplication massive.
RE_SUMMARY_BEFORE_FULL = re.compile(
    r"^##\s+Summary\s*\n.*?(?=^##\s+Full Conversation\s*$)",
    re.MULTILINE | re.DOTALL,
)

# Messages système caractéristiques du setup brain-daemon
RE_SYSTEM_NOISE_LINES = [
    re.compile(r"^\[Contexte compacté le .*\]$", re.MULTILINE),
    re.compile(r"^✓\s+(model|mémoire|memoire|Contexte compacté)\s*(→|:).*$", re.MULTILINE),
    re.compile(r"^✓ Contexte compacté:.*$", re.MULTILINE),
    # Format Telegram bridge : [user]/[assistant]/[tool]/[system] [HH:MM] ...
    re.compile(r"^\[(user|assistant|tool|system)\]\s*\[\d{1,2}:\d{2}\].*$", re.MULTILINE | re.IGNORECASE),
    # Headers de session : "### [agentname] Session: <uuid>"
    re.compile(r"^###\s+\[\w+\]\s+Session:.*$", re.MULTILINE),
    # Annonces de session
    re.compile(r"^.*New session started.*$", re.MULTILINE),
    re.compile(r"^.*A new session was started via /new or /reset.*$", re.MULTILINE),
    re.compile(r"^.*Execute your Session Startup sequence.*$", re.MULTILINE),
    # Tags model:... des bridges
    re.compile(r"^.*model:\s*(lmstudio|llamacpp|openrouter)/.*$", re.MULTILINE),
    # Préfixes bridge Telegram "user: ...", "assistant: ...", "A: ...", "U: ..."
    # (en début de ligne uniquement — on ne touche pas à "user:" en milieu de phrase).
    # Évite les faux-positifs sur des URL (http://) en exigeant un espace non-slash après.
    re.compile(r"^(user|assistant|tool|system|A|U):\s+(?=\S)(?![/\\])", re.MULTILINE | re.IGNORECASE),
]

# Blocs JSON de metadata de message (format Telegram bridge)
RE_METADATA_JSON_BLOCK = re.compile(
    r"Conversation info \(untrusted metadata\):\s*```json.*?```",
    re.DOTALL | re.IGNORECASE,
)

# Blocs <think>...</think> (reasoning mode des modèles) — on les drop entièrement
# parce que c'est souvent du raisonnement interne décousu, pas représentatif de
# la prose finale qu'on veut calibrer.
RE_THINK_BLOCK = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
# Tags <think> orphelins (fermants sans ouvrants et vice versa)
RE_ORPHAN_THINK = re.compile(r"</?think>", re.IGNORECASE)

# Timestamps isolés (format JS toString / ISO)
RE_TIMESTAMP_LINE = re.compile(
    r"^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\w+\s+\d+\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT.*$",
    re.MULTILINE,
)

# Séparateurs horizontaux markdown seuls sur leur ligne
RE_HR_LINE = re.compile(r"^---+\s*$", re.MULTILINE)

# Lignes de dump `ls -F` du shared-memory (`d  dirname` / `f  filename`)
# On les détecte en cluster (3+ consécutives) pour pas amputer du vrai texte
RE_LS_DUMP_CLUSTER = re.compile(
    r"(?:^[df]\s+\S.*\n){3,}",
    re.MULTILINE,
)


def strip_noise(text: str) -> tuple[str, dict[str, int]]:
    """Applique tous les filtres de bruit machine. Retourne texte + stats."""
    stats: dict[str, int] = defaultdict(int)

    # Frontmatter
    if RE_FRONTMATTER.search(text):
        text, n = RE_FRONTMATTER.subn("", text, count=1)
        stats["frontmatter"] = n

    # Header "# Conversation Archive — ..."
    text, n = RE_CONV_ARCHIVE_HEADER.subn("", text)
    stats["archive_header"] = n

    # Bloc session meta
    text, n = RE_SESSION_META_BLOCK.subn("", text)
    stats["session_meta"] = n

    # ## Summary block (quand suivi de ## Full Conversation — dédup structurel)
    text, n = RE_SUMMARY_BEFORE_FULL.subn("", text)
    stats["summary_blocks"] = n

    # <relevant-memories>...</relevant-memories>
    text, n = RE_RELEVANT_MEMORIES.subn("", text)
    stats["relevant_memories"] = n

    # <system-reminder>...</system-reminder>
    text, n = RE_SYSTEM_REMINDER.subn("", text)
    stats["system_reminders"] = n

    # Panels Mastermind (Options actives / Runtime)
    text, n = RE_MASTERMIND_PANEL.subn("", text)
    stats["mastermind_panels"] = n

    # Tool blocks (### TOOL ... until next ###)
    text, n = RE_TOOL_BLOCK.subn("", text)
    stats["tool_blocks"] = n

    # Metadata JSON blocks (Telegram bridge)
    text, n = RE_METADATA_JSON_BLOCK.subn("", text)
    stats["metadata_json"] = n

    # <think>...</think> reasoning blocks
    text, n = RE_THINK_BLOCK.subn("", text)
    stats["think_blocks"] = n
    text, n = RE_ORPHAN_THINK.subn("", text)
    stats["orphan_think_tags"] = n

    # Turn headers (### USER / ### ASSISTANT)
    text, n = RE_TURN_HEADER.subn("", text)
    stats["turn_headers"] = n

    # Bridge "**You:**" / "**Assistant:**"
    text, n = RE_BRIDGE_TURN.subn("", text)
    stats["bridge_turns"] = n

    # System noise lines (all patterns, accumulés)
    for rx in RE_SYSTEM_NOISE_LINES:
        text, n = rx.subn("", text)
        stats["system_lines"] += n

    # Timestamps
    text, n = RE_TIMESTAMP_LINE.subn("", text)
    stats["timestamps"] = n

    # Séparateurs horizontaux
    text, n = RE_HR_LINE.subn("", text)
    stats["hr_lines"] = n

    # ls dumps en cluster
    text, n = RE_LS_DUMP_CLUSTER.subn("", text)
    stats["ls_dumps"] = n

    return text, stats


def strip_long_code_and_tables(text: str, max_code_lines: int, max_table_rows: int) -> tuple[str, dict[str, int]]:
    """Drop les blocs de code ``` > max_code_lines et les tables markdown > max_table_rows."""
    stats = {"code_blocks_dropped": 0, "tables_dropped": 0}

    # Code blocks
    out_lines: list[str] = []
    lines = text.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        m = re.match(r"^(\s*)```", line)
        if m:
            # Trouve la fermeture
            fence_prefix = m.group(1)
            start = i
            j = i + 1
            while j < len(lines) and not re.match(rf"^{re.escape(fence_prefix)}```\s*$", lines[j]):
                j += 1
            closed = j < len(lines)
            # Nb de lignes entre les ``` (exclut les fences)
            block_len = (j - start - 1) if closed else (j - start - 1)
            # Si trop long, on drop — que le bloc soit clos (on saute jusqu'après
            # la fermeture) ou non (on saute tout le reste du fichier). Un bloc
            # non clos est en soi suspect (archive tronquée, dump tool) → drop.
            if block_len > max_code_lines:
                stats["code_blocks_dropped"] += 1
                i = (j + 1) if closed else len(lines)
                continue
            # Bloc court, on le garde
            if closed:
                out_lines.extend(lines[start:j + 1])
                i = j + 1
            else:
                out_lines.extend(lines[start:])
                i = len(lines)
        else:
            out_lines.append(line)
            i += 1
    text = "\n".join(out_lines)

    # Tables markdown : cluster de lignes commençant par |
    # Détection : bloc continu >= 2 lignes qui commencent par |
    out_lines = []
    lines = text.split("\n")
    i = 0
    while i < len(lines):
        if re.match(r"^\s*\|", lines[i]):
            start = i
            while i < len(lines) and re.match(r"^\s*\|", lines[i]):
                i += 1
            n_rows = i - start
            if n_rows > max_table_rows:
                stats["tables_dropped"] += 1
                continue
            out_lines.extend(lines[start:i])
        else:
            out_lines.append(lines[i])
            i += 1
    text = "\n".join(out_lines)

    return text, stats


def collapse_whitespace(text: str) -> str:
    """Normalise : max 2 newlines consécutifs, strip trailing whitespace par ligne."""
    lines = [line.rstrip() for line in text.split("\n")]
    out: list[str] = []
    blank = 0
    for line in lines:
        if not line:
            blank += 1
            if blank <= 2:
                out.append(line)
        else:
            blank = 0
            out.append(line)
    return "\n".join(out).strip() + "\n"


# ────────────────────────────────────────────────────────────────────────────
# Qualité paragraphes : split, filtres, reshape
# ────────────────────────────────────────────────────────────────────────────

# Regex compilée une fois pour détecter les paragraphes purement structurels
# (markdown scaffolding, listes à puces isolées, tableaux vides, headers nus)
RE_STRUCTURAL_LINE = re.compile(r"^[\s#>*\-+|0-9.()\[\]:]*$")

# Split de phrases simplifié : . ! ? suivis d'espace ou fin de chaîne.
# Préserve l'abréviation "etc." / "ex." / nombres "3.14" via heuristique.
RE_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])(?=\s+[A-ZÀÂÉÈÊËÎÏÔÛÙÇ])")


def _alnum_ratio(s: str) -> float:
    """Ratio caractères alphanumériques sur la longueur totale."""
    if not s:
        return 0.0
    total = len(s)
    # On compte alphanum + espaces comme "signal", le reste (ponctuation pure,
    # emojis, symboles markdown) comme bruit.
    signal = sum(1 for c in s if c.isalnum() or c.isspace())
    return signal / total


def _is_structural(p: str) -> bool:
    """True si le paragraphe n'est que du markdown sans prose (titres, puces
    sans contenu, lignes de tableau vides, numéros isolés)."""
    lines = [l for l in p.split("\n") if l.strip()]
    if not lines:
        return True
    # Si TOUTES les lignes matchent le pattern structural = drop
    return all(RE_STRUCTURAL_LINE.match(l) for l in lines)


def _split_sentences(p: str) -> list[str]:
    """Split un long paragraphe en phrases. Fallback = texte entier si no split."""
    parts = RE_SENTENCE_SPLIT.split(p)
    return [s.strip() for s in parts if s.strip()]


def split_paragraphs(
    text: str,
    min_chars: int,
    max_chars: int,
    min_alnum: float,
) -> tuple[list[str], dict[str, int]]:
    """Split sur blanks lines, applique filtres qualité, split phrases si trop long.
    Retourne paragraphes + stats des rejets."""
    stats: dict[str, int] = defaultdict(int)

    raw_paras = re.split(r"\n\s*\n", text)
    out: list[str] = []
    for p in raw_paras:
        p = p.strip()
        if not p:
            continue

        # Filtre longueur min
        if len(p) < min_chars:
            stats["reject_too_short"] += 1
            continue

        # Filtre structurel (pur markdown)
        if _is_structural(p):
            stats["reject_structural"] += 1
            continue

        # Filtre alnum ratio (trop de ponctuation/emoji)
        if _alnum_ratio(p) < min_alnum:
            stats["reject_low_alnum"] += 1
            continue

        # Split si trop long (découpe par phrases)
        if len(p) > max_chars:
            sentences = _split_sentences(p)
            # Regroupe en chunks <= max_chars
            chunk = ""
            for s in sentences:
                if len(chunk) + len(s) + 1 <= max_chars:
                    chunk = (chunk + " " + s) if chunk else s
                else:
                    if len(chunk) >= min_chars:
                        out.append(chunk)
                        stats["split_long"] += 1
                    chunk = s
            if chunk and len(chunk) >= min_chars:
                out.append(chunk)
                stats["split_long"] += 1
            continue

        out.append(p)

    return out, stats


# ────────────────────────────────────────────────────────────────────────────
# Dédup : exact (SHA1) + quasi (MinHash+LSH)
# ────────────────────────────────────────────────────────────────────────────

def dedup_exact(paragraphs: list[str]) -> tuple[list[str], int]:
    """Dédup exact via hash SHA1 du contenu normalisé (lowercase + ws collapsed)."""
    seen: set[str] = set()
    out: list[str] = []
    dups = 0
    for p in paragraphs:
        key = hashlib.sha1(re.sub(r"\s+", " ", p.lower()).encode("utf-8")).hexdigest()
        if key in seen:
            dups += 1
            continue
        seen.add(key)
        out.append(p)
    return out, dups


def _shingles(text: str, k: int) -> set[bytes]:
    """N-grams de mots encodés en bytes (pour MinHash.update)."""
    tokens = re.findall(r"\w+", text.lower())
    if len(tokens) < k:
        return {" ".join(tokens).encode("utf-8")} if tokens else set()
    return {" ".join(tokens[i:i + k]).encode("utf-8") for i in range(len(tokens) - k + 1)}


def dedup_near(
    paragraphs: list[str],
    jaccard: float,
    shingle_k: int,
    num_perm: int,
) -> tuple[list[str], int]:
    """Dédup quasi-doublons via MinHash+LSH.
    - jaccard : seuil de similarité (0.8 = 80% de shingles en commun).
    - shingle_k : taille du n-gram de mots.
    - num_perm : nombre de permutations MinHash (128 = standard).

    Pour chaque cluster de quasi-doublons, on garde le paragraphe LE PLUS LONG
    (plus d'info). Retourne (paras_filtrés, n_supprimés)."""
    if not HAS_DATASKETCH or jaccard <= 0.0 or not paragraphs:
        return paragraphs, 0

    lsh = MinHashLSH(threshold=jaccard, num_perm=num_perm)
    signatures: list[MinHash] = []

    for idx, p in enumerate(paragraphs):
        mh = MinHash(num_perm=num_perm)
        for sh in _shingles(p, shingle_k):
            mh.update(sh)
        signatures.append(mh)
        lsh.insert(str(idx), mh)

    # Clustering : union-find sur les paires similaires
    parent = list(range(len(paragraphs)))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for idx, mh in enumerate(signatures):
        for key in lsh.query(mh):
            other = int(key)
            if other != idx:
                union(idx, other)

    # Par cluster, garder le paragraphe le plus long
    clusters: dict[int, list[int]] = defaultdict(list)
    for idx in range(len(paragraphs)):
        clusters[find(idx)].append(idx)

    keep: set[int] = set()
    for members in clusters.values():
        best = max(members, key=lambda i: len(paragraphs[i]))
        keep.add(best)

    out = [paragraphs[i] for i in sorted(keep)]
    return out, len(paragraphs) - len(out)


# ────────────────────────────────────────────────────────────────────────────
# Équilibrage des buckets
# ────────────────────────────────────────────────────────────────────────────

def balance_buckets(
    paragraphs_by_bucket: dict[str, list[str]],
    max_ratio: float,
    seed: int,
) -> tuple[dict[str, list[str]], dict[str, int]]:
    """Si un bucket dépasse max_ratio du total (en bytes), sous-échantillonne
    aléatoirement jusqu'à atteindre la cible. Préserve la diversité des autres
    buckets riches en prose (projects, docs, insights)."""
    if max_ratio <= 0.0 or max_ratio >= 1.0:
        return paragraphs_by_bucket, {}

    rng = random.Random(seed)

    total = sum(
        sum(len(p.encode("utf-8")) for p in ps)
        for ps in paragraphs_by_bucket.values()
    )
    if total == 0:
        return paragraphs_by_bucket, {}

    capped: dict[str, int] = {}
    out: dict[str, list[str]] = {}

    # Itération : on cappe le plus gros bucket, recalcule le total, etc.
    # En pratique un seul pass suffit mais on itère 3x pour gérer cas limites.
    current = {b: list(ps) for b, ps in paragraphs_by_bucket.items()}

    for _ in range(3):
        current_bytes = {b: sum(len(p.encode("utf-8")) for p in ps) for b, ps in current.items()}
        current_total = sum(current_bytes.values())
        if current_total == 0:
            break

        changed = False
        for b, nbytes in current_bytes.items():
            ratio = nbytes / current_total
            if ratio > max_ratio:
                # Cible : ramener ce bucket à max_ratio * total_sans_ce_bucket / (1 - max_ratio)
                # Plus simple : cible en bytes = max_ratio * (current_total - nbytes) / (1 - max_ratio)
                target_bytes = int(max_ratio * (current_total - nbytes) / (1 - max_ratio))
                if target_bytes <= 0:
                    continue
                # Shuffle puis garde paras jusqu'à atteindre target
                paras = list(current[b])
                rng.shuffle(paras)
                kept: list[str] = []
                acc = 0
                for p in paras:
                    pb = len(p.encode("utf-8"))
                    if acc + pb > target_bytes and kept:
                        break
                    kept.append(p)
                    acc += pb
                dropped = len(current[b]) - len(kept)
                if dropped > 0:
                    capped[b] = capped.get(b, 0) + dropped
                    current[b] = kept
                    changed = True
        if not changed:
            break

    out = current
    return out, capped


# ────────────────────────────────────────────────────────────────────────────
# Scan & pipeline
# ────────────────────────────────────────────────────────────────────────────

@dataclass
class SourceStats:
    files: int = 0
    bytes_raw: int = 0
    bytes_clean: int = 0
    paragraphs: int = 0
    filter_stats: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    quality_stats: dict[str, int] = field(default_factory=lambda: defaultdict(int))


def collect_files(source: Path, exclude_dirs: list[str]) -> list[Path]:
    """Scan récursif .md et .txt, skip les dossiers exclus. Tri alphabétique
    pour que la sortie soit déterministe entre runs / entre machines (seul
    le shuffle final randomise, avec seed fixe)."""
    excluded_names = {d.lower().strip("/") for d in (exclude_dirs or [])}
    files: list[Path] = []
    for p in source.rglob("*"):
        if not p.is_file():
            continue
        if p.suffix.lower() not in (".md", ".txt"):
            continue
        # Si un des parents est dans exclude → skip
        if any(part.lower() in excluded_names for part in p.relative_to(source).parts):
            continue
        files.append(p)
    files.sort()
    return files


def top_level_bucket(source: Path, file: Path) -> str:
    """Premier dossier sous source pour regrouper les stats (ex: 'consolidated', 'projects')."""
    rel = file.relative_to(source)
    return rel.parts[0] if len(rel.parts) > 1 else "(root)"


def process_corpus(
    source: Path,
    exclude_dirs: list[str],
    max_code_lines: int,
    max_table_rows: int,
    min_para_chars: int,
    max_para_chars: int,
    min_alnum: float,
) -> tuple[dict[str, list[str]], dict[str, SourceStats]]:
    """Parcourt tous les fichiers, applique les filtres, retourne paragraphes par bucket."""
    files = collect_files(source, exclude_dirs)
    if not files:
        return {}, {}

    paragraphs_by_bucket: dict[str, list[str]] = defaultdict(list)
    stats_by_bucket: dict[str, SourceStats] = defaultdict(SourceStats)

    with Progress(
        SpinnerColumn(),
        TextColumn("[cyan]Parsing[/]"),
        BarColumn(bar_width=40),
        MofNCompleteColumn(),
        TextColumn("files"),
        console=console,
    ) as progress:
        task = progress.add_task("parsing", total=len(files))

        for f in files:
            bucket = top_level_bucket(source, f)
            st = stats_by_bucket[bucket]
            st.files += 1

            try:
                raw = f.read_text(encoding="utf-8", errors="replace")
            except Exception:
                progress.update(task, advance=1)
                continue

            st.bytes_raw += len(raw.encode("utf-8", errors="replace"))

            # Filtres
            text, noise_stats = strip_noise(raw)
            text, code_stats = strip_long_code_and_tables(text, max_code_lines, max_table_rows)
            text = collapse_whitespace(text)

            for k, v in noise_stats.items():
                st.filter_stats[k] += v
            for k, v in code_stats.items():
                st.filter_stats[k] += v

            st.bytes_clean += len(text.encode("utf-8", errors="replace"))

            paras, qstats = split_paragraphs(text, min_para_chars, max_para_chars, min_alnum)
            for k, v in qstats.items():
                st.quality_stats[k] += v
            paragraphs_by_bucket[bucket].extend(paras)
            st.paragraphs += len(paras)

            progress.update(task, advance=1)

    return paragraphs_by_bucket, stats_by_bucket


# ────────────────────────────────────────────────────────────────────────────
# Formatage & main
# ────────────────────────────────────────────────────────────────────────────

def fmt_size(b: int) -> str:
    b = float(b)
    for unit in ("B", "KB", "MB", "GB"):
        if b < 1024:
            return f"{b:.1f} {unit}"
        b /= 1024
    return f"{b:.1f} TB"


def fmt_tokens(b: int) -> str:
    """Estimation grossière : ~3.8 bytes / token pour du FR/EN markdown mixé.
    Note : heuristique délibérément simple, pas un tokenizer réel."""
    t = int(b / 3.8)
    if t < 1000:
        return f"~{t}"
    if t < 1_000_000:
        return f"~{t/1000:.0f}k"
    return f"~{t/1_000_000:.2f}M"


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        return {}
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def write_manifest(
    output: Path,
    source: Path,
    stats_by_bucket: dict[str, SourceStats],
    paragraphs_before: int,
    after_exact: int,
    after_near: int,
    bucket_capped: dict[str, int],
    final_count: int,
    final_bytes: int,
    corpus_sha: str,
    args_snapshot: dict,
) -> Path:
    """Écrit un manifest JSON à côté de perso.txt pour traçabilité."""
    manifest_path = output.with_suffix(".manifest.json")
    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "script_version": SCRIPT_VERSION,
        "source": str(source),
        "output": str(output),
        "files_scanned": sum(s.files for s in stats_by_bucket.values()),
        "bytes_raw": sum(s.bytes_raw for s in stats_by_bucket.values()),
        "bytes_clean": sum(s.bytes_clean for s in stats_by_bucket.values()),
        "paragraphs_before_dedup": paragraphs_before,
        "paragraphs_after_exact_dedup": after_exact,
        "paragraphs_after_near_dedup": after_near,
        "paragraphs_final": final_count,
        "bucket_paragraphs": {
            b: s.paragraphs for b, s in stats_by_bucket.items()
        },
        "bucket_bytes_clean": {
            b: s.bytes_clean for b, s in stats_by_bucket.items()
        },
        "bucket_capped_paragraphs": bucket_capped,
        "final_bytes": final_bytes,
        "final_tokens_estimate": int(final_bytes / 3.8),
        "corpus_sha1": corpus_sha,
        "params": args_snapshot,
        "near_dup_enabled": HAS_DATASKETCH and args_snapshot.get("near_dup_jaccard", 0) > 0,
    }
    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return manifest_path


def main():
    cfg = load_config()
    cbuild = cfg.get("calibration_build", {})
    default_source = cbuild.get("source", None)
    default_output = Path(cfg.get("calibration_dir", "./calibration"))
    if not default_output.is_absolute():
        default_output = (SCRIPT_DIR / default_output).resolve()
    default_output = default_output / cbuild.get("output_name", "perso.txt")

    ap = argparse.ArgumentParser(description="Construit le corpus de calibration depuis un dossier source.")
    ap.add_argument("--source", default=default_source,
                    help="Dossier racine à scanner. Requis si calibration_build.source absent de config.yaml."
                         " Ex: --source ~/Documents/calibration-source")
    ap.add_argument("--output", default=str(default_output),
                    help=f"Fichier de sortie (default: {default_output})")
    ap.add_argument("--exclude", nargs="*", default=cbuild.get("exclude_dirs") or [],
                    help="Dossiers à exclure par nom (ex: secret Personal)")
    ap.add_argument("--max-code-lines", type=int,
                    default=cbuild.get("max_code_block_lines", 50))
    ap.add_argument("--max-table-rows", type=int,
                    default=cbuild.get("max_table_rows", 30))
    ap.add_argument("--min-para-chars", type=int,
                    default=cbuild.get("min_paragraph_chars", 80))
    ap.add_argument("--max-para-chars", type=int,
                    default=cbuild.get("max_paragraph_chars", 3000))
    ap.add_argument("--min-alnum", type=float,
                    default=cbuild.get("min_alnum_ratio", 0.55))
    ap.add_argument("--near-dup-jaccard", type=float,
                    default=cbuild.get("near_dup_jaccard", 0.82),
                    help="Seuil Jaccard pour near-dup (0.0 = désactivé)")
    ap.add_argument("--near-dup-shingle", type=int,
                    default=cbuild.get("near_dup_shingle", 5))
    ap.add_argument("--near-dup-num-perm", type=int,
                    default=cbuild.get("near_dup_num_perm", 128))
    ap.add_argument("--bucket-max-ratio", type=float,
                    default=cbuild.get("bucket_max_ratio", 0.35),
                    help="Cap ratio par bucket (0.0 = désactivé)")
    ap.add_argument("--no-shuffle", action="store_true",
                    help="Ne pas mélanger les paragraphes (default: shuffle ON)")
    ap.add_argument("--dry-run", action="store_true",
                    help="Pipeline complet + stats, mais n'écrit pas perso.txt (écrit un sample).")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    if args.source is None:
        ap.error("Argument --source requis ou calibration_build.source à configurer dans config.yaml.\n"
                 "  Exemple : calibration_build:\n              source: ~/Documents/calibration-source")
    source = Path(os.path.expanduser(args.source)).resolve()
    output = Path(os.path.expanduser(args.output)).resolve()
    shuffle = not args.no_shuffle and cbuild.get("shuffle_paragraphs", True)

    if not source.is_dir():
        console.print(f"[red]✗[/] Source introuvable : {source}")
        sys.exit(1)

    console.print()
    console.print(Panel.fit(
        f"[bold magenta]build-calibration v{SCRIPT_VERSION}[/] · extracteur corpus depuis shared-memory",
        border_style="magenta",
    ))
    console.print(f"  [dim]source      [/] {source}")
    console.print(f"  [dim]output      [/] {output}{' [yellow](dry-run)[/]' if args.dry_run else ''}")
    console.print(f"  [dim]exclude     [/] {', '.join(args.exclude) if args.exclude else '(aucun)'}")
    console.print(f"  [dim]shuffle     [/] {'oui' if shuffle else 'non'}")
    console.print(f"  [dim]min/max para[/] {args.min_para_chars} / {args.max_para_chars} ch  · min alnum {args.min_alnum}")
    if args.near_dup_jaccard > 0:
        if HAS_DATASKETCH:
            console.print(f"  [dim]near-dup    [/] jaccard ≥ {args.near_dup_jaccard}, shingle {args.near_dup_shingle}, {args.near_dup_num_perm} perm")
        else:
            console.print(f"  [dim]near-dup    [/] [yellow]désactivé — datasketch non installé (pip install datasketch)[/]")
    else:
        console.print(f"  [dim]near-dup    [/] désactivé (jaccard=0)")
    console.print(f"  [dim]bucket cap  [/] {args.bucket_max_ratio if args.bucket_max_ratio > 0 else 'désactivé'}")
    console.print()

    # Scan & process
    paragraphs_by_bucket, stats_by_bucket = process_corpus(
        source, args.exclude,
        args.max_code_lines, args.max_table_rows,
        args.min_para_chars, args.max_para_chars, args.min_alnum,
    )

    if not paragraphs_by_bucket:
        console.print(f"[red]✗[/] Aucun .md ni .txt trouvé dans {source}")
        sys.exit(1)

    # 1. Dédup exact par bucket (évite cross-bucket bias sur boilerplate partagé)
    paragraphs_before = sum(len(ps) for ps in paragraphs_by_bucket.values())
    exact_dups_total = 0
    for b in list(paragraphs_by_bucket.keys()):
        deduped_b, d = dedup_exact(paragraphs_by_bucket[b])
        exact_dups_total += d
        paragraphs_by_bucket[b] = deduped_b
    after_exact = sum(len(ps) for ps in paragraphs_by_bucket.values())

    # 2. Équilibrage des buckets (avant near-dup : évite que le near-dup voit
    # un énorme bucket écraser les autres dans ses clusters)
    paragraphs_by_bucket, bucket_capped = balance_buckets(
        paragraphs_by_bucket, args.bucket_max_ratio, args.seed,
    )

    # 3. Flatten + dédup near (cross-bucket)
    all_paragraphs: list[str] = []
    for bucket, paras in paragraphs_by_bucket.items():
        all_paragraphs.extend(paras)
    after_bucket_cap = len(all_paragraphs)

    near_dups_total = 0
    if args.near_dup_jaccard > 0 and HAS_DATASKETCH:
        with console.status("[cyan]MinHash + LSH clustering..."):
            all_paragraphs, near_dups_total = dedup_near(
                all_paragraphs,
                args.near_dup_jaccard,
                args.near_dup_shingle,
                args.near_dup_num_perm,
            )
    after_near = len(all_paragraphs)

    # 4. Shuffle
    if shuffle:
        random.seed(args.seed)
        random.shuffle(all_paragraphs)

    # 5. Write (ou dry-run)
    final_text = "\n\n".join(all_paragraphs) + "\n"
    final_bytes = len(final_text.encode("utf-8"))
    corpus_sha = hashlib.sha1(final_text.encode("utf-8")).hexdigest()

    if args.dry_run:
        # Échantillon : 50 paragraphes aléatoires pour inspection humaine
        sample_path = output.with_name(output.stem + ".dry.sample.txt")
        sample_path.parent.mkdir(parents=True, exist_ok=True)
        rng = random.Random(args.seed)
        sample_n = min(50, len(all_paragraphs))
        sample = rng.sample(all_paragraphs, sample_n) if all_paragraphs else []
        sample_path.write_text(
            f"# Dry-run sample — {sample_n} paragraphes aléatoires\n\n" + "\n\n---\n\n".join(sample) + "\n",
            encoding="utf-8",
        )
        console.print(f"[yellow]⚠ dry-run[/] — sortie non écrite. Sample → {sample_path}")
    else:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(final_text, encoding="utf-8")

        # Manifest JSON
        args_snapshot = {
            "max_code_lines": args.max_code_lines,
            "max_table_rows": args.max_table_rows,
            "min_para_chars": args.min_para_chars,
            "max_para_chars": args.max_para_chars,
            "min_alnum": args.min_alnum,
            "near_dup_jaccard": args.near_dup_jaccard,
            "near_dup_shingle": args.near_dup_shingle,
            "near_dup_num_perm": args.near_dup_num_perm,
            "bucket_max_ratio": args.bucket_max_ratio,
            "shuffle": shuffle,
            "seed": args.seed,
        }
        manifest_path = write_manifest(
            output, source, stats_by_bucket,
            paragraphs_before, after_exact, after_near, bucket_capped,
            final_count=len(all_paragraphs),
            final_bytes=final_bytes,
            corpus_sha=corpus_sha,
            args_snapshot=args_snapshot,
        )
        console.print(f"[green]✓[/] manifest → {manifest_path}")

    # ── Stats finales ──────────────────────────────────────────────────────
    total_files = sum(s.files for s in stats_by_bucket.values())
    total_raw = sum(s.bytes_raw for s in stats_by_bucket.values())
    total_clean = sum(s.bytes_clean for s in stats_by_bucket.values())

    # Table par bucket (avec paragraphes capés si applicable)
    table = Table(title="Par sous-dossier", header_style="bold magenta", box=None, padding=(0, 2))
    table.add_column("Bucket")
    table.add_column("Files", justify="right")
    table.add_column("Raw", justify="right")
    table.add_column("Clean", justify="right")
    table.add_column("Clean tokens", justify="right")
    table.add_column("Paras", justify="right")
    table.add_column("Capé", justify="right")

    for bucket in sorted(stats_by_bucket.keys(),
                         key=lambda b: stats_by_bucket[b].bytes_clean, reverse=True):
        s = stats_by_bucket[bucket]
        capped_n = bucket_capped.get(bucket, 0)
        table.add_row(
            bucket,
            str(s.files),
            fmt_size(s.bytes_raw),
            fmt_size(s.bytes_clean),
            fmt_tokens(s.bytes_clean),
            str(s.paragraphs),
            f"[yellow]-{capped_n}[/]" if capped_n > 0 else "—",
        )
    console.print()
    console.print(table)

    # Table de filtrage (bruit)
    filter_totals: dict[str, int] = defaultdict(int)
    quality_totals: dict[str, int] = defaultdict(int)
    for s in stats_by_bucket.values():
        for k, v in s.filter_stats.items():
            filter_totals[k] += v
        for k, v in s.quality_stats.items():
            quality_totals[k] += v

    ftable = Table(title="Filtres bruit appliqués (cumul)", header_style="bold yellow",
                   box=None, padding=(0, 2))
    ftable.add_column("Filtre")
    ftable.add_column("Count", justify="right")
    filter_labels = [
        ("frontmatter", "YAML frontmatter supprimés"),
        ("archive_header", "Headers # Conversation Archive"),
        ("session_meta", "Blocs session meta (Key/ID/Source)"),
        ("summary_blocks", "Blocs ## Summary avant Full Conversation"),
        ("relevant_memories", "Blocs <relevant-memories> retirés"),
        ("system_reminders", "Blocs <system-reminder> retirés"),
        ("mastermind_panels", "Panels Options/Runtime Mastermind"),
        ("tool_blocks", "Blocs ### TOOL supprimés"),
        ("metadata_json", "Blocs JSON metadata retirés"),
        ("think_blocks", "Blocs <think>...</think> retirés"),
        ("orphan_think_tags", "Tags <think> orphelins retirés"),
        ("turn_headers", "Headers ### USER/ASSISTANT retirés"),
        ("bridge_turns", "Headers **You:**/**Assistant:** retirés"),
        ("system_lines", "Lignes système retirées"),
        ("timestamps", "Timestamps isolés retirés"),
        ("hr_lines", "Séparateurs --- retirés"),
        ("ls_dumps", "Clusters ls/ dumps supprimés"),
        ("code_blocks_dropped", "Code blocks > N lignes supprimés"),
        ("tables_dropped", "Tables > N rows supprimées"),
    ]
    for k, label in filter_labels:
        v = filter_totals.get(k, 0)
        if v:
            ftable.add_row(label, str(v))
    console.print()
    console.print(ftable)

    # Table qualité paragraphes
    qtable = Table(title="Qualité paragraphes (cumul)", header_style="bold cyan",
                   box=None, padding=(0, 2))
    qtable.add_column("Filtre")
    qtable.add_column("Count", justify="right")
    quality_labels = [
        ("reject_too_short", f"Rejetés < {args.min_para_chars} ch"),
        ("reject_structural", "Rejetés (pure structure markdown)"),
        ("reject_low_alnum", f"Rejetés (alnum < {args.min_alnum})"),
        ("split_long", f"Paragraphes splittés (> {args.max_para_chars} ch)"),
    ]
    for k, label in quality_labels:
        v = quality_totals.get(k, 0)
        if v:
            qtable.add_row(label, str(v))
    console.print()
    console.print(qtable)

    # ── Résumé final ───────────────────────────────────────────────────────
    total_para_before = sum(s.paragraphs for s in stats_by_bucket.values())

    console.print()
    summary = [
        f"[bold]Fichiers scannés[/]      {total_files}",
        f"[bold]Volume brut[/]           {fmt_size(total_raw)} ({fmt_tokens(total_raw)} tokens)",
        f"[bold]Après filtrage[/]        {fmt_size(total_clean)} ({fmt_tokens(total_clean)} tokens)",
        f"[bold]Paragraphes[/]           {total_para_before} bruts  →  {after_exact} (dédup exact: -{exact_dups_total})  "
            f"→  {after_bucket_cap} (bucket cap)  →  {after_near} (near-dup: -{near_dups_total})",
        f"[bold]Shuffle[/]               {'oui' if shuffle else 'non'} (seed {args.seed})",
        "",
        f"[bold {'yellow' if args.dry_run else 'green'}]→ {output}{' (DRY-RUN, non écrit)' if args.dry_run else ''}[/]",
        f"  {fmt_size(final_bytes)} · {fmt_tokens(final_bytes)} tokens estimés",
        f"  sha1 {corpus_sha[:12]}…",
    ]
    console.print(Panel("\n".join(summary),
                        title=f"[bold {'yellow' if args.dry_run else 'green'}]Corpus {'simulé' if args.dry_run else 'généré'}[/]",
                        border_style="yellow" if args.dry_run else "green",
                        padding=(1, 2)))

    # Hint imatrix
    est_tokens = int(final_bytes / 3.8)
    if est_tokens < 100_000:
        console.print("\n[yellow]⚠[/] Corpus un peu court (< 100k tokens). "
                      "Augmente la source ou réduis les exclusions.")
    elif est_tokens > 1_500_000:
        console.print("\n[yellow]⚠[/] Corpus très long (> 1.5M tokens). "
                      "imatrix sera long — considère réduire --chunks dans brain-quant.py.")
    else:
        est_chunks = min(400, est_tokens // 2000)
        console.print(f"\n[dim]Corpus OK pour imatrix. Suggestion chunks : {est_chunks}[/]")
    console.print()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        console.print("\n[yellow]Interrompu.[/]")
        sys.exit(130)
