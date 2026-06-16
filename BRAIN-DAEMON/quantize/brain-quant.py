#!/usr/bin/env python3
"""
brain-quant — TUI standalone de quantization custom pour le brain (Strix Halo).

Pipeline :
  1. Scan ~/.lmstudio/models pour F16/BF16
  2. Sélection modèle source (TUI)
  3. Sélection fichier calibration (TUI)
  4. Sélection quant(s) de sortie (TUI multi-select)
  5. Tableau de confirmation
  6. imatrix + llama-quantize via toolbox
  7. Sortie dans <models_path>/mercury/<model>-brain-<quant>.gguf

Le daemon découvrira automatiquement les fichiers produits au prochain
GET /mgmt/models (scan récursif sur models_path).
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import sys
import time
import subprocess
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

# Windows: force stdout/stderr UTF-8 (no-op sous Linux, utile pour dev depuis Win)
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass

import yaml
import questionary
from rich.console import Console
from rich.panel import Panel
from rich.progress import (
    Progress, SpinnerColumn, BarColumn, TextColumn, TimeElapsedColumn,
    MofNCompleteColumn,
)
from rich.table import Table

console = Console()

SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_PATH = SCRIPT_DIR / "config.yaml"

# Sentinelle navigation TUI : un écran renvoie BACK pour remonter au précédent.
BACK = "__back__"

# Modes TUI : sélectionnés au tout premier écran.
MODE_QUANTIZE = "quantize"
MODE_IMATRIX_ONLY = "imatrix_only"
MODE_INSPECT = "inspect"
MODE_ANALYZE = "analyze"

# Buffer sliding-window pour parser la sortie imatrix sans exploser en RAM.
# 64k accumulé → on garde les 16k de queue (les derniers marqueurs [N] y vivent).
_IMATRIX_BUFFER_MAX = 64_000
_IMATRIX_BUFFER_TAIL = 16_000

# Poll non-blocking sur stdout imatrix : cadence de rafraîchissement de la barre.
_IMATRIX_POLL_SEC = 0.1


# ────────────────────────────────────────────────────────────────────────────
# Data structures
# ────────────────────────────────────────────────────────────────────────────

@dataclass
class ModelEntry:
    """Un modèle GGUF source détecté (F16/BF16/Q8_0, avec ses shards groupés)."""
    display_name: str        # chemin relatif au models_path, sans suffix quant
    first_shard: Path        # fichier 00001-of-NNNNN ou fichier unique
    total_shards: int        # 1 si pas sharded
    total_bytes: int         # somme de tous les shards
    quant_tag: str           # "F16", "BF16" ou "Q8_0"

    @property
    def is_requantize(self) -> bool:
        """True si la source est déjà quantisée (Q8_0) — nécessite --allow-requantize."""
        return self.quant_tag not in ("F16", "BF16")

    @property
    def top_type(self) -> str:
        """Type maximal disponible depuis cette source. F16 pour F16/BF16, Q8_0 pour Q8."""
        return "Q8_0" if self.is_requantize else "F16"

    @property
    def base_name(self) -> str:
        """Nom de fichier sans shard suffix ni tag quant (pour naming output)."""
        name = self.first_shard.name
        name = re.sub(r"\.gguf$", "", name)
        name = re.sub(r"-\d{5}-of-\d{5}$", "", name)
        # Strip -F16 / _F16 / .F16 en fin (ou BF16/FP16/Q8_0/Q8_K*/etc.)
        name = re.sub(r"[-_.](F16|BF16|FP16|Q8_\w+)$", "", name, flags=re.IGNORECASE)
        return name


@dataclass
class CalibEntry:
    path: Path
    size_bytes: int

    @property
    def est_tokens(self) -> int:
        """Estimation grossière : ~3.8 bytes/token pour du FR/EN markdown mixé."""
        return int(self.size_bytes / 3.8)


# ────────────────────────────────────────────────────────────────────────────
# Formatage
# ────────────────────────────────────────────────────────────────────────────

def fmt_size(b: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if b < 1024:
            return f"{b:.1f} {unit}"
        b /= 1024
    return f"{b:.1f} PB"


def fmt_tokens(t: int) -> str:
    if t < 1_000:
        return f"~{t}"
    if t < 1_000_000:
        return f"~{t/1000:.0f}k"
    return f"~{t/1_000_000:.1f}M"


def fmt_duration(seconds: float) -> str:
    s = int(seconds)
    h, r = divmod(s, 3600)
    m, s = divmod(r, 60)
    return f"{h}h{m:02d}m{s:02d}s" if h else f"{m}m{s:02d}s"


# ────────────────────────────────────────────────────────────────────────────
# Estimation taille (ratio vs F16)
# ────────────────────────────────────────────────────────────────────────────

# Fallback ratios si un preset n'a pas de size_ratio explicite dans config.yaml.
_FALLBACK_SIZE_RATIO = {
    "F16": 1.0, "BF16": 1.0,
    "Q8_0": 0.53, "Q8_K": 0.53,
    "Q6_K": 0.41, "Q5_K_M": 0.34, "Q4_K_M": 0.28,
    "Q3_K_M": 0.22, "IQ3_XXS": 0.17,
}

def estimate_quant_bytes(f16_bytes: int, quant_cfg: dict) -> int:
    """Estime la taille du quant produit à partir du F16 source.

    Prio 1 : size_ratio déclaré dans le preset (config.yaml)
    Prio 2 : fallback sur le type de base (Q8_0, Q6_K, etc.)
    Prio 3 : 0.5 par défaut (devrait ne jamais arriver)
    """
    ratio = quant_cfg.get("size_ratio")
    if ratio is None:
        ratio = _FALLBACK_SIZE_RATIO.get(quant_cfg.get("base", ""), 0.5)
    return int(f16_bytes * float(ratio))


# ────────────────────────────────────────────────────────────────────────────
# Scan filesystem
# ────────────────────────────────────────────────────────────────────────────

# F16 / BF16 / FP16 détectés avec n'importe quel séparateur autour :
# "-F16-", "_F16_", ".F16.", "/F16/", "-bf16.gguf", etc.
# Capture aussi dans le nom du dossier parent ("F16/model.gguf").
_QUANT_TAG_RE = re.compile(
    r"(?:^|[-_.\s/\\])(F16|BF16|FP16|Q8_\w+)(?:[-_.\s/\\]|\.gguf$|$)",
    re.IGNORECASE,
)
_SHARD_RE = re.compile(r"-(\d{5})-of-(\d{5})\.gguf$")


def scan_models(models_path: Path) -> list[ModelEntry]:
    """Scan récursif, groupe les shards, filtre F16/BF16."""
    if not models_path.is_dir():
        return []

    seen_bases: set[str] = set()
    entries: list[ModelEntry] = []

    for gguf in sorted(models_path.rglob("*.gguf")):
        name = gguf.name.lower()
        if any(x in name for x in ("mmproj", "projector", "clip")):
            continue

        shard_m = _SHARD_RE.search(gguf.name)
        if shard_m:
            if shard_m.group(1) != "00001":
                continue
            total_shards = int(shard_m.group(2))
            base_str = re.sub(r"-\d{5}-of-\d{5}\.gguf$", "", str(gguf))
        else:
            total_shards = 1
            base_str = str(gguf.with_suffix(""))

        # Cherche F16/BF16/FP16 dans le chemin relatif complet (nom + dossiers parents)
        rel_str = str(gguf.relative_to(models_path))
        tag_m = _QUANT_TAG_RE.search(rel_str)
        if not tag_m:
            continue
        tag = tag_m.group(1).upper()
        # Normalise FP16 en F16, tous les Q8_* en Q8_0
        if tag == "FP16":
            tag = "F16"
        elif tag.startswith("Q8_"):
            tag = "Q8_0"
        if tag not in ("F16", "BF16", "Q8_0"):
            continue

        if base_str in seen_bases:
            continue
        seen_bases.add(base_str)

        # total size (somme shards si sharded)
        total_bytes = 0
        if total_shards > 1:
            for i in range(1, total_shards + 1):
                shard = Path(f"{base_str}-{i:05d}-of-{total_shards:05d}.gguf")
                if shard.exists():
                    total_bytes += shard.stat().st_size
        else:
            total_bytes = gguf.stat().st_size

        # display : relatif models_path, sans tag quant suffix
        rel = Path(base_str).relative_to(models_path)
        display = re.sub(r"[-_.](F16|BF16|FP16|Q8_\w+)$", "", str(rel), flags=re.IGNORECASE)

        entries.append(ModelEntry(
            display_name=display,
            first_shard=gguf,
            total_shards=total_shards,
            total_bytes=total_bytes,
            quant_tag=tag,
        ))

    return entries


def scan_calibration(calib_dir: Path) -> list[CalibEntry]:
    if not calib_dir.is_dir():
        return []
    return [
        CalibEntry(path=p, size_bytes=p.stat().st_size)
        for p in sorted(calib_dir.glob("*.txt"))
    ]


def scan_all_gguf(models_path: Path) -> list[dict]:
    """Scan récursif de TOUS les .gguf (pas que F16/BF16).
    Retourne une liste de dicts {path, display, size_bytes, quant_tag}.
    Groupe les shards, ne garde que le premier."""
    if not models_path.is_dir():
        return []

    # Regex pour détecter le type de quant dans le nom
    _ANY_QUANT_RE = re.compile(
        r"(?:^|[-_.\s/\\])(F16|BF16|FP16|Q8_0|Q8_K|Q6_K|Q5_K_M|Q5_K_S|"
        r"Q4_K_M|Q4_K_S|Q4_0|Q3_K_M|Q3_K_S|Q3_K_L|Q2_K|"
        r"IQ4_XS|IQ4_NL|IQ3_XXS|IQ3_S|IQ2_XXS|IQ2_XS|IQ2_S|IQ1_S|IQ1_M)"
        r"(?:[-_.\s/\\]|\.gguf$|$)",
        re.IGNORECASE,
    )

    seen: set[str] = set()
    entries: list[dict] = []

    for gguf in sorted(models_path.rglob("*.gguf")):
        name = gguf.name.lower()
        if any(x in name for x in ("mmproj", "projector", "clip")):
            continue

        shard_m = _SHARD_RE.search(gguf.name)
        if shard_m:
            if shard_m.group(1) != "00001":
                continue
            total_shards = int(shard_m.group(2))
            base_str = re.sub(r"-\d{5}-of-\d{5}\.gguf$", "", str(gguf))
        else:
            total_shards = 1
            base_str = str(gguf.with_suffix(""))

        if base_str in seen:
            continue
        seen.add(base_str)

        # Taille totale (somme shards)
        total_bytes = 0
        if total_shards > 1:
            for i in range(1, total_shards + 1):
                shard = Path(f"{base_str}-{i:05d}-of-{total_shards:05d}.gguf")
                if shard.exists():
                    total_bytes += shard.stat().st_size
        else:
            total_bytes = gguf.stat().st_size

        # Détection tag quant dans le chemin relatif
        rel_str = str(gguf.relative_to(models_path))
        tag_m = _ANY_QUANT_RE.search(rel_str)
        quant_tag = tag_m.group(1).upper() if tag_m else "?"

        rel = Path(base_str).relative_to(models_path)
        entries.append({
            "path": gguf,
            "display": str(rel),
            "size_bytes": total_bytes,
            "quant_tag": quant_tag,
        })

    return entries


# ────────────────────────────────────────────────────────────────────────────
# Toolbox wrappers
# ────────────────────────────────────────────────────────────────────────────

def toolbox_exists(toolbox: str) -> bool:
    try:
        r = subprocess.run(["toolbox", "list"], capture_output=True, text=True, timeout=10)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False
    return toolbox in r.stdout


def toolbox_has_binary(toolbox: str, binary: str) -> bool:
    try:
        r = subprocess.run(
            ["toolbox", "run", "-c", toolbox, "which", binary],
            capture_output=True, text=True, timeout=15,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False
    return r.returncode == 0


def check_writable(path: Path) -> tuple[bool, str]:
    """
    Vérifie qu'on peut écrire dans `path` (dossier ou futur dossier).
    Teste pour de vrai avec touch+unlink — plus fiable que os.access().
    Retourne (True, "") si OK, (False, "raison") sinon.
    """
    try:
        # Si path n'existe pas, on tente de le créer
        if not path.exists():
            try:
                path.mkdir(parents=True, exist_ok=True)
            except PermissionError as e:
                return False, f"impossible de créer {path} : {e}"
            except OSError as e:
                return False, f"erreur création {path} : {e}"

        if not path.is_dir():
            return False, f"{path} existe mais n'est pas un dossier"

        # Test write réel (plus fiable que os.access qui peut mentir avec ACL/SELinux)
        test_file = path / ".brain-quant-write-test"
        try:
            test_file.touch()
            test_file.unlink()
        except (PermissionError, OSError) as e:
            import grp
            import pwd
            import stat as stmod
            try:
                st = path.stat()
                owner = pwd.getpwuid(st.st_uid).pw_name
                group = grp.getgrgid(st.st_gid).gr_name
                perms = stmod.filemode(st.st_mode)
                return False, (
                    f"{path} existe mais non writable ({perms} {owner}:{group}) — {e}"
                )
            except Exception:
                return False, f"{path} non writable : {e}"
        return True, ""
    except Exception as e:
        return False, f"check raté sur {path} : {e}"


def toolbox_popen(toolbox: str, args: list[str]):
    """Lance une commande via `toolbox run -c <tbox> <args>` et renvoie le Popen.

    Le cwd est forcé à $HOME : toolbox containers ne montent que HOME, donc
    si on est lancé depuis /opt/..., le container ne peut pas chdir au cwd
    initial et émet un warning. Forcer cwd=HOME l'évite proprement.
    """
    cmd = ["toolbox", "run", "-c", toolbox] + args
    return subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        cwd=str(Path.home()),
    )


def ensure_toolbox_accessible(path: Path, cache_dir: Path) -> Path:
    """
    Les toolbox containers ne montent que $HOME. Tout fichier hors de $HOME
    (typiquement dans /opt) est invisible depuis le container.

    Si `path` est hors de HOME, on le copie dans `cache_dir` (qui doit être
    sous HOME) et on renvoie le nouveau chemin. Sinon on renvoie path inchangé.
    """
    home = Path.home().resolve()
    abs_path = path.resolve()
    try:
        abs_path.relative_to(home)
        return abs_path  # déjà sous HOME, accessible au container
    except ValueError:
        pass

    cache_dir.mkdir(parents=True, exist_ok=True)
    target = cache_dir / path.name
    # Copie seulement si absent ou plus ancien
    if not target.exists() or target.stat().st_mtime < abs_path.stat().st_mtime:
        shutil.copy2(abs_path, target)
    return target.resolve()


# ────────────────────────────────────────────────────────────────────────────
# Pipeline : imatrix & quantize
# ────────────────────────────────────────────────────────────────────────────

# Parse "[N]..." inline output de llama-imatrix. Ancré sur un contexte gauche
# (début, virgule, espace, newline) pour ne pas matcher des `[N]` parasites qui
# peuvent apparaître dans des messages de log tensoriels.
_IMATRIX_CHUNK_RE = re.compile(r"(?:^|[,\s])\[(\d+)\]")


def run_imatrix(
    toolbox: str,
    f16_path: Path,
    calib_path: Path,
    out_imatrix: Path,
    chunks: int,
    ctx: int,
    batch: int,
    ngl: int,
    log_stream,
) -> float:
    """Calcule imatrix. Retourne temps écoulé."""
    cmd = [
        "llama-imatrix",
        "-m", str(f16_path),
        "-f", str(calib_path),
        "-o", str(out_imatrix),
        "--output-format", "dat",   # format binaire classique (pas de warning suffix)
        "-c", str(ctx),
        "-b", str(batch),
        "--chunks", str(chunks),
        "-ngl", str(ngl),
        "-fa", "1",
        "--no-mmap",
        # Tokenise les tokens spéciaux (chat template, marqueurs d'outils) comme
        # tokens — indispensable pour calibrer un modèle instruct. Aligné avec
        # lib/imatrix.py (le daemon piloté par ATLASMIND) pour ne pas diverger.
        "--parse-special",
        "-t", str(os.cpu_count() or 16),
    ]
    out_imatrix.parent.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    with Progress(
        SpinnerColumn(),
        TextColumn("[bold]imatrix[/]"),
        BarColumn(bar_width=40),
        MofNCompleteColumn(),
        TextColumn("chunks"),
        TextColumn("·"),
        TimeElapsedColumn(),
        console=console,
        transient=False,
    ) as progress:
        task = progress.add_task("imatrix", total=chunks)
        # Popen en mode bytes → on lit via select+os.read sans passer par le
        # buffer TextIOWrapper (qui sinon bloquerait par paliers de N chars).
        popen_cmd = ["toolbox", "run", "-c", toolbox] + cmd
        proc = subprocess.Popen(
            popen_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            cwd=str(Path.home()),
        )
        fd = proc.stdout.fileno()

        # llama-imatrix écrit des marqueurs "[1],[2],[3],..." inline. On lit
        # en non-bloquant via select, met à jour la barre en temps réel,
        # protège contre les régressions avec max_seen (tranche de buffer qui
        # tombe pourrait contenir le max courant).
        import select
        buffer = ""
        max_seen = 0
        while True:
            ready, _, _ = select.select([fd], [], [], _IMATRIX_POLL_SEC)
            if ready:
                raw = os.read(fd, 4096)
                if not raw:
                    break  # EOF
                chunk = raw.decode("utf-8", errors="replace")
                buffer += chunk
                log_stream.write(chunk)
                log_stream.flush()

                matches = _IMATRIX_CHUNK_RE.findall(buffer)
                if matches:
                    current = max(int(x) for x in matches)
                    max_seen = max(max_seen, min(current, chunks))
                    progress.update(task, completed=max_seen)

                if len(buffer) > _IMATRIX_BUFFER_MAX:
                    buffer = buffer[-_IMATRIX_BUFFER_TAIL:]
            elif proc.poll() is not None:
                # Pas de données en attente et process terminé → on drain et sort.
                try:
                    remaining = os.read(fd, 65_536)
                except OSError:
                    remaining = b""
                if remaining:
                    log_stream.write(remaining.decode("utf-8", errors="replace"))
                    log_stream.flush()
                break

        proc.wait()
        progress.update(task, completed=chunks)

    if proc.returncode != 0:
        raise RuntimeError(f"llama-imatrix exited with code {proc.returncode}")

    return time.time() - t0


def build_quantize_overrides(quant_cfg: dict) -> list[str]:
    """Construit les flags llama-quantize à partir du dict preset.

    Supporte :
      - preserve_embeddings: bool → --token-embedding-type F16 + --output-tensor-type F16
      - tensor_overrides: liste de "regex=TYPE" → --tensor-type <regex>=<TYPE>
        (émis EN PREMIER → priorité max, pour les pins F16 et top-par-famille)
      - family_quants: dict {famille → type} → --tensor-type <famille>\\..*=<TYPE>
        pour chaque entrée (émis APRÈS tensor_overrides, priorité moindre)

    Ordre llama-quantize : première règle --tensor-type qui matche gagne. Donc
    tensor_overrides (pins + exacts) écrasent family_quants sur un conflit.

    Fallback historique : si aucun de ces champs n'est présent ET que le nom
    est UD-* ou *_XL, applique les overrides MoE-friendly par défaut.
    """
    # llama-quantize --tensor-type n'accepte que les ggml_type bruts, pas les
    # variantes "mix" (_M, _S, _L). On mappe vers le type de base équivalent.
    _TENSOR_TYPE_MAP: dict[str, str] = {
        "Q4_K_M": "Q4_K", "Q4_K_S": "Q4_K",
        "Q5_K_M": "Q5_K", "Q5_K_S": "Q5_K",
        "Q3_K_M": "Q3_K", "Q3_K_S": "Q3_K", "Q3_K_L": "Q3_K",
        "Q2_K_S": "Q2_K",
        "IQ3_M": "IQ3_S",
        "IQ2_M": "IQ2_S",
    }

    args: list[str] = []
    quant_name = quant_cfg.get("name", "")
    source_top_type = quant_cfg.get("source_top_type", "F16")

    # Si source est Q8_0 (ou autre non-F16), on doit autoriser la re-quantization
    if source_top_type not in ("F16", "BF16"):
        args += ["--allow-requantize"]

    preserve_emb = quant_cfg.get("preserve_embeddings")
    overrides = quant_cfg.get("tensor_overrides")
    family_quants = quant_cfg.get("family_quants")

    # Fallback backward-compat pour preset sans config explicite
    if preserve_emb is None and overrides is None and not family_quants:
        is_dynamic = quant_name.startswith("UD-") or quant_name.endswith("_XL")
        if is_dynamic:
            preserve_emb = True
            overrides = [
                r"ffn_gate_inp\..*=F16",
                r"attn_[kqv]\..*=Q8_0",
                r"attn_output\..*=Q8_0",
            ]
        else:
            preserve_emb = False
            overrides = []

    # preserve_embeddings : type cible = min(F16, source)
    emb_type = "F16" if source_top_type in ("F16", "BF16") else source_top_type
    if preserve_emb:
        args += ["--token-embedding-type", emb_type,
                 "--output-tensor-type", emb_type]

    # 1. tensor_overrides en premier (priorité max) : pins F16 + top-X% F16 exacts
    for rule in (overrides or []):
        # Mappe le type si c'est une variante mix (ex: ...=Q4_K_M → ...=Q4_K)
        if "=" in rule:
            parts = rule.rsplit("=", 1)
            parts[1] = _TENSOR_TYPE_MAP.get(parts[1], parts[1])
            rule = "=".join(parts)
        args += ["--tensor-type", rule]

    # 2. family_quants ensuite : règle regex par famille. Format de sortie
    #    "<famille>\..*=<TYPE>" — matche tous les tensors de la famille.
    #    On skip les entrées "base" (redondant avec le fallback llama-quantize).
    for fam, qtype in (family_quants or {}).items():
        if qtype and qtype != "base":
            qtype = _TENSOR_TYPE_MAP.get(qtype, qtype)
            args += ["--tensor-type", f"{fam}\\..*={qtype}"]

    return args


def run_quantize(
    toolbox: str,
    f16_path: Path,
    imatrix_path: Path,
    out_path: Path,
    quant_cfg: dict,
    log_stream,
) -> float:
    """Produit un quant. Overrides lus depuis quant_cfg (config.yaml)."""
    out_path.parent.mkdir(parents=True, exist_ok=True)

    quant_name = quant_cfg["name"]
    quant_base = quant_cfg["base"]
    overrides = build_quantize_overrides(quant_cfg)

    cmd = (
        ["llama-quantize", "--imatrix", str(imatrix_path)]
        + overrides
        + [str(f16_path), str(out_path), quant_base]
    )

    t0 = time.time()
    try:
        with console.status(f"[bold cyan]Quantize[/] {quant_name} → {out_path.name}", spinner="dots"):
            proc = toolbox_popen(toolbox, cmd)
            for line in proc.stdout:
                log_stream.write(line)
                log_stream.flush()
            proc.wait()

        if proc.returncode != 0:
            raise RuntimeError(f"llama-quantize exited with code {proc.returncode}")
    except Exception:
        # Échec / Ctrl+C → on supprime le .gguf tronqué pour éviter que le
        # daemon le découvre et tente de le charger (crash garanti).
        if out_path.exists():
            try:
                out_path.unlink()
            except OSError:
                pass
        raise

    return time.time() - t0


def _validate_output_gguf(
    source_path: Path,
    output_path: Path,
) -> list[str]:
    """Validation post-quantize : parse le header du GGUF produit et vérifie
    la cohérence avec le source. Retourne une liste de warnings (vide = OK).
    Gère les modèles shardés (00001-of-NNNNN) en lisant tous les shards."""
    warnings: list[str] = []
    gguf_mod = _load_gguf_stats()
    if gguf_mod is None:
        return warnings  # can't validate without gguf_stats

    # Lire tous les shards source pour obtenir la liste complète des tensors
    try:
        src_hdr = gguf_mod.read_gguf_header_sharded(source_path)
    except Exception:
        return warnings  # source unreadable, skip

    src_tensors = src_hdr.tensors
    if not src_tensors:
        return warnings

    try:
        out_hdr = gguf_mod.read_gguf_header(output_path)
    except Exception as exc:
        warnings.append(f"GGUF output illisible : {exc}")
        return warnings

    # Tensor count
    if len(out_hdr.tensors) != len(src_tensors):
        warnings.append(
            f"Nombre de tensors différent : source={len(src_tensors)}, "
            f"output={len(out_hdr.tensors)}"
        )

    # Verify all source tensor names present in output
    src_names = {t.name for t in src_tensors}
    out_names = {t.name for t in out_hdr.tensors}
    missing = src_names - out_names
    if missing:
        warnings.append(
            f"{len(missing)} tensor(s) manquant(s) dans l'output : "
            f"{', '.join(sorted(missing)[:5])}"
            f"{'…' if len(missing) > 5 else ''}"
        )

    # Verify output file size is reasonable (not truncated)
    out_size = output_path.stat().st_size
    out_tensor_bytes = out_hdr.total_bytes
    # Output file = header + alignment + tensor data. Tensor data should be
    # at most ~the header-estimated size (exact match not guaranteed due to
    # alignment padding). If file is < 80% of estimated tensor bytes, suspect.
    if out_tensor_bytes > 0 and out_size < out_tensor_bytes * 0.80:
        warnings.append(
            f"Fichier output suspect : {out_size / (1024**3):.2f} GB "
            f"vs {out_tensor_bytes / (1024**3):.2f} GB estimé depuis le header"
        )

    return warnings


# ────────────────────────────────────────────────────────────────────────────
# Main TUI flow
# ────────────────────────────────────────────────────────────────────────────

_REQUIRED_CONFIG_KEYS = ("models_path", "output_subdir", "calibration_dir", "imatrix", "quants")
_REQUIRED_IMATRIX_KEYS = ("chunks", "ctx", "batch", "ngl")


def validate_config(cfg: dict) -> None:
    """Vérifie les clés minimales et les types avant de commencer. Fail fast
    avec un message lisible plutôt qu'un KeyError cryptique à mi-pipeline."""
    if not isinstance(cfg, dict):
        console.print(f"[red]✗[/] config.yaml invalide : racine doit être un mapping.")
        sys.exit(1)

    missing = [k for k in _REQUIRED_CONFIG_KEYS if k not in cfg]
    if missing:
        console.print(f"[red]✗[/] config.yaml : clés manquantes [yellow]{', '.join(missing)}[/]")
        sys.exit(1)

    if not isinstance(cfg["imatrix"], dict):
        console.print("[red]✗[/] config.yaml : `imatrix` doit être un mapping.")
        sys.exit(1)
    missing_im = [k for k in _REQUIRED_IMATRIX_KEYS if k not in cfg["imatrix"]]
    if missing_im:
        console.print(
            f"[red]✗[/] config.yaml : `imatrix.*` clés manquantes "
            f"[yellow]{', '.join(missing_im)}[/]"
        )
        sys.exit(1)

    if not isinstance(cfg["quants"], list) or not cfg["quants"]:
        console.print("[red]✗[/] config.yaml : `quants` doit être une liste non vide.")
        sys.exit(1)

    seen_names: set[str] = set()
    for i, q in enumerate(cfg["quants"]):
        if not isinstance(q, dict) or "name" not in q or "base" not in q:
            console.print(
                f"[red]✗[/] config.yaml : quants[{i}] doit avoir `name` et `base`."
            )
            sys.exit(1)
        if q["name"] in seen_names:
            console.print(f"[red]✗[/] config.yaml : quant name dupliqué [yellow]{q['name']}[/]")
            sys.exit(1)
        seen_names.add(q["name"])


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        console.print(f"[red]Config introuvable : {CONFIG_PATH}[/]")
        sys.exit(1)
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            cfg = yaml.safe_load(f)
    except yaml.YAMLError as exc:
        console.print(f"[red]✗ config.yaml malformé :[/] {exc}")
        sys.exit(1)
    validate_config(cfg)
    return cfg


def resolve_path(p: str) -> Path:
    path = Path(os.path.expandvars(os.path.expanduser(p)))
    if not path.is_absolute():
        path = (SCRIPT_DIR / path).resolve()
    return path


def _choice_back():
    """Item standard de retour dans un select. Valeur = sentinelle BACK."""
    return questionary.Choice(title="← Retour", value=BACK)


def next_versioned_gguf(base_path: Path) -> Path:
    """Si base_path existe déjà, retourne <stem>-v2.gguf, -v3.gguf, etc.
    Évite d'écraser silencieusement un quant précédent — utile pour A/B entre
    presets custom ou pour retenter après un tweak d'imatrix/calib."""
    if not base_path.exists():
        return base_path
    stem = base_path.stem
    suffix = base_path.suffix
    parent = base_path.parent
    # Si le stem a déjà un suffixe -vN, on repart de la base.
    m = re.match(r"^(.*?)-v(\d+)$", stem)
    if m:
        stem = m.group(1)
    v = 2
    while True:
        candidate = parent / f"{stem}-v{v}{suffix}"
        if not candidate.exists():
            return candidate
        v += 1


MODE_FAQ = "faq"


def screen_select_mode():
    """Premier écran : choix du mode. Retourne MODE_* | None (abort)."""
    console.rule("[bold magenta]Mode[/]", style="magenta")
    return questionary.select(
        "Quoi faire ?",
        choices=[
            questionary.Choice(
                title="Quantize *             — pipeline complet (imatrix si besoin + quants)",
                value=MODE_QUANTIZE,
            ),
            questionary.Choice(
                title="Build imatrix only     — calcule juste la matrice (pas de GGUF produit)",
                value=MODE_IMATRIX_ONLY,
            ),
            questionary.Choice(
                title="Inspect imatrix        — analyse une imatrix existante + émet preset",
                value=MODE_INSPECT,
            ),
            questionary.Choice(
                title="Analyze GGUF           — inspecte un GGUF existant (quants par famille)",
                value=MODE_ANALYZE,
            ),
            questionary.Choice(
                title="FAQ                    — guide de quantization et référence",
                value=MODE_FAQ,
            ),
        ],
    ).ask()


def screen_faq():
    """Affiche la FAQ interactive dans le TUI."""
    FAQ_SECTIONS: list[tuple[str, str]] = [
        # (titre, contenu markdown-ish Rich)
        ("Concepts fondamentaux", """\
[bold cyan]C'est quoi une imatrix ?[/]
On fait tourner le modèle F16 sur un corpus de calibration et on mesure \
l'énergie d'activation (sum(x²)) de chaque colonne de chaque tensor. \
Plus un tensor absorbe d'énergie, plus il est "chaud" — le quantiser \
agressivement amplifiera les erreurs d'arrondi.
L'imatrix guide llama-quantize pour allouer plus de précision aux \
colonnes chaudes (elles gardent plus de bits).

[bold cyan]C'est quoi "bits per weight" (bpw) ?[/]
Le nombre moyen de bits par poids du modèle.
  F16 = 16 bpw (référence)   Q8_0 ≈ 8.5   Q6_K ≈ 6.5
  Q5_K_M ≈ 5.5               Q4_K_M ≈ 4.5  IQ3_XXS ≈ 3.06
Plus c'est bas, plus c'est petit, mais plus la qualité se dégrade.

[bold cyan]Quelle différence entre Q6_K brut et Q6_K avec imatrix ?[/]
Sans imatrix, toutes les colonnes d'un tensor sont traitées pareil.
Avec imatrix, les colonnes chaudes (outliers) gardent plus de bits, les \
froides sont compressées davantage. Même type, même taille, meilleure qualité."""),

        ("Familles de tensors : priorité de bump", """\
Par priorité de bump décroissante (où mettre ses bits en premier) :

[bold red]1. NORMS[/]  (attn_norm, ffn_norm, output_norm, k/q_norm…)
   → [red]F16 TOUJOURS[/]. Tout petits (quelques Ko), stabilisent \
numériquement chaque layer.

[bold red]2. ROUTEUR MOE[/]  (ffn_gate_inp) — MoE uniquement
   → [red]F16 TOUJOURS[/]. Décide quel expert traite chaque token. Petit \
tensor, levier énorme. Dégrader = gating erratique.

[bold red]3. I/O[/]  (token_embd, output)
   → [red]F16[/] via preserve_embeddings. TOUT le signal entre/sort par là.

[bold yellow]4. ATTENTION K et Q[/]  (attn_k, attn_q)
   → [yellow]Q8_0 minimum, F16 idéal[/]. C'est le "matching" K·Q — si c'est \
bruité, le modèle "rate" des connexions contextuelles.
   Portent typiquement [bold]50-60% de l'énergie imatrix[/] à eux deux.
   [bold]Si tu ne peux mettre que 2 familles en F16, c'est celles-ci.[/]

[bold yellow]5. ATTENTION V[/]  (attn_v)
   → Q8_0 sûr, Q6_K acceptable. Le contenu qui circule — moins fragile \
car le routage K·Q est déjà fait.

[bold yellow]6. ATTENTION OUTPUT[/]  (attn_output)
   → Base OK, Q8_0 si budget. Reprojection de sortie, compensable.

[bold green]7. FFN DOWN[/]  (ffn_down / ffn_down_exps)
   → Le plus critique des FFN. Porte le "savoir appris". Q8_0 recommandé.
   Dense : pas de redondance. MoE : redondance naturelle, plus tolérant.

[bold green]8. FFN GATE et UP[/]  (ffn_gate, ffn_up / ffn_gate_up_exps)
   → Les plus tolérants. Base OK. Sur MoE, les experts font 80-85% du \
volume — c'est ici qu'on gagne le plus de taille."""),

        ("Recettes par objectif", """\
[bold cyan]Meilleure qualité possible (sous F16) ?[/]
  base=Q8_0, attn K/Q=F16, norms/emb/output=F16
  → ~0.55× F16. Le Q8 a un effet régularisant bénéfique.

[bold cyan]Bon compromis taille/qualité ?[/]
  base=Q6_K, attn K/Q=Q8_0, ffn_down=Q8_0, preserve_emb, pins F16
  → ~0.43× F16. Quasi indiscernable du F16 sur prose.

[bold cyan]"Q6++" — Q6 mais un peu mieux ?[/]
  base=Q6_K, attn K/Q=Q8_0, ffn_down=Q8_0, reste=base
  Le "++" vient du ciblage, pas du volume F16.
  → ~0.45× F16.

[bold cyan]"Q6++" avec du F16 chirurgical ?[/]
  base=Q6_K, [bold]attn K/Q=F16[/], ffn_down=Q8_0, reste=base
  K et Q = 56% de l'énergie, coût ~8 GB → meilleur ratio quali/taille.
  → ~0.48× F16.

[bold cyan]Compact (budget limité) ?[/]
  UD-Q5_K_M (~0.36×) ou UD-Q4_K_M (~0.30×) avec imatrix custom.
  En dessous de Q4_K_M, la qualité chute vite sauf IQ + bonne imatrix."""),

        ("Dense vs MoE", """\
[bold cyan]Pourquoi cette distinction est critique ?[/]

[bold]DENSE[/] (Llama, Mistral, Phi, Qwen…)
  • 3 tensors FFN par layer (gate, up, down) — pas de redondance
  • ffn_down critique, un seul exemplaire par layer
  • Profils cumulatifs (2tier/3tier) fonctionnent bien : le tri global
    par énergie est pertinent, tous les tensors sont homogènes

[bold]MOE[/] (Gemma-4, Mixtral, DeepSeek-V2…)
  • N experts FFN par layer (8, 16, 64…), seulement 2-8 actifs/token
  • Experts = 80-85% du volume et de l'énergie imatrix
  • Redondance naturelle → plus tolérants à la quantization
  • [red]MAIS[/] le routeur (ffn_gate_inp) est ULTRA critique → F16 obligatoire
  • [red]Profils cumulatifs DÉCONSEILLÉS[/] : les experts dominent l'énergie,
    le tri global met tout en F16 ou tout en base, sans granularité
  • → Utiliser [bold]surgical ou custom[/] (per-family)

[bold cyan]Comment savoir si c'est dense ou MoE ?[/]
brain-quant le détecte automatiquement. En cas de doute : si la taille F16 \
est disproportionnée vs le nombre de paramètres "actifs" annoncé \
(ex: 27B actifs mais 52 GB F16), c'est un MoE."""),

        ("Concentration d'énergie et calibration", """\
[bold cyan]L'indicateur "Concentration top 10%" dans le builder ?[/]
Mesure la fraction d'énergie dans les 10% de colonnes les plus chaudes.
  [red]>50% concentré[/]  → outliers dominants, sensible à la quant → Q8/F16
  [yellow]25-50% modéré[/]   → entre les deux, choix selon le budget
  [green]<25% diffus[/]     → énergie répartie, base OK

[bold cyan]Le corpus de calibration change quelque chose ?[/]
Oui, surtout pour les quants agressifs (Q4 et en dessous). L'imatrix \
mesure les colonnes chaudes SUR CE CORPUS. Idéal : corpus représentatif \
de l'usage cible (même langue, même domaine). Pour du généraliste, un \
mix diversifié (prose + code + dialogue) est le meilleur compromis.

[bold cyan]Combien de chunks ?[/]
  <50 → imatrix bruitée
  100-200 → sweet spot
  >300 → rendements décroissants"""),

        ("Pièges courants", """\
[bold cyan]F16 partout mais le modèle est instable ?[/]
Paradoxalement, F16 peut être [bold]MOINS stable[/] que Q8_0 sur certains \
modèles (observé sur distills type Claude-Opus). Le Q8 a un effet de \
bruit/régularisation qui casse les attracteurs de répétition.
→ Essayer Q8_K_MAX.

[bold cyan]Pourquoi ne pas mixer F16/Q8 par layer ?[/]
Les quants [bold]HÉTÉROGÈNES par layer[/] (couche 0 en F16, couche 1 en Q8…) \
sont [red]INSTABLES[/] sur long context. Les conversions de type inter-layers \
accumulent des erreurs asymétriques → attracteurs de répétition.
Les quants [bold]UNIFORMES par layer[/] (même type partout au sein d'une \
famille) sont stables même agressifs.

[bold cyan]Preset custom plus gros que prévu ?[/]
Vérifier :
  • preserve_embeddings activé ? (sinon token_embd/output au plancher)
  • pins F16 activés ? (norms + routeur MoE)
  • base pas trop haute ? (Q8_0 en base = tout le non-spécifié en Q8)"""),
    ]

    while True:
        console.print()
        console.rule("[bold magenta]FAQ — Guide de quantization[/]", style="magenta")

        section_choices = [
            questionary.Choice(f"{i+1}. {title}", value=i)
            for i, (title, _) in enumerate(FAQ_SECTIONS)
        ]
        section_choices.append(questionary.Choice("Tout afficher", value="all"))
        section_choices.append(questionary.Choice("← Retour au menu", value="back"))

        choice = questionary.select("Section :", choices=section_choices).ask()
        if choice is None or choice == "back":
            return

        if choice == "all":
            for title, content in FAQ_SECTIONS:
                console.print()
                console.rule(f"[bold cyan]{title}[/]", style="cyan")
                console.print(Panel(content, padding=(1, 2), border_style="dim"))
            console.print()
            questionary.press_any_key_to_continue("Appuie sur une touche pour continuer…").ask()
        else:
            title, content = FAQ_SECTIONS[choice]
            console.print()
            console.rule(f"[bold cyan]{title}[/]", style="cyan")
            console.print(Panel(content, padding=(1, 2), border_style="dim"))
            console.print()
            questionary.press_any_key_to_continue("Appuie sur une touche pour continuer…").ask()


def screen_inspect_options(arch: str = "dense"):
    """Demande les paramètres d'émission de preset en mode inspect.
    Retourne (emit: bool, profile: str, name: str, append: bool) | None."""
    emit = questionary.confirm(
        "Émettre un preset tensor_overrides basé sur cette imatrix ?",
        default=False,
    ).ask()
    if emit is None:
        return None
    if not emit:
        return (False, "", "", False)

    # Profiles adaptés à l'architecture : recommandés en premier avec *
    if arch in ("moe", "hybrid"):
        choices = [
            questionary.Choice(
                "custom *         — BUILDER INTERACTIF famille par famille",
                value="custom",
            ),
            questionary.Choice(
                "surgical         — top 20% F16/famille + pins norms/routers",
                value="surgical",
            ),
            questionary.Choice(
                "surgical-light   — top 10% F16/famille (conservateur)",
                value="surgical-light",
            ),
            questionary.Choice(
                "surgical-xl      — top 35% F16/famille (généreux)",
                value="surgical-xl",
            ),
            questionary.Choice(
                "3tier            — cumulative (moins adapté aux MoE)",
                value="3tier",
            ),
            questionary.Choice(
                "2tier            — cumulative conservateur",
                value="2tier",
            ),
            questionary.Choice(
                "4tier            — cumulative agressif",
                value="4tier",
            ),
        ]
    else:
        choices = [
            questionary.Choice(
                "3tier *          — top 5% F16 + 40% Q8 + reste Q6 (sweet spot)",
                value="3tier",
            ),
            questionary.Choice(
                "2tier            — top 15% F16 + reste Q8 (conservateur)",
                value="2tier",
            ),
            questionary.Choice(
                "4tier            — top 3% F16 + 20% Q8 + 50% Q6 + reste Q5 (agressif)",
                value="4tier",
            ),
            questionary.Choice(
                "custom           — BUILDER INTERACTIF famille par famille",
                value="custom",
            ),
            questionary.Choice(
                "surgical         — per-family top 20% F16 (surtout pour MoE)",
                value="surgical",
            ),
            questionary.Choice(
                "surgical-light   — per-family top 10% F16",
                value="surgical-light",
            ),
            questionary.Choice(
                "surgical-xl      — per-family top 35% F16",
                value="surgical-xl",
            ),
        ]

    profile = questionary.select(
        "Profile de tiering :",
        choices=choices,
    ).ask()
    if profile is None:
        return None

    # En mode "custom", le nom et le flag append sont demandés par le builder
    # lui-même (plus naturel dans son flow).
    if profile == "custom":
        return (True, "custom", "", False)

    name = questionary.text(
        "Nom du preset :",
        default="Q_auto",
    ).ask()
    if not name:
        return None

    append = questionary.confirm(
        "Ajouter automatiquement au config.yaml (backup .bak créé) ?",
        default=False,
    ).ask()
    if append is None:
        return None

    return (True, profile, name.strip(), append)


def screen_select_model(models_path: Path):
    """Retourne ModelEntry | None (abort). Premier écran : pas de retour."""
    models = scan_models(models_path)
    if not models:
        console.print(
            f"[red]Aucun GGUF F16/BF16 trouvé dans[/] [yellow]{models_path}[/]\n"
            f"[dim]Vérifie que models_path dans config.yaml est correct.[/]"
        )
        sys.exit(1)

    choices = []
    for m in models:
        shard_info = f"{m.total_shards} shards" if m.total_shards > 1 else "1 shard"
        title = (
            f"{m.display_name:<55} "
            f"{fmt_size(m.total_bytes):>10}   "
            f"[{m.quant_tag}, {shard_info}]"
        )
        choices.append(questionary.Choice(title=title, value=m))

    console.rule("[bold magenta]1/4  Modèle source F16/BF16[/]", style="magenta")
    return questionary.select(
        "Sélectionne le modèle à quantifier :",
        choices=choices,
        use_arrow_keys=True,
        use_search_filter=True,
        use_jk_keys=False,  # incompat avec search_filter
    ).ask()


def screen_select_calib(calib_dir: Path):
    """Retourne Path | BACK | None."""
    calibs = scan_calibration(calib_dir)

    choices = [_choice_back()]
    for c in calibs:
        tok = c.est_tokens
        if tok < 50_000:
            tag = "[red]⚠ petit[/]"
        elif tok > 1_500_000:
            tag = "[yellow]⚠ très long[/]"
        elif 200_000 <= tok <= 600_000:
            tag = "[green]✓ optimal[/]"
        else:
            tag = ""
        title = (
            f"{c.path.name:<45} "
            f"{fmt_size(c.size_bytes):>10}   "
            f"({fmt_tokens(tok)} tokens) {tag}"
        )
        choices.append(questionary.Choice(title=title, value=c.path))

    choices.append(questionary.Choice(title="[ Chemin libre… ]", value="__custom__"))

    console.rule("[bold magenta]2/4  Calibration[/]", style="magenta")
    if not calibs:
        console.print(
            f"[yellow]⚠ Aucun .txt trouvé dans {calib_dir}[/] "
            f"— tu peux pointer un chemin libre.\n"
        )

    choice = questionary.select(
        "Sélectionne le fichier de calibration :",
        choices=choices,
        use_arrow_keys=True,
    ).ask()
    if choice is None or choice == BACK:
        return choice

    if choice == "__custom__":
        custom = questionary.path(
            "Chemin absolu vers le fichier .txt :",
            only_directories=False,
        ).ask()
        if not custom:
            return BACK  # path prompt vide → retour plutôt qu'abort
        path = Path(custom).expanduser().resolve()
        if not path.is_file():
            console.print(f"[red]Fichier introuvable : {path}[/]")
            return BACK
        return path

    return choice


def _default_quant_names(quants_cfg: list[dict]) -> set[str]:
    """Noms des presets marqués `default: true` dans config.yaml. Si aucun,
    fallback sur UD-Q6_K_XL s'il existe, sinon rien."""
    marked = {q["name"] for q in quants_cfg if q.get("default") is True}
    if marked:
        return marked
    for q in quants_cfg:
        if q["name"] == "UD-Q6_K_XL":
            return {"UD-Q6_K_XL"}
    return set()


def screen_select_quants(quants_cfg: list[dict], f16_bytes: int):
    """Retourne list[dict] | BACK | None. Re-demande si sélection vide."""
    defaults = _default_quant_names(quants_cfg)

    choices = [_choice_back()]
    for q in quants_cfg:
        est = estimate_quant_bytes(f16_bytes, q)
        mark = " *" if q["name"] in defaults else ""
        arch_tag = ""
        q_arch = q.get("arch", "")
        if q_arch == "moe":
            arch_tag = " [MoE]"
        elif q_arch == "dense":
            arch_tag = " [Dense]"
        elif q_arch == "hybrid":
            arch_tag = " [Hybride]"
        name_col = f"{q['name']}{mark}"
        title = (
            f"{name_col:<16} "
            f"~{fmt_size(est):<10}   "
            f"{q['desc']}{arch_tag}"
        )
        choices.append(questionary.Choice(
            title=title, value=q,
        ))

    console.rule("[bold magenta]3/4  Quants à produire[/]", style="magenta")

    while True:
        selected = questionary.checkbox(
            "Espace pour sélectionner, Enter pour valider (au moins 1) :",
            choices=choices,
        ).ask()
        if selected is None:
            return None  # Ctrl+C → abort
        if any(s == BACK for s in selected):
            return BACK
        # Filtre la sentinelle si cochée par accident + vraie value
        selected = [s for s in selected if s != BACK]
        if selected:
            return selected
        console.print("[yellow]⚠ Sélectionne au moins un quant (espace), "
                      "ou coche « ← Retour » pour revenir en arrière.[/]")


def screen_options(default_toolbox: str, imatrix_exists: bool, imatrix_path: Path):
    """Retourne (toolbox, skip_imatrix) | BACK | None."""
    console.rule("[bold magenta]4/4  Options[/]", style="magenta")
    _tb_mark = lambda v: " *" if v == default_toolbox else ""
    toolbox = questionary.select(
        "Toolbox :",
        choices=[
            _choice_back(),
            questionary.Choice(f"llama-vulkan-radv{_tb_mark('llama-vulkan-radv')}   — stable, default prod", value="llama-vulkan-radv"),
            questionary.Choice(f"llama-rocm-7.2{_tb_mark('llama-rocm-7.2')}      — perf max, moins stable", value="llama-rocm-7.2"),
        ],
    ).ask()
    if toolbox is None or toolbox == BACK:
        return toolbox

    skip_imatrix = False
    if imatrix_exists:
        skip_imatrix = questionary.confirm(
            f"Imatrix déjà présente : {imatrix_path.name} "
            f"({fmt_size(imatrix_path.stat().st_size)}). La réutiliser ?",
            default=True,
        ).ask()
        if skip_imatrix is None:
            return None

    return (toolbox, skip_imatrix)


# Heuristiques empiriques Strix Halo Vulkan (mesurées sur Gemma-4-26B F16 52 GB) :
# - imatrix : ~4.5 s par chunk par 10 GB de F16 (linéaire en size × chunks)
# - quantize : ~25 s par GB de F16, à peu près indépendant de la cible quant
_IMATRIX_SEC_PER_CHUNK_PER_10GB = 4.5
_QUANTIZE_SEC_PER_GB = 25.0


def _estimate_pipeline_sec(
    f16_bytes: int, chunks: int, skip_imatrix: bool, n_quants: int,
) -> tuple[int, int, int]:
    """(imatrix_sec, quantize_sec, total_sec). Retourne 0 pour imatrix si skip."""
    gb = f16_bytes / (1024 ** 3)
    im = 0 if skip_imatrix else int(_IMATRIX_SEC_PER_CHUNK_PER_10GB * chunks * gb / 10)
    qz = int(_QUANTIZE_SEC_PER_GB * gb * n_quants)
    return im, qz, im + qz


def screen_confirm_imatrix(
    model: ModelEntry, calib: Path, toolbox: str,
    imatrix_path: Path, cfg: dict,
):
    """Version allégée du confirm pour MODE_IMATRIX_ONLY.
    Retourne True (go) | False (annuler) | BACK."""
    im_sec, _, _ = _estimate_pipeline_sec(
        model.total_bytes, cfg["imatrix"]["chunks"], skip_imatrix=False, n_quants=0,
    )
    calib_tokens = int(calib.stat().st_size / 3.8)

    lines = [
        f"[bold]Source[/]         {model.display_name}",
        f"                 {fmt_size(model.total_bytes)} · "
        f"{model.total_shards} shard(s) · {model.quant_tag}",
        f"                 [dim]{model.first_shard}[/]",
        "",
        f"[bold]Calibration[/]    {calib.name}",
        f"                 {fmt_tokens(calib_tokens)} tokens estimés",
        f"                 [dim]{calib}[/]",
        "",
        f"[bold]Imatrix[/]        [cyan]à calculer[/] — ~{fmt_duration(im_sec)}",
        f"                 [dim]{imatrix_path}[/]",
        "",
        f"[bold]Toolbox[/]        {toolbox}",
        f"                 [dim]chunks={cfg['imatrix']['chunks']}, "
        f"ctx={cfg['imatrix']['ctx']}, batch={cfg['imatrix']['batch']}, "
        f"ngl={cfg['imatrix']['ngl']}[/]",
        "",
        "[yellow]Mode : imatrix uniquement — aucun GGUF ne sera produit.[/]",
    ]

    console.rule("[bold magenta]Confirmation (imatrix only)[/]", style="magenta")
    console.print(Panel("\n".join(lines), border_style="magenta", padding=(1, 2)))

    answer = questionary.select(
        "On y va ?",
        choices=[
            _choice_back(),
            questionary.Choice("✓ Lancer le calcul imatrix *", value="go"),
            questionary.Choice("✗ Annuler", value="cancel"),
        ],
    ).ask()
    if answer is None or answer == "cancel":
        return False
    if answer == BACK:
        return BACK
    return True


def screen_confirm(
    model: ModelEntry, calib: Path, quants: list[dict],
    toolbox: str, skip_imatrix: bool, imatrix_path: Path,
    output_dir: Path, cfg: dict,
):
    """Retourne True (go) | False (non) | BACK."""
    base = model.base_name
    # (preset, out_path, taille_estimée, was_versioned: bool)
    plan: list[tuple[dict, Path, int, bool]] = []
    for q in quants:
        wanted = output_dir / f"{base}-brain-{q['name']}.gguf"
        out = next_versioned_gguf(wanted)
        est = estimate_quant_bytes(model.total_bytes, q)
        plan.append((q, out, est, out != wanted))

    im_sec, qz_sec, total_sec = _estimate_pipeline_sec(
        model.total_bytes, cfg["imatrix"]["chunks"], skip_imatrix, len(quants),
    )
    calib_tokens = int(calib.stat().st_size / 3.8)

    lines: list[str] = []
    lines.append(f"[bold]Source[/]         {model.display_name}")
    lines.append(
        f"                 {fmt_size(model.total_bytes)} · "
        f"{model.total_shards} shard(s) · {model.quant_tag}"
    )
    lines.append(f"                 [dim]{model.first_shard}[/]")
    lines.append("")
    lines.append(f"[bold]Calibration[/]    {calib.name}")
    lines.append(f"                 {fmt_tokens(calib_tokens)} tokens estimés")
    lines.append(f"                 [dim]{calib}[/]")
    lines.append("")
    if skip_imatrix:
        lines.append(f"[bold]Imatrix[/]        [yellow]réutilisée[/] ({imatrix_path.name})")
    else:
        lines.append(f"[bold]Imatrix[/]        [cyan]à calculer[/] — ~{fmt_duration(im_sec)}")
    lines.append(f"                 [dim]{imatrix_path}[/]")
    lines.append("")
    lines.append(f"[bold]Quants[/]         {len(quants)} variante(s) — ~{fmt_duration(qz_sec)}")
    for q, out, sz, versioned in plan:
        marker = f" [yellow](version auto → {out.name})[/]" if versioned else ""
        lines.append(f"                 • {q['name']:<14} ~{fmt_size(sz):>10}{marker}")
    lines.append("")
    lines.append(f"[bold]Output[/]         {output_dir}/")
    for _, out, _, _ in plan:
        lines.append(f"                 └ [cyan]{out.name}[/]")
    lines.append("")
    lines.append(f"[bold]Toolbox[/]        {toolbox}")
    if not skip_imatrix:
        lines.append(
            f"[bold]Imatrix flags[/]  -fa 1 --no-mmap -ngl {cfg['imatrix']['ngl']} "
            f"-t {os.cpu_count() or 16} -c {cfg['imatrix']['ctx']} "
            f"-b {cfg['imatrix']['batch']}"
        )
    lines.append(f"[bold]Durée totale[/]   [bold cyan]~{fmt_duration(total_sec)}[/]")

    console.print()
    console.print(Panel(
        "\n".join(lines),
        title="[bold magenta]brain-quant — confirmation[/]",
        border_style="magenta",
        padding=(1, 2),
    ))
    console.print()

    answer = questionary.select(
        "Action :",
        choices=[
            questionary.Choice("✓ Lancer la pipeline *", value="go"),
            questionary.Choice("← Retour (modifier la sélection)", value=BACK),
            questionary.Choice("✗ Annuler", value="cancel"),
        ],
    ).ask()
    if answer is None or answer == "cancel":
        return False
    if answer == BACK:
        return BACK
    return True


def _load_gguf_stats():
    """Charge gguf_stats.py (nom importable directement, pas besoin d'importlib
    fancy). Retourne le module ou None si absent."""
    import importlib.util
    path = SCRIPT_DIR / "gguf_stats.py"
    if not path.exists():
        return None
    spec = importlib.util.spec_from_file_location("gguf_stats", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["gguf_stats"] = mod
    spec.loader.exec_module(mod)
    return mod


# ────────────────────────────────────────────────────────────────────────────
# Builder TUI custom — constantes et helpers
# ────────────────────────────────────────────────────────────────────────────

# Types proposés à la sélection par famille. Ordre = ordre d'affichage.
_QUANT_CHOICES: list[str] = ["F16", "Q8_0", "Q6_K", "Q5_K_M", "Q4_K_M", "base"]

# Base quants proposables comme plancher du preset.
_BASE_CHOICES: list[str] = ["Q8_0", "Q6_K", "Q5_K_M", "Q4_K_M"]

# Bits par poids pour estimation taille (aligné sur gguf_stats.BITS_PER_WEIGHT).
_BPW: dict[str, float] = {
    "F32": 32.0, "F16": 16.0, "BF16": 16.0,
    "Q8_0": 8.5, "Q8_K": 8.5,
    "Q6_K": 6.5625, "Q5_K_M": 5.5, "Q5_K": 5.5,
    "Q4_K_M": 4.5, "Q4_K": 4.5, "Q4_0": 4.5,
    "Q3_K": 3.4375, "Q2_K": 2.625,
}


def _family_of_tensor_name(name: str) -> str:
    """Dernier segment avant .weight/.bias. Cohérent avec inspect-imatrix."""
    m = re.search(r"(?:^|\.)([^.]+)\.(?:weight|bias)$", name)
    return m.group(1) if m else "_other"


def _estimate_tensor_bytes(n_params: int, target: str, fallback_bpw: float = 16.0) -> int:
    """Taille en bytes d'un tensor à n_params en quant target."""
    bpw = _BPW.get(target, fallback_bpw)
    return int(n_params * bpw / 8)


def _estimate_preset_size(
    gguf_header,
    family_quants: dict[str, str],
    top_f16_tensor_names: set[str],
    f16_pin_rx: list[re.Pattern],
    base: str,
    preserve_embeddings: bool = True,
    top_type: str = "F16",
    preserved_f16_names: set[str] | None = None,
) -> tuple[int, int]:
    """Estime la taille totale d'un preset.

    Retourne (target_bytes, current_bytes) — target = si on quantisait
    avec ces choix, current = taille actuelle dans le GGUF source.
    top_type = type max dispo (F16 pour source F16, Q8_0 pour source Q8_0).
    preserved_f16_names = tensors à garder en F16 (source Q8_K_P)."""
    _PRESERVED_FAMILIES = {"token_embd", "output"}
    _preserved = preserved_f16_names or set()

    total_target = 0
    total_current = 0
    for t in gguf_header.tensors:
        fam = _family_of_tensor_name(t.name)
        target_type_: str | None = None
        # preserved F16 from source (highest priority)
        if t.name in _preserved:
            target_type_ = "F16"
        # preserve_embeddings → type max source (F16 ou Q8_0)
        if target_type_ is None and preserve_embeddings and fam in _PRESERVED_FAMILIES:
            target_type_ = top_type
        # pins
        if target_type_ is None:
            for rx in f16_pin_rx:
                if rx.search(t.name):
                    target_type_ = top_type
                    break
        # bonus tensors
        if target_type_ is None and t.name in top_f16_tensor_names:
            target_type_ = top_type
        # family_quants
        if target_type_ is None:
            fq = family_quants.get(fam)
            if fq and fq != "base":
                target_type_ = fq
        # base
        if target_type_ is None:
            target_type_ = base

        total_target += _estimate_tensor_bytes(t.n_params, target_type_,
                                                fallback_bpw=t.bits_per_weight)
        total_current += t.bytes_current
    return total_target, total_current


def _compute_tier_sizes(
    gguf_header,
    family_quants: dict[str, str],
    top_f16_tensor_names: set[str],
    f16_pin_rx: list[re.Pattern],
    base: str,
    tier_counts: dict[str, int],
    preserve_embeddings: bool = True,
    top_type: str = "F16",
    preserved_f16_names: set[str] | None = None,
) -> dict[str, int]:
    """Calcule la taille réelle en bytes de chaque tier du récap, en
    itérant sur les tensors GGUF avec la même logique de priorité que
    _estimate_preset_size. Garantit que sum(tier_sizes) + embeddings = total."""
    _PRESERVED_FAMILIES = {"token_embd", "output"}
    _preserved = preserved_f16_names or set()
    _preserved_label = "F16 (préservé source)"

    # Parse tier_counts keys pour construire les reverse maps
    _tier_rx = re.compile(r"^(\S+)(?:\s+bonus\s+\d+%)?\s+\(famille (\w+)\)")
    bonus_labels: dict[str, str] = {}   # family → tier_label
    family_labels: dict[str, str] = {}  # family → tier_label
    base_label: str | None = None
    pins_label: str | None = None
    for label in tier_counts:
        if "pins auto" in label:
            pins_label = label
            continue
        m = _tier_rx.search(label)
        if m:
            if "bonus" in label:
                bonus_labels[m.group(2)] = label
            elif "base" in label:
                base_label = label
            else:
                family_labels[m.group(2)] = label

    sizes: dict[str, int] = defaultdict(int)

    for t in gguf_header.tensors:
        fam = _family_of_tensor_name(t.name)

        # Classification alignée sur tier_counts (pas sur l'exécution) :
        # bonus et family_quants AVANT pins, car tier_counts les classe ainsi.
        # Le type de quant final est le même (F16 dans les deux cas pour les
        # familles pinnées), seul le bucket d'affichage change.
        target_type: str | None = None
        tier_label: str | None = None

        # 0. Preserved F16 from source Q8_K_P (highest priority)
        if t.name in _preserved:
            target_type = "F16"
            tier_label = _preserved_label

        # 1. Preserve embeddings → pas dans tier_counts
        if target_type is None and preserve_embeddings and fam in _PRESERVED_FAMILIES:
            continue

        # 2. Bonus tensors (tensor individuel au top_type)
        if target_type is None and t.name in top_f16_tensor_names:
            target_type = top_type
            tier_label = bonus_labels.get(fam, f"{top_type} bonus (famille {fam})")

        # 3. Family quants (ssm_alpha=F16, ffn_up_exps=Q8_0, etc.)
        if target_type is None:
            fq = family_quants.get(fam)
            if fq and fq != "base":
                target_type = fq
                tier_label = family_labels.get(fam, f"{fq} (famille {fam})")

        # 4. Pins (norms résiduels, etc. au top_type)
        if target_type is None:
            for rx in f16_pin_rx:
                if rx.search(t.name):
                    target_type = top_type
                    tier_label = pins_label or f"{top_type} (pins auto)"
                    break

        # 5. Base
        if target_type is None:
            target_type = base
            tier_label = base_label or f"{base} (base)"

        est = _estimate_tensor_bytes(t.n_params, target_type,
                                     fallback_bpw=t.bits_per_weight)
        sizes[tier_label] += est

    return dict(sizes)


def _format_size_delta(bytes_diff: int) -> str:
    """Format '-1.3 GB' / '+0 GB' pour affichage relatif."""
    abs_mb = abs(bytes_diff) / (1024 ** 2)
    if abs_mb < 1:
        return f"{'+' if bytes_diff >= 0 else '-'}{abs_mb*1024:.0f} KB"
    if abs_mb < 1024:
        return f"{'+' if bytes_diff >= 0 else '-'}{abs_mb:.0f} MB"
    return f"{'+' if bytes_diff >= 0 else '-'}{abs_mb/1024:.2f} GB"


def _format_size(b: int) -> str:
    """Format '3.2 GB'."""
    gb = b / (1024 ** 3)
    if gb >= 1:
        return f"{gb:.2f} GB"
    mb = b / (1024 ** 2)
    if mb >= 1:
        return f"{mb:.0f} MB"
    return f"{b / 1024:.0f} KB"


def _aggregate_families(
    imatrix_tensors: list,   # list[TensorStat]
    gguf_header,
) -> list[dict]:
    """Consolide imatrix + gguf par famille. Retourne une liste de dicts
    avec stats imatrix (% total) + stats gguf (N tensors, params, bytes).
    Trié par % imatrix décroissant — les familles les plus chaudes d'abord."""
    # Imatrix sums par famille + concentration weighted
    imatrix_by_fam: dict[str, float] = defaultdict(float)
    imatrix_conc_num: dict[str, float] = defaultdict(float)  # sum(conc * energy)
    imatrix_conc_den: dict[str, float] = defaultdict(float)  # sum(energy)
    for t in imatrix_tensors:
        fam = _family_of_tensor_name(t.name)
        imatrix_by_fam[fam] += t.sum_values
        imatrix_conc_num[fam] += t.concentration_top10 * t.sum_values
        imatrix_conc_den[fam] += t.sum_values
    imatrix_total = sum(imatrix_by_fam.values()) or 1.0

    # GGUF tensors par famille
    gguf_by_fam: dict[str, list] = defaultdict(list)
    for t in gguf_header.tensors:
        gguf_by_fam[_family_of_tensor_name(t.name)].append(t)

    families = set(imatrix_by_fam.keys()) | set(gguf_by_fam.keys())
    out: list[dict] = []
    for fam in families:
        ggs = gguf_by_fam.get(fam, [])
        total_params = sum(t.n_params for t in ggs)
        total_bytes = sum(t.bytes_current for t in ggs)
        pct_imatrix = (imatrix_by_fam.get(fam, 0.0) / imatrix_total) * 100
        # Concentration : weighted average of per-tensor top-10% concentration
        den = imatrix_conc_den.get(fam, 0.0)
        concentration = (imatrix_conc_num.get(fam, 0.0) / den) if den > 0 else 0.0
        out.append({
            "family": fam,
            "pct_imatrix": pct_imatrix,
            "has_imatrix": fam in imatrix_by_fam,
            "concentration_top10": concentration,
            "n_tensors": len(ggs),
            "total_params": total_params,
            "total_bytes": total_bytes,
        })
    out.sort(key=lambda d: d["pct_imatrix"], reverse=True)
    return out


def _ask_family_quant(
    fam_info: dict,
    doc: dict,
    base_quant: str,
    default_quant: str,
    total_current_bytes: int,
    idx: int,
    total_families: int,
    priority: tuple[str, str] | None = None,
    source_top_type: str = "F16",
) -> str | None:
    """Affiche un Panel pédagogique pour une famille et demande le quant.
    Retourne le type choisi ou None (abort).
    priority = (label, couleur_rich) ex: ("prioritaire", "[red]")."""
    fam = fam_info["family"]
    n_tensors = fam_info["n_tensors"]
    total_bytes = fam_info["total_bytes"]
    pct = fam_info["pct_imatrix"]

    prio_label, prio_color = priority or ("?", "[dim]")

    # Panel info
    lines = [
        f"[bold]{doc['label']}[/]  [dim]({fam})[/]"
        f"  {prio_color}[{prio_label}][/]",
        "",
        f"[cyan]Rôle[/]       {doc['role']}",
        f"[yellow]Impact[/]     {doc['impact']}",
        f"[green]Reco[/]       {doc['reco']}",
        "",
        f"[dim]Stats sur ce modèle :[/]",
        f"  • {n_tensors} tensor(s)  "
        f"·  {fam_info['total_params']/1e6:.1f}M params  "
        f"·  {_format_size(total_bytes)} actuel",
        f"  • [bold]{pct:.2f}%[/] de l'énergie imatrix",
        f"  • Concentration : top 10% cols = "
        f"[bold]{'%.0f' % (fam_info['concentration_top10'] * 100)}%[/] "
        f"de l'énergie  "
        f"{'[red]▮▮▮[/] très concentré → sensible' if fam_info['concentration_top10'] > 0.50 else '[green]▮▮▮[/] diffus → robuste' if fam_info['concentration_top10'] < 0.25 else '[yellow]▮▮▮[/] modéré'}",
    ]
    console.print()
    console.rule(f"[bold magenta]{idx}/{total_families}[/]", style="magenta")
    console.print(Panel(
        "\n".join(lines),
        border_style="magenta",
        padding=(1, 2),
    ))

    # Construit les choix avec estimation taille relative
    # Si source Q8_0, on ne peut pas monter au-dessus → filtrer F16
    available_quants = [
        q for q in _QUANT_CHOICES
        if not (source_top_type == "Q8_0" and q == "F16")
    ]
    choices = []
    for qt in available_quants:
        effective = base_quant if qt == "base" else qt
        est_bytes = _estimate_tensor_bytes(fam_info["total_params"], effective)
        delta = est_bytes - total_bytes
        label = (
            f"{qt:<8}  "
            f"{_format_size(est_bytes):>8}  "
            f"({_format_size_delta(delta)})"
        )
        if qt == "base":
            label += f"  (= {base_quant})"
        if qt == default_quant:
            label += "  * recommandé"
        choices.append(questionary.Choice(title=label, value=qt))

    console.print()
    return questionary.select(
        f"Quantization pour {fam} ?",
        choices=choices,
    ).ask()


def _recommend_quant_for_family(fam: str, inspect_mod, arch: str = "dense") -> str:
    """Heuristique de défaut par famille, extrait la reco du FAMILY_DOCS
    (contextualisée par architecture si disponible).
    Retourne le PREMIER type mentionné dans le texte de reco (pas le plus
    agressif). Ex: "Q8_0 (sûr) · F16 pour quali max" → Q8_0 (pas F16)."""
    doc = inspect_mod.family_doc(fam, arch=arch)
    reco_text = (doc.get("reco") or "").upper()
    if not reco_text:
        return "base"
    # Cherche le premier type qui apparaît dans le texte (par position)
    candidates = ["F16", "Q8_0", "Q6_K", "Q5_K_M", "Q4_K_M"]
    first_pos = len(reco_text)
    first_qt = "base"
    for qt in candidates:
        pos = reco_text.find(qt)
        if pos != -1 and pos < first_pos:
            first_pos = pos
            first_qt = qt
    return first_qt


def screen_custom_builder(
    model_base_name: str,
    model_f16_bytes: int,
    imatrix_tensors: list,
    gguf_header,
    inspect_mod,
    arch: str = "dense",
    source_top_type: str = "F16",
) -> dict | None:
    """Builder interactif pédagogique.
    Retourne un preset dict prêt pour run_quantize, ou None (abort/cancel)."""
    while True:
        result = _screen_custom_builder_once(
            model_base_name, model_f16_bytes,
            imatrix_tensors, gguf_header, inspect_mod, arch,
            source_top_type=source_top_type,
        )
        if result is _RESTART_SENTINEL:
            continue  # restart the builder
        return result  # preset dict or None (abort)


_RESTART_SENTINEL = object()


def _screen_custom_builder_once(
    model_base_name: str,
    model_f16_bytes: int,
    imatrix_tensors: list,
    gguf_header,
    inspect_mod,
    arch: str = "dense",
    source_top_type: str = "F16",
) -> dict | None:
    """Un seul passage du builder. Retourne preset, None (abort), ou relance
    screen_custom_builder via la boucle while du caller."""
    _ARCH_TAGS = {"moe": "[red]MoE[/]", "hybrid": "[yellow]Hybride[/]", "dense": "[cyan]Dense[/]"}
    arch_tag = _ARCH_TAGS.get(arch, f"[dim]{arch}[/]")
    _source_label = f"Source {source_top_type}" if source_top_type != "F16" else "F16"
    console.print()
    console.rule(
        f"[bold magenta]Custom Builder · {model_base_name} "
        f"· {arch_tag} "
        f"({_source_label}: {_format_size(model_f16_bytes)})[/]",
        style="magenta",
    )

    # 1. Base quant (plancher)
    base = questionary.select(
        "Base quant (plancher pour les familles non spécifiées) :",
        choices=[
            questionary.Choice(
                f"Q8_0    — plancher haut (quasi-F16, taille ~0.55×)",
                value="Q8_0",
            ),
            questionary.Choice(
                f"Q6_K *  — sweet spot (~0.42×)",
                value="Q6_K",
            ),
            questionary.Choice(
                f"Q5_K_M  — compact (~0.36×)",
                value="Q5_K_M",
            ),
            questionary.Choice(
                f"Q4_K_M  — agressif (~0.30×)",
                value="Q4_K_M",
            ),
        ],
    ).ask()
    if base is None:
        return None

    # 1b. Si source Q8 — proposer de préserver les tensors déjà F16
    # (le K_P/K_S mix place intelligemment du F16 sur les couches critiques)
    preserve_existing_f16: set[str] = set()
    if source_top_type == "Q8_0":
        n_f16 = sum(1 for t in gguf_header.tensors if t.type_name in ("F16", "BF16"))
        if n_f16 > 0:
            keep = questionary.confirm(
                f"Préserver les {n_f16} tensors déjà en F16 dans le source ? "
                "[recommandé — conserve le mix K_P existant]",
                default=True,
            ).ask()
            if keep is None:
                return None
            if keep:
                preserve_existing_f16 = {
                    t.name for t in gguf_header.tensors
                    if t.type_name in ("F16", "BF16")
                }

    # 2. Agrégation familles
    families_agg = _aggregate_families(imatrix_tensors, gguf_header)
    # Filtre familles triviales (moins de 0.05% d'énergie ET < 1 MB de taille)
    # — pas la peine de polluer le TUI avec
    relevant = [
        f for f in families_agg
        if f["pct_imatrix"] >= 0.01 or f["total_bytes"] >= 1 * 1024 * 1024
    ]

    # 3. Décision par famille (sauf token_embd/output couverts par preserve_embeddings,
    # norms et routeur MoE couverts par les pins F16 — on les saute pour éviter
    # que l'user choisisse un quant qui sera de toute façon écrasé par le pin).
    skip_families = {"token_embd", "output", "output_norm"}
    relevant_for_choice = [
        f for f in relevant
        if f["family"] not in skip_families
        and inspect_mod.family_category(f["family"]) != inspect_mod.CATEGORY_NORMS
        and inspect_mod.family_category(f["family"]) != inspect_mod.CATEGORY_ROUTER
    ]

    # Warn about GGUF families with no imatrix data (uncalibrated)
    _auto_categories = {
        inspect_mod.CATEGORY_NORMS, inspect_mod.CATEGORY_ROUTER,
        inspect_mod.CATEGORY_IO,
    }
    uncalibrated = [
        f for f in relevant
        if not f["has_imatrix"]
        and f["total_bytes"] >= 1 * 1024 * 1024
        and f["family"] not in skip_families
        and inspect_mod.family_category(f["family"]) not in _auto_categories
    ]
    if uncalibrated:
        console.print()
        console.print(
            "[bold yellow]⚠  Familles sans données imatrix "
            "(calibration ne couvre pas ces tensors) :[/]"
        )
        for uf in uncalibrated:
            console.print(
                f"   [yellow]• {uf['family']}[/]  "
                f"({uf['n_tensors']} tensors, "
                f"{_format_size(uf['total_bytes'])})"
            )
        console.print(
            "[dim]   → Ces familles seront quantisées au plancher (base) "
            "sans guidance imatrix.[/]"
        )

    console.print()
    console.print(
        f"[dim]→ {len(relevant_for_choice)} familles à configurer "
        f"(norms et I/O gérés automatiquement plus loin)[/]"
    )

    family_quants: dict[str, str] = {}
    for idx, fam_info in enumerate(relevant_for_choice, start=1):
        fam = fam_info["family"]
        doc = inspect_mod.family_doc(fam, arch=arch)
        default_quant = _recommend_quant_for_family(fam, inspect_mod, arch=arch)
        # Si la reco est plus grosse que la base, "base" n'a pas de sens
        # (base est plus agressif donc moins de bits)
        if default_quant == "base":
            default_quant = "Q8_0" if base != "Q8_0" else "base"

        prio_label, prio_color, _ = inspect_mod.family_priority(fam, arch)
        choice = _ask_family_quant(
            fam_info, doc, base, default_quant,
            total_current_bytes=model_f16_bytes,
            idx=idx, total_families=len(relevant_for_choice),
            priority=(prio_label, prio_color),
            source_top_type=source_top_type,
        )
        if choice is None:
            return None
        family_quants[fam] = choice

    # 4. Top-per-family bonus — d'abord un défaut global, puis ajustement
    _bonus_label = source_top_type if source_top_type != "F16" else "F16"
    console.print()
    console.rule(f"[bold]Bonus {_bonus_label} — tensors chauds[/]", style="dim")
    console.print(
        f"[dim]Le bonus {_bonus_label} force les top X% tensors les plus chauds (par énergie "
        f"imatrix) de chaque famille en {_bonus_label}, par-dessus le quant choisi. "
        f"Protège les outliers sans changer la base.[/]\n"
    )

    top_pct_str = questionary.select(
        f"Bonus {_bonus_label} par défaut (appliqué à toutes les familles) ?",
        choices=[
            questionary.Choice(f"0%  — aucun bonus {_bonus_label}", value="0"),
            questionary.Choice("5%  — top 5% par famille", value="5"),
            questionary.Choice("10% * — top 10% (équilibré)", value="10"),
            questionary.Choice("20% — top 20% (surgical classique)", value="20"),
            questionary.Choice("30% — top 30% (généreux)", value="30"),
        ],
    ).ask()
    if top_pct_str is None:
        return None
    default_bonus = int(top_pct_str) / 100.0

    # Proposer l'ajustement par famille
    # On ne montre que les familles éligibles (pas déjà F16, pas auto F16)
    eligible_fams = []
    for fi in families_agg:
        fam = fi["family"]
        fam_quant = family_quants.get(fam, "base")
        effective_quant = base if fam_quant == "base" else fam_quant
        if effective_quant == "F16":
            continue
        prio_label, _, prio_order = inspect_mod.family_priority(fam, arch)
        if prio_order < 0:  # auto F16 (norms, pins)
            continue
        eligible_fams.append(fi)

    bonus_per_family: dict[str, float] = {}
    if eligible_fams and default_bonus >= 0:
        adjust = questionary.confirm(
            f"Ajuster le bonus {_bonus_label} par famille ? (sinon applique le défaut partout)",
            default=False,
        ).ask()
        if adjust is None:
            return None

        if adjust:
            _BONUS_CHOICES = [
                questionary.Choice("0%  — aucun bonus", value="0"),
                questionary.Choice("5%", value="5"),
                questionary.Choice("10%", value="10"),
                questionary.Choice("15%", value="15"),
                questionary.Choice("20%", value="20"),
                questionary.Choice("30%", value="30"),
            ]
            for fi in eligible_fams:
                fam = fi["family"]
                fam_quant = family_quants.get(fam, "base")
                effective_quant = base if fam_quant == "base" else fam_quant
                n_tensors = fi["n_tensors"]
                prio_label, prio_color, _ = inspect_mod.family_priority(fam, arch)
                console.print(
                    f"\n  [bold]{fam}[/] ({effective_quant}, {n_tensors} tensors) "
                    f"{prio_color}[{prio_label}][/]"
                )
                # Mark default
                bonus_choices = []
                default_pct_str = str(int(default_bonus * 100))
                for c in _BONUS_CHOICES:
                    title = c.title
                    if c.value == default_pct_str:
                        title += " *"
                    bonus_choices.append(questionary.Choice(title, value=c.value))

                pct_str = questionary.select(
                    f"Bonus {_bonus_label} pour {fam} ?",
                    choices=bonus_choices,
                ).ask()
                if pct_str is None:
                    return None
                bonus_per_family[fam] = int(pct_str) / 100.0
        else:
            # Applique le défaut global à toutes les familles éligibles
            for fi in eligible_fams:
                bonus_per_family[fi["family"]] = default_bonus
    else:
        for fi in eligible_fams:
            bonus_per_family[fi["family"]] = default_bonus

    # Convertir en format attendu par emit_preset_custom
    top_per_family_f16: dict[str, float] = bonus_per_family

    # 5. Pins F16 toggle
    add_pins = questionary.confirm(
        "Ajouter les pins F16 auto (tous les norms + ffn_gate_inp) ? "
        "[fortement recommandé]",
        default=True,
    ).ask()
    if add_pins is None:
        return None

    # 6. Preset name
    default_name = f"Q_{model_base_name.split('-')[0].lower()}_custom"
    name = questionary.text(
        "Nom du preset :",
        default=default_name,
    ).ask()
    if not name:
        return None
    name = name.strip()

    # 7. Construction du preset via emit_preset_custom
    f16_pins = list(inspect_mod.F16_PIN_REGEXES) if add_pins else []
    preset, tier_counts = inspect_mod.emit_preset_custom(
        imatrix_tensors,
        name=name,
        base=base,
        family_quants=family_quants,
        top_per_family_f16=top_per_family_f16,
        f16_pins=f16_pins,
        bonus_type=source_top_type,
    )

    # 7b. Injecter les pins de préservation F16 existants (source Q8)
    # En TÊTE des overrides → priorité max (première règle qui matche gagne)
    if preserve_existing_f16:
        preserve_rules = [
            f"{re.escape(tname)}=F16"
            for tname in sorted(preserve_existing_f16)
        ]
        preset["tensor_overrides"] = preserve_rules + preset.get("tensor_overrides", [])
        n_preserved = len(preserve_existing_f16)
        tier_counts["F16 (préservé source)"] = n_preserved

    # 8. Preview taille estimée
    # Re-calcule depuis les tensor_overrides pour précision
    # Le suffix cible est =F16 ou =Q8_0 selon source_top_type
    _bonus_suffix = f"={source_top_type}"
    top_f16_names: set[str] = set()
    for rule in preset.get("tensor_overrides", []):
        if rule.endswith(_bonus_suffix) and rule.startswith("blk\\."):
            # Règle exacte (tensor individuel échappé par re.escape)
            rname = rule[:-len(_bonus_suffix)]
            plain_name = rname.replace("\\.", ".").replace("\\", "")
            top_f16_names.add(plain_name)
    # Pins = regex patterns larges (tout sauf les tensor names individuels).
    f16_pin_compiled = [
        re.compile(r[:-len(_bonus_suffix)])
        for r in preset.get("tensor_overrides", [])
        if r.endswith(_bonus_suffix) and not r.startswith("blk\\.")
    ]

    _pres_emb = preset.get("preserve_embeddings", True)
    est_target, _ = _estimate_preset_size(
        gguf_header,
        preset.get("family_quants", {}),
        top_f16_names,
        f16_pin_compiled,
        base,
        preserve_embeddings=_pres_emb,
        top_type=source_top_type,
        preserved_f16_names=preserve_existing_f16 or None,
    )
    ratio = est_target / model_f16_bytes if model_f16_bytes > 0 else 0

    # Tier recap enrichi : priorité de bump, énergie imatrix
    fam_agg_map = {f["family"]: f for f in families_agg}

    # Calcul des tailles par tier depuis les tensors GGUF (même logique que
    # _estimate_preset_size) — garantit que les lignes somment au total.
    tier_sizes = _compute_tier_sizes(
        gguf_header,
        preset.get("family_quants", {}),
        top_f16_names,
        f16_pin_compiled,
        base,
        tier_counts,
        preserve_embeddings=_pres_emb,
        top_type=source_top_type,
        preserved_f16_names=preserve_existing_f16 or None,
    )

    tier_table = Table(title=f"Preset [bold]{name}[/]",
                       header_style="bold green", box=None, padding=(0, 2))
    tier_table.add_column("Tier / Famille")
    tier_table.add_column("Tensors", justify="right")
    tier_table.add_column("Priorité")
    tier_table.add_column("Énergie", justify="right")
    tier_table.add_column("Taille", justify="right")

    # Extraire le nom de famille et le type de quant depuis la clé
    # Format : "Q8_0 (famille ffn_gate_exps)" ou "F16 bonus 10% (famille X)"
    _tier_rx = re.compile(r"^(\S+)(?:\s+bonus\s+\d+%)?\s+\(famille (\w+)\)")
    for tier_label, count in tier_counts.items():
        m = _tier_rx.search(tier_label)
        if m:
            fam = m.group(2)
            sens_label, sens_color, _ = inspect_mod.family_priority(fam, arch)
            agg = fam_agg_map.get(fam)
            pct = f"{agg['pct_imatrix']:.1f}%" if agg else "—"
            size = _format_size(tier_sizes[tier_label]) if tier_label in tier_sizes else "—"
            tier_table.add_row(
                str(tier_label), str(count),
                f"{sens_color}{sens_label}[/]",
                pct, size,
            )
        else:
            # pins auto, base, preserved, etc.
            if "préservé" in tier_label.lower():
                prio_col = "[bold cyan]source K_P[/]"
            elif "pin" in tier_label.lower():
                prio_col = "[dim]auto F16[/]"
            else:
                prio_col = "[dim]—[/]"
            size = _format_size(tier_sizes[tier_label]) if tier_label in tier_sizes else "—"
            tier_table.add_row(
                str(tier_label), str(count),
                prio_col, "—", size,
            )
    console.print()
    console.print(tier_table)

    # Résumé final
    console.print()
    summary = [
        f"[bold]base[/]          {base}",
        f"[bold]famille choix[/] {len(family_quants)} spécifiées  "
        f"([dim]{', '.join(f'{k}={v}' for k,v in list(family_quants.items())[:4])}"
        f"{'…' if len(family_quants) > 4 else ''}[/])",
        f"[bold]bonus {_bonus_label}[/]     {len(top_f16_names)} tensors "
        f"({len([v for v in top_per_family_f16.values() if v > 0])} familles avec bonus)",
        f"[bold]pins {_bonus_label}[/]      {'oui' if add_pins else 'non'}",
        "",
        f"[bold]Taille estimée[/]  [bold cyan]{_format_size(est_target)}[/] "
        f"({ratio:.2f}× F16)",
        f"[bold]Économie[/]        {_format_size(model_f16_bytes - est_target)} "
        f"vs F16 source",
    ]
    console.print(Panel(
        "\n".join(summary),
        title="[bold green]Preview[/]",
        border_style="green",
        padding=(1, 2),
    ))

    # 9. Confirm
    console.print()
    action = questionary.select(
        "Action :",
        choices=[
            questionary.Choice("✓ Accepter le preset *", value="go"),
            questionary.Choice("↻ Tout recommencer", value="restart"),
            questionary.Choice("✗ Annuler", value="cancel"),
        ],
    ).ask()
    if action is None or action == "cancel":
        return None
    if action == "restart":
        return _RESTART_SENTINEL

    return preset


def _load_inspect_module():
    """Charge inspect-imatrix.py (hyphen-named) via importlib pour pouvoir
    appeler parse_imatrix / emit_preset / append_preset_to_config directement
    au lieu de passer par un subprocess.

    Note : on enregistre le module dans sys.modules AVANT exec_module. Sans
    ça, @dataclass échoue sur Python 3.14+ (dataclasses résout cls.__module__
    via sys.modules pour vérifier les types, et NoneType crashe)."""
    import importlib.util
    path = SCRIPT_DIR / "inspect-imatrix.py"
    if not path.exists():
        return None
    spec = importlib.util.spec_from_file_location("inspect_imatrix", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["inspect_imatrix"] = mod
    spec.loader.exec_module(mod)
    return mod


def run_analyze_mode(cfg: dict, models_path: Path, abort_fn) -> None:
    """Mode ANALYZE : inspecte un GGUF existant (quantifié ou non) et affiche
    la composition par famille — quant type, bpw, taille, % du modèle.
    Optionnel : compare deux GGUF côte à côte."""
    gguf_mod = _load_gguf_stats()
    if gguf_mod is None:
        console.print(f"[red]✗[/] Script manquant : {SCRIPT_DIR / 'gguf_stats.py'}")
        sys.exit(1)

    inspect_mod = _load_inspect_module()

    # ── Sélection du premier GGUF ──────────────────────────────────────────
    all_gguf = scan_all_gguf(models_path)
    if not all_gguf:
        console.print(f"[red]✗[/] Aucun .gguf trouvé dans {models_path}")
        return

    console.print()
    console.rule("[bold magenta]Analyze GGUF[/]", style="magenta")

    choices_1 = [
        questionary.Choice(
            f"{e['display']}  [{e['quant_tag']}]  ({fmt_size(e['size_bytes'])})",
            value=e,
        )
        for e in all_gguf
    ]
    choices_1.append(questionary.Choice("← Retour", value="back"))

    selected = questionary.select(
        "GGUF à analyser :",
        choices=choices_1,
    ).ask()
    if selected is None or selected == "back":
        return

    # ── Parse header ───────────────────────────────────────────────────────
    try:
        hdr = gguf_mod.read_gguf_header_sharded(selected["path"])
    except Exception as exc:
        console.print(f"[red]✗ Parse GGUF échoué : {exc}[/]")
        return

    # Architecture detection
    arch = "dense"
    if inspect_mod:
        # Build fake TensorStat list from GGUF names for arch detection
        @dataclass
        class _FakeTensor:
            name: str
        fake_tensors = [_FakeTensor(name=t.name) for t in hdr.tensors]
        arch = inspect_mod.detect_architecture(fake_tensors)

    _ARCH_RICH = {"moe": "[red]MoE[/]", "hybrid": "[yellow]Hybride MoE+SSM[/]", "dense": "[cyan]Dense[/]"}
    arch_label = _ARCH_RICH.get(arch, f"[dim]{arch}[/]")

    # ── Agrégation par famille ─────────────────────────────────────────────
    fam_groups = gguf_mod.group_by_family(hdr)
    total_bytes = hdr.total_bytes or 1
    total_params = hdr.total_params

    rows: list[tuple] = []
    for fam, tensors in fam_groups.items():
        n = len(tensors)
        params = sum(t.n_params for t in tensors)
        fam_bytes = sum(t.bytes_current for t in tensors)
        pct = (fam_bytes / total_bytes) * 100
        # Type info — distribution complète si mixte
        types: dict[str, int] = {}
        for t in tensors:
            types[t.type_name] = types.get(t.type_name, 0) + 1
        if len(types) == 1:
            type_display = list(types.keys())[0]
        else:
            # Distribution complète triée par count décroissant
            parts = sorted(types.items(), key=lambda x: -x[1])
            type_display = " ".join(f"{tp}×{cnt}" for tp, cnt in parts)
        # bpw pondéré réel (pas juste le type majoritaire)
        total_weighted = sum(
            t.bits_per_weight * t.n_params for t in tensors
        )
        bpw = total_weighted / params if params > 0 else 0.0
        rows.append((fam, n, params, fam_bytes, pct, type_display, bpw))

    rows.sort(key=lambda r: r[3], reverse=True)

    # ── Affichage ──────────────────────────────────────────────────────────
    console.print()
    console.print(Panel.fit(
        f"[bold]{selected['display']}[/]  {arch_label}\n"
        f"[dim]GGUF v{hdr.version} · {len(hdr.tensors)} tensors · "
        f"{total_params / 1e9:.2f}B params · "
        f"{total_bytes / (1024**3):.2f} GB[/]",
        border_style="magenta",
    ))
    console.print()

    table = Table(
        title="Composition par famille",
        header_style="bold cyan", box=None, padding=(0, 2),
    )
    table.add_column("Famille", min_width=20)
    table.add_column("N", justify="right")
    table.add_column("Params", justify="right")
    table.add_column("Taille", justify="right")
    table.add_column("% modèle", justify="right")
    table.add_column("Type", justify="center")
    table.add_column("bpw", justify="right")

    # Priority labels if inspect_mod available
    if inspect_mod:
        table.add_column("Priorité", justify="center")

    for fam, n, params, fam_bytes, pct, type_display, bpw in rows:
        # Color by type
        if "F16" in type_display or "BF16" in type_display:
            type_color = "bold magenta"
        elif "Q8" in type_display:
            type_color = "bold green"
        elif "Q6" in type_display:
            type_color = "cyan"
        elif "Q5" in type_display:
            type_color = "yellow"
        elif "Q4" in type_display or "IQ" in type_display:
            type_color = "red"
        else:
            type_color = "white"

        row_data = [
            fam,
            str(n),
            f"{params / 1e6:.1f}M",
            _format_size(fam_bytes),
            f"{pct:.1f}%",
            f"[{type_color}]{type_display}[/]",
            f"{bpw:.1f}",
        ]
        if inspect_mod:
            prio_label, prio_color, _ = inspect_mod.family_priority(fam, arch)
            row_data.append(f"{prio_color}{prio_label}[/]")

        table.add_row(*row_data)

    console.print(table)

    # ── Diagnostics automatiques ──────────────────────────────────────────
    has_token_embd = "token_embd" in fam_groups
    has_output = "output" in fam_groups
    diags: list[str] = []

    # Tied embeddings detection
    if has_token_embd and not has_output:
        embd_type = max(
            ((t.type_name, 1) for t in fam_groups["token_embd"]),
            key=lambda x: x[1],
        )[0]
        diags.append(
            f"[dim]ℹ[/]  [bold]Tied embeddings[/] — pas de tensor `output` séparé, "
            f"la projection vocab réutilise `token_embd` ({embd_type})"
        )
    elif has_token_embd and has_output:
        embd_types = {t.type_name for t in fam_groups["token_embd"]}
        out_types = {t.type_name for t in fam_groups["output"]}
        embd_t = next(iter(embd_types))
        out_t = next(iter(out_types))
        if embd_t != out_t:
            diags.append(
                f"[yellow]⚠[/]  token_embd ({embd_t}) et output ({out_t}) "
                f"ont des types différents — vérifier preserve_embeddings"
            )

    # Norms not in F16/F32
    for fam in fam_groups:
        cat = "norms"
        if "_norm" in fam or fam == "output_norm":
            fam_types = {t.type_name for t in fam_groups[fam]}
            bad_types = fam_types - {"F16", "F32", "BF16"}
            if bad_types:
                diags.append(
                    f"[red]⚠[/]  Norm [bold]{fam}[/] quantisée en "
                    f"{', '.join(bad_types)} — devrait être F16 ou F32"
                )

    # Router MoE not in F16/F32
    for router_fam in ("ffn_gate_inp", "ffn_gate_inp_shexp"):
        if router_fam in fam_groups:
            router_types = {t.type_name for t in fam_groups[router_fam]}
            bad = router_types - {"F16", "F32", "BF16"}
            if bad:
                diags.append(
                    f"[red]⚠[/]  Routeur [bold]{router_fam}[/] en "
                    f"{', '.join(bad)} — devrait être F16 (taille négligeable, impact max)"
                )

    # SSM critical params not in F16/F32
    for ssm_fam in ("ssm_alpha", "ssm_beta", "ssm_conv1d", "ssm_dt"):
        if ssm_fam in fam_groups:
            ssm_types = {t.type_name for t in fam_groups[ssm_fam]}
            bad = ssm_types - {"F16", "F32", "BF16"}
            if bad:
                diags.append(
                    f"[yellow]⚠[/]  SSM [bold]{ssm_fam}[/] en "
                    f"{', '.join(bad)} — minuscule, devrait être F16"
                )

    # Architecture info for hybrid
    if arch == "hybrid":
        diags.append(
            f"[dim]ℹ[/]  [bold]Architecture hybride MoE+SSM[/] — "
            f"layers alternent attention+SSM et attention pure"
        )

    if diags:
        console.print()
        for d in diags:
            console.print(f"  {d}")

    # BPW moyen pondéré
    avg_bpw = sum(
        t.bits_per_weight * t.n_params for t in hdr.tensors
    ) / (total_params or 1)
    console.print(
        f"\n[bold]BPW moyen pondéré :[/] {avg_bpw:.2f}  "
        f"[dim](ratio vs F16 : {avg_bpw / 16:.2f}×)[/]"
    )

    # ── Comparaison optionnelle ────────────────────────────────────────────
    console.print()
    compare = questionary.confirm(
        "Comparer avec un autre GGUF ?",
        default=False,
    ).ask()
    if not compare:
        return

    choices_2 = [
        questionary.Choice(
            f"{e['display']}  [{e['quant_tag']}]  ({fmt_size(e['size_bytes'])})",
            value=e,
        )
        for e in all_gguf
        if e["path"] != selected["path"]
    ]
    if not choices_2:
        console.print("[yellow]Pas d'autre GGUF disponible pour comparaison.[/]")
        return

    choices_2.append(questionary.Choice("← Annuler", value="back"))
    selected_2 = questionary.select(
        "Deuxième GGUF :",
        choices=choices_2,
    ).ask()
    if selected_2 is None or selected_2 == "back":
        return

    try:
        hdr2 = gguf_mod.read_gguf_header_sharded(selected_2["path"])
    except Exception as exc:
        console.print(f"[red]✗ Parse GGUF échoué : {exc}[/]")
        return

    fam_groups_2 = gguf_mod.group_by_family(hdr2)
    total_bytes_2 = hdr2.total_bytes or 1

    # ── Table comparative ──────────────────────────────────────────────────
    all_families = sorted(
        set(fam_groups.keys()) | set(fam_groups_2.keys()),
        key=lambda f: sum(t.bytes_current for t in fam_groups.get(f, [])),
        reverse=True,
    )

    console.print()
    cmp_table = Table(
        title=(
            f"Comparaison : [bold]{selected['quant_tag']}[/] vs "
            f"[bold]{selected_2['quant_tag']}[/]"
        ),
        header_style="bold cyan", box=None, padding=(0, 2),
    )
    cmp_table.add_column("Famille", min_width=18)
    cmp_table.add_column(f"Type ({selected['quant_tag']})", justify="center")
    cmp_table.add_column(f"bpw", justify="right")
    cmp_table.add_column(f"Taille", justify="right")
    cmp_table.add_column(f"Type ({selected_2['quant_tag']})", justify="center")
    cmp_table.add_column(f"bpw", justify="right")
    cmp_table.add_column(f"Taille", justify="right")
    cmp_table.add_column("Delta", justify="right")

    def _type_info(ts):
        if not ts:
            return "-", 0.0, 0
        types: dict[str, int] = {}
        for t in ts:
            types[t.type_name] = types.get(t.type_name, 0) + 1
        if len(types) == 1:
            display = list(types.keys())[0]
        else:
            parts = sorted(types.items(), key=lambda x: -x[1])
            display = " ".join(f"{tp}×{cnt}" for tp, cnt in parts)
        total_params = sum(t.n_params for t in ts)
        bpw = (
            sum(t.bits_per_weight * t.n_params for t in ts) / total_params
            if total_params > 0 else 0.0
        )
        size = sum(t.bytes_current for t in ts)
        return display, bpw, size

    for fam in all_families:
        ts1 = fam_groups.get(fam, [])
        ts2 = fam_groups_2.get(fam, [])

        type1, bpw1, size1 = _type_info(ts1)
        type2, bpw2, size2 = _type_info(ts2)
        delta = size2 - size1

        # Highlight differences
        delta_str = _format_size_delta(delta) if (ts1 and ts2) else "-"
        if type1 != type2 and ts1 and ts2:
            delta_color = "yellow"
        else:
            delta_color = "dim"

        cmp_table.add_row(
            fam,
            type1,
            f"{bpw1:.1f}" if bpw1 > 0 else "-",
            _format_size(size1) if ts1 else "-",
            type2,
            f"{bpw2:.1f}" if bpw2 > 0 else "-",
            _format_size(size2) if ts2 else "-",
            f"[{delta_color}]{delta_str}[/]",
        )

    console.print(cmp_table)

    # Totaux
    avg_bpw_1 = sum(
        t.bits_per_weight * t.n_params for t in hdr.tensors
    ) / (total_params or 1)
    total_params_2 = hdr2.total_params or 1
    avg_bpw_2 = sum(
        t.bits_per_weight * t.n_params for t in hdr2.tensors
    ) / total_params_2

    console.print()
    console.print(
        f"  [bold]{selected['quant_tag']}[/]  "
        f"{total_bytes / (1024**3):.2f} GB  ·  bpw moyen {avg_bpw_1:.2f}"
    )
    console.print(
        f"  [bold]{selected_2['quant_tag']}[/]  "
        f"{total_bytes_2 / (1024**3):.2f} GB  ·  bpw moyen {avg_bpw_2:.2f}"
    )
    size_diff = total_bytes_2 - total_bytes
    console.print(
        f"  [bold]Delta total :[/]  {_format_size_delta(size_diff)}"
    )


def run_inspect_mode(cfg: dict, models_path: Path, imatrix_dir: Path, abort_fn) -> None:
    """Mode INSPECT : analyse imatrix existante → propose preset → optionnel
    append config → optionnel quantize direct. Le mode "auto-tune" complet en
    un seul passage."""
    inspect_mod = _load_inspect_module()
    if inspect_mod is None:
        console.print(f"[red]✗[/] Script manquant : {SCRIPT_DIR / 'inspect-imatrix.py'}")
        sys.exit(1)
    inspector_script = SCRIPT_DIR / "inspect-imatrix.py"

    # Sélection modèle (on réutilise l'écran existant pour trouver l'imatrix)
    model = screen_select_model(models_path)
    if model is None:
        abort_fn()

    rel_hash = hashlib.sha1(
        str(model.first_shard.relative_to(models_path)).encode("utf-8")
    ).hexdigest()[:8]
    imatrix_path = imatrix_dir / f"{model.base_name}-{rel_hash}.imatrix"

    if not imatrix_path.exists():
        console.print(
            f"\n[red]✗[/] Pas d'imatrix pour ce modèle : {imatrix_path}\n"
            f"[dim]Lance d'abord brain-quant → Build imatrix only.[/]"
        )
        sys.exit(1)

    console.print(f"\n[dim]imatrix : {imatrix_path}  "
                  f"({fmt_size(imatrix_path.stat().st_size)})[/]\n")

    # 1. Affichage analyse (tableaux détaillé + groupé) — via subprocess pour
    # ne pas dupliquer le code d'affichage rich.
    subprocess.run(
        [sys.executable, str(inspector_script), str(imatrix_path), "--top", "40"],
        check=False,
    )
    console.print()
    subprocess.run(
        [sys.executable, str(inspector_script), str(imatrix_path),
         "--no-detail", "--group", r"(?:^|\.)([^.]+)\.weight$"],
        check=False,
    )

    # 2. Parse imatrix + détection architecture (avant le choix de profile
    #    pour contextualiser les recommandations)
    try:
        tensors, _, _ = inspect_mod.parse_imatrix(imatrix_path)
    except Exception as exc:
        console.print(f"[red]✗ Parse imatrix échoué : {exc}[/]")
        return

    detected_arch = inspect_mod.detect_architecture(tensors)
    _ARCH_LABELS = {
        inspect_mod.ARCH_DENSE: "Dense",
        inspect_mod.ARCH_MOE: "MoE (experts)",
        inspect_mod.ARCH_HYBRID: "Hybride MoE+SSM (Mamba)",
    }
    arch_label = _ARCH_LABELS.get(detected_arch, detected_arch)
    console.print()
    console.print(
        f"[bold]Architecture détectée :[/] [cyan]{arch_label}[/]"
    )
    arch_choices = [
        (inspect_mod.ARCH_DENSE,
         "Dense    — FFN monolithiques (Llama, Mistral, Phi, Qwen…)"),
        (inspect_mod.ARCH_MOE,
         "MoE      — experts routés (Gemma-4, Mixtral, DeepSeek-V2…)"),
        (inspect_mod.ARCH_HYBRID,
         "Hybride  — MoE + SSM/Mamba (Qwen3.6, Jamba…)"),
    ]
    arch_choice = questionary.select(
        "Confirmer l'architecture du modèle :",
        choices=[
            questionary.Choice(
                f"{label} *" if val == detected_arch else label,
                value=val,
            )
            for val, label in arch_choices
        ],
    ).ask()
    if arch_choice is None:
        abort_fn()
    arch = arch_choice

    # 3. Options d'émission (profile, name…) — contextualisé par l'architecture
    console.print()
    r = screen_inspect_options(arch)
    if r is None:
        abort_fn()
    emit, profile, name, append = r
    if not emit:
        return

    # 4. Émission du preset
    try:
        if profile == "custom":
            # Builder interactif — nécessite le header GGUF pour les tailles
            gguf_mod = _load_gguf_stats()
            if gguf_mod is None:
                console.print(
                    f"[red]✗[/] Script manquant : {SCRIPT_DIR / 'gguf_stats.py'}"
                )
                return
            try:
                gguf_header = gguf_mod.read_gguf_header_sharded(model.first_shard)
            except Exception as exc:
                console.print(f"[red]✗ Parse GGUF header échoué : {exc}[/]")
                return

            preset = screen_custom_builder(
                model_base_name=model.base_name,
                model_f16_bytes=model.total_bytes,
                imatrix_tensors=tensors,
                gguf_header=gguf_header,
                inspect_mod=inspect_mod,
                arch=arch,
                source_top_type=model.top_type,
            )
            if preset is None:
                console.print("[yellow]Builder annulé.[/]")
                return
            name = preset["name"]
            # Le builder n'a pas demandé l'append ; on le demande maintenant.
            append = questionary.confirm(
                "Ajouter ce preset au config.yaml (backup .bak créé) ?",
                default=True,
            ).ask()
            if append is None:
                append = False
            tier_counts = {}  # déjà affiché dans le builder
        else:
            preset, tier_counts = inspect_mod.emit_preset(
                tensors, profile=profile, name=name,
            )
    except Exception as exc:
        console.print(f"[red]✗ Émission preset échouée : {exc}[/]")
        import traceback
        traceback.print_exc()
        return

    # Affichage résumé (skippé pour custom — déjà fait dans le builder)
    if profile != "custom":
        tier_table = Table(title=f"Preset [bold]{preset['name']}[/]",
                           header_style="bold green", box=None, padding=(0, 2))
        tier_table.add_column("Tier")
        tier_table.add_column("Tensors", justify="right")
        for t, c in tier_counts.items():
            tier_table.add_row(str(t), str(c))
        console.print()
        console.print(tier_table)

        yaml_block = yaml.safe_dump([preset], allow_unicode=True,
                                    sort_keys=False, width=120)
        console.print()
        console.print(Panel(
            yaml_block.rstrip(),
            title=f"[bold]Preset YAML · {preset['name']}[/]",
            border_style="green",
            padding=(1, 2),
        ))

    # 4. Append config.yaml si demandé
    if append:
        try:
            inspect_mod.append_preset_to_config(preset, CONFIG_PATH)
        except Exception as exc:
            console.print(f"[yellow]⚠ Append config échoué : {exc}[/]")

    # 5. Offre quantize immédiat avec ce preset
    console.print()
    quantize_now = questionary.confirm(
        f"Quantize maintenant avec {preset['name']} ?",
        default=True,
    ).ask()
    if quantize_now is None or not quantize_now:
        console.print(
            "[dim]Tu peux quantizer plus tard : brain-quant → Quantize → "
            f"coche [bold]{preset['name']}[/] (imatrix déjà cachée, pas de recalcul).[/]"
        )
        return

    # Toolbox sélection (pas de calib à redemander : imatrix déjà là)
    default_toolbox = cfg.get("toolbox", "llama-vulkan-radv")
    _tb_mark2 = lambda v: " *" if v == default_toolbox else ""
    toolbox = questionary.select(
        "Toolbox :",
        choices=[
            questionary.Choice(f"llama-vulkan-radv{_tb_mark2('llama-vulkan-radv')}   — stable, default prod", value="llama-vulkan-radv"),
            questionary.Choice(f"llama-rocm-7.2{_tb_mark2('llama-rocm-7.2')}      — perf max, moins stable", value="llama-rocm-7.2"),
        ],
    ).ask()
    if toolbox is None:
        abort_fn()

    if not toolbox_exists(toolbox):
        console.print(f"[red]✗[/] Toolbox {toolbox} introuvable.")
        sys.exit(1)
    if not toolbox_has_binary(toolbox, "llama-quantize"):
        console.print(f"[red]✗[/] llama-quantize absent de {toolbox}.")
        sys.exit(1)

    # Output path versionné
    output_dir = models_path / cfg["output_subdir"]
    out = next_versioned_gguf(
        output_dir / f"{model.base_name}-brain-{preset['name']}.gguf"
    )

    # Confirm mini + go
    console.print()
    console.rule(f"[bold magenta]Quantize → {out.name}[/]", style="magenta")
    console.print(f"  [dim]model   [/] {model.first_shard}")
    console.print(f"  [dim]imatrix [/] {imatrix_path}")
    console.print(f"  [dim]preset  [/] {preset['name']} · base {preset.get('base')}")
    console.print(f"  [dim]output  [/] {out}")
    console.print(f"  [dim]toolbox [/] {toolbox}")
    console.print()

    go = questionary.confirm("On lance ?", default=True).ask()
    if not go:
        return

    # Pré-flight write check
    ok, reason = check_writable(output_dir)
    if not ok:
        console.print(f"[red]✗ output_dir non accessible : {reason}[/]")
        sys.exit(1)

    log_dir = Path.home() / ".cache" / "brain-quant"
    log_dir.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    log_path = log_dir / f"run-{ts}-{model.base_name}-{preset['name']}.log"
    console.print(f"[dim]Log : {log_path}[/]\n")

    # Injecter source_top_type pour build_quantize_overrides
    preset.setdefault("source_top_type", model.top_type)

    with open(log_path, "w", encoding="utf-8") as log_stream:
        log_stream.write(f"brain-quant inspect→quantize @ {ts}\n")
        log_stream.write(f"model: {model.first_shard}\n")
        log_stream.write(f"preset: {preset}\n\n")
        try:
            elapsed = run_quantize(
                toolbox=toolbox,
                f16_path=model.first_shard,
                imatrix_path=imatrix_path,
                out_path=out,
                quant_cfg=preset,
                log_stream=log_stream,
            )
            size = out.stat().st_size if out.exists() else 0
            console.print(
                f"[green]✓[/] {preset['name']:<20} "
                f"{fmt_size(size):>10}  en {fmt_duration(elapsed)}"
            )
            console.print(f"[bold]Output[/]        {out}")

            # Post-quantize validation
            vw = _validate_output_gguf(model.first_shard, out)
            if vw:
                for w in vw:
                    console.print(f"[bold yellow]⚠  {w}[/]")
            else:
                console.print("[green]✓  Validation GGUF OK[/]")
        except Exception as exc:
            console.print(f"[red]✗ Quantize échec : {exc}[/]")
            console.print(f"[dim]Détails : {log_path}[/]")
            sys.exit(1)


def run_quality_eval_step(
    results: list[tuple[str, Path, float, Optional[str]]],
    toolbox: str,
    log_dir: Path,
    ts: str,
) -> list[dict]:
    """Optionnellement lance le quality eval sur les GGUF produits avec succès.

    Retourne la liste des rapports JSON (un par quant testé). Liste vide si
    skip ou aucun GGUF utilisable.
    """
    # Filtre les quants qui ont réussi (fichier existant + pas d'erreur)
    quants_to_eval = [
        (name, out, dur) for name, out, dur, err in results
        if err is None and out.exists()
    ]
    if not quants_to_eval:
        return []

    # Localise la suite par défaut
    default_suite = SCRIPT_DIR / "calibration" / "quality_suite.jsonl"
    if not default_suite.exists():
        console.print(
            f"[dim]Quality suite introuvable ({default_suite}), eval skipée.[/]"
        )
        return []

    # Demande confirmation
    console.print()
    console.rule("[bold cyan]Quality eval[/]", style="cyan")
    n_samples = sum(
        1 for line in default_suite.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    )
    estimated_per_quant_sec = n_samples * 8  # ~8s/sample (PP+gen sur petit prompt)
    estimated_total_min = (estimated_per_quant_sec * len(quants_to_eval)) / 60
    console.print(
        f"[dim]Suite : {default_suite.name} ({n_samples} samples)[/]\n"
        f"[dim]Cible : {len(quants_to_eval)} quant(s) — "
        f"~{estimated_total_min:.0f} min estimé total[/]\n"
    )

    try:
        run_eval = questionary.confirm(
            "Lancer la quality eval sur les GGUF produits ?",
            default=True,
            qmark="?",
        ).ask()
    except KeyboardInterrupt:
        run_eval = False

    if not run_eval:
        console.print("[dim]Quality eval skipée.[/]")
        return []

    # Lazy import — évite le coût si on skip
    try:
        # Module name = "quality_eval" (sibling)
        sys.path.insert(0, str(SCRIPT_DIR))
        import quality_eval as qeval  # type: ignore
    except ImportError as exc:
        console.print(f"[yellow]⚠  quality_eval module introuvable : {exc}[/]")
        return []

    # La suite est sous SCRIPT_DIR (= /opt/...) qui est hors HOME pour podman.
    # ensure_toolbox_accessible() gère ce cas (copie sous HOME si nécessaire).
    suite_for_toolbox = ensure_toolbox_accessible(
        default_suite, log_dir / "quality-suites"
    )

    reports: list[dict] = []
    for name, out, _ in quants_to_eval:
        # Le GGUF est déjà sous models_path qui est sous HOME, donc accessible.
        report_path = log_dir / f"quality-{ts}-{out.stem}.json"
        console.print(f"\n[bold]→[/] Eval [cyan]{name}[/] ({out.name})")

        opts = qeval.QualityEvalOptions(
            gguf=out,
            suite=suite_for_toolbox,
            output=report_path,
            toolbox=toolbox,
            quant_name=name,
            ctx_size=4096,
            gpu_layers="999",
            temperature=0.0,
            timeout_seconds=300.0,
            flash_attn=True,
        )

        # Progress callback : affiche [i/N] ✓/✗ <id> en live
        last_passed = [0]
        def _cb(i: int, n: int, sid: str, passed: bool):
            mark = "[green]✓[/]" if passed else "[red]✗[/]"
            last_passed[0] += int(passed)
            console.print(f"  [{i:>2}/{n}] {mark} {sid}")

        try:
            report = qeval.run_quality_eval(opts, progress_callback=_cb)
        except Exception as exc:
            console.print(f"  [red]✗ eval échouée : {exc}[/]")
            continue

        s = report["summary"]
        pr = s.get("pass_rate", 0.0)
        color = "green" if pr >= 0.9 else ("yellow" if pr >= 0.7 else "red")
        console.print(
            f"  → [{color}]{s['passed']}/{s['total']} "
            f"({pr*100:.1f}%)[/] en {report['duration_seconds']:.0f}s "
            f"[dim]→ {report_path.name}[/]"
        )
        reports.append(report)

    # Table comparative si on a >= 2 quants
    if len(reports) >= 2:
        console.print()
        console.rule("[bold cyan]Comparatif quality[/]", style="cyan")
        cmp = qeval.compare_reports(reports)
        cat_table = Table(
            show_header=True, header_style="bold cyan",
            box=None, padding=(0, 2),
        )
        cat_table.add_column("Catégorie")
        for qname in cmp["overall"]:
            cat_table.add_column(qname, justify="right")

        # Ligne par catégorie
        for cat in sorted(cmp["by_category"]):
            row = [cat]
            for qname in cmp["overall"]:
                pr = cmp["by_category"][cat].get(qname, 0.0)
                color = "green" if pr >= 0.9 else ("yellow" if pr >= 0.7 else "red")
                row.append(f"[{color}]{pr*100:.0f}%[/]")
            cat_table.add_row(*row)

        # Ligne overall en gras
        overall_row = ["[bold]Overall[/]"]
        for qname, pr in cmp["overall"].items():
            color = "green" if pr >= 0.9 else ("yellow" if pr >= 0.7 else "red")
            overall_row.append(f"[bold {color}]{pr*100:.1f}%[/]")
        cat_table.add_row(*overall_row)
        console.print(cat_table)

    return reports


def main():
    cfg = load_config()
    models_path = resolve_path(cfg["models_path"])
    calib_dir = resolve_path(cfg["calibration_dir"])
    output_dir = models_path / cfg["output_subdir"]
    imatrix_dir = resolve_path(cfg.get("imatrix_dir", "~/mercury/matrix"))
    default_toolbox = cfg.get("toolbox", "llama-vulkan-radv")

    console.print()
    console.print(Panel.fit(
        "[bold magenta]brain-quant[/] · pipeline quantization custom via toolbox",
        border_style="magenta",
    ))
    console.print(f"  [dim]models_path  [/] {models_path}")
    console.print(f"  [dim]output_dir   [/] {output_dir}")
    console.print(f"  [dim]calibration  [/] {calib_dir}")
    console.print(f"  [dim]imatrix_dir  [/] {imatrix_dir}")
    console.print()

    # Pré-vérif toolbox (fail fast)
    if not toolbox_exists(default_toolbox):
        console.print(f"[red]✗[/] Toolbox [yellow]{default_toolbox}[/] introuvable.")
        console.print(f"  [dim]Crée-la via amd-strix-halo-toolboxes (voir brain tools/).[/]")
        sys.exit(1)

    imatrix_dir.mkdir(parents=True, exist_ok=True)

    def _abort():
        console.print("\n[yellow]Annulé.[/]")
        sys.exit(0)

    # ── Mode ────────────────────────────────────────────────────────────────
    mode = screen_select_mode()
    if mode is None:
        _abort()

    # Mode FAQ : affiche la doc, puis revient au menu
    if mode == MODE_FAQ:
        screen_faq()
        return main()

    # Mode ANALYZE : inspecte un GGUF existant (quants par famille, comparaison)
    if mode == MODE_ANALYZE:
        run_analyze_mode(cfg, models_path, _abort)
        return

    # Mode INSPECT : court-circuite la state machine, délègue à inspect-imatrix.py
    if mode == MODE_INSPECT:
        run_inspect_mode(cfg, models_path, imatrix_dir, _abort)
        return

    # ── Navigation TUI en machine à états ───────────────────────────────────
    # Chaque screen peut retourner BACK pour revenir au précédent, None pour
    # abort (Ctrl+C), ou sa valeur normale. État persistant entre écrans,
    # rien ne se perd quand on remonte.
    state: dict = {}
    checked_toolboxes: set[str] = set()  # cache des checks de binaires
    step = 0
    # En mode imatrix_only, on skip la sélection de quants et on utilise un
    # confirm allégé.
    if mode == MODE_IMATRIX_ONLY:
        steps = ("model", "calib", "options", "confirm_imatrix")
    else:
        steps = ("model", "calib", "quants", "options", "confirm")

    while step < len(steps):
        name = steps[step]

        if name == "model":
            r = screen_select_model(models_path)
            if r is None:
                _abort()
            state["model"] = r
            # Calcul imatrix_path dérivé du modèle — hash anti-collision.
            rel_hash = hashlib.sha1(
                str(r.first_shard.relative_to(models_path)).encode("utf-8")
            ).hexdigest()[:8]
            state["imatrix_path"] = imatrix_dir / f"{r.base_name}-{rel_hash}.imatrix"
            step += 1

        elif name == "calib":
            r = screen_select_calib(calib_dir)
            if r is None:
                _abort()
            if r == BACK:
                step = max(0, step - 1)
                continue
            state["calib"] = r
            step += 1

        elif name == "quants":
            r = screen_select_quants(cfg["quants"], state["model"].total_bytes)
            if r is None:
                _abort()
            if r == BACK:
                step -= 1
                continue
            state["quants"] = r
            step += 1

        elif name == "options":
            # En mode imatrix_only, le screen_options demande pareil mais on
            # force skip_imatrix=False après — on VEUT calculer la matrice.
            r = screen_options(
                default_toolbox,
                state["imatrix_path"].exists() and mode == MODE_QUANTIZE,
                state["imatrix_path"],
            )
            if r is None:
                _abort()
            if r == BACK:
                step -= 1
                continue
            toolbox, skip_imatrix = r
            if mode == MODE_IMATRIX_ONLY:
                skip_imatrix = False

            # Check toolbox binaries à chaque nouveau choix (cache simple).
            if toolbox not in checked_toolboxes:
                if toolbox != default_toolbox and not toolbox_exists(toolbox):
                    console.print(f"[red]✗[/] Toolbox [yellow]{toolbox}[/] introuvable.")
                    continue  # revient au même screen options
                missing = [
                    b for b in ("llama-imatrix", "llama-quantize")
                    if not toolbox_has_binary(toolbox, b)
                ]
                if missing:
                    for b in missing:
                        console.print(f"[red]✗[/] [yellow]{b}[/] absent de [yellow]{toolbox}[/]")
                    console.print(f"  [dim]Refresh la toolbox : ./refresh-toolboxes.sh all[/]")
                    continue
                checked_toolboxes.add(toolbox)

            state["toolbox"] = toolbox
            state["skip_imatrix"] = skip_imatrix
            step += 1

        elif name == "confirm":
            r = screen_confirm(
                state["model"], state["calib"], state["quants"],
                state["toolbox"], state["skip_imatrix"],
                state["imatrix_path"], output_dir, cfg,
            )
            if r == BACK:
                step -= 1
                continue
            if not r:
                _abort()
            step += 1  # sort de la boucle

        elif name == "confirm_imatrix":
            r = screen_confirm_imatrix(
                state["model"], state["calib"], state["toolbox"],
                state["imatrix_path"], cfg,
            )
            if r == BACK:
                step -= 1
                continue
            if not r:
                _abort()
            step += 1

    # Extraction depuis l'état (lisibilité pour le reste du main)
    model = state["model"]
    calib = state["calib"]
    quants = state.get("quants", [])  # vide en mode imatrix_only
    toolbox = state["toolbox"]
    skip_imatrix = state["skip_imatrix"]
    imatrix_path = state["imatrix_path"]
    imatrix_cache_dir = imatrix_dir

    # ── Pré-flight writability : on évite de découvrir un problème de perms
    # après 1h de pipeline. Test réel (touch+unlink) sur tous les paths où on
    # va écrire.
    log_dir = Path.home() / ".cache" / "brain-quant"
    preflight_paths = [
        ("cache brain-quant",          log_dir),
        ("imatrix cache",              imatrix_cache_dir),
        ("output dir (quants finaux)", output_dir),
    ]
    writable_issues: list[tuple[str, Path, str]] = []
    for label, p in preflight_paths:
        ok, reason = check_writable(p)
        if not ok:
            writable_issues.append((label, p, reason))

    if writable_issues:
        console.print()
        console.print("[bold red]✗ Problèmes d'accès en écriture :[/]")
        for label, p, reason in writable_issues:
            console.print(f"  [red]{label}[/]  → {reason}")
        console.print()
        console.print("[yellow]Fix typique (si les dossiers appartiennent à un autre user) :[/]")
        for label, p, _ in writable_issues:
            parent_to_fix = p if p.exists() else p.parent
            console.print(f"  sudo chown -R $USER:$USER {parent_to_fix}")
            console.print(f"  chmod -R u+rw {parent_to_fix}")
        console.print()
        console.print("[dim]Relance ensuite brain-quant — tout sera conservé "
                      "(tes sélections et ton imatrix si elle a été calculée).[/]")
        sys.exit(1)

    # OK write partout, on peut y aller
    log_dir.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    log_path = log_dir / f"run-{ts}-{model.base_name}.log"
    console.print(f"[dim]Log détaillé : {log_path}[/]\n")

    total_t0 = time.time()
    results: list[tuple[str, Path, float, Optional[str]]] = []  # (quant, out, duration, error)

    with open(log_path, "w", encoding="utf-8") as log_stream:
        log_stream.write(f"brain-quant run @ {ts}\n")
        log_stream.write(f"model: {model.first_shard}\n")
        log_stream.write(f"calib: {calib}\n")
        log_stream.write(f"toolbox: {toolbox}\n\n")

        # Imatrix
        if not skip_imatrix:
            log_stream.write("=== IMATRIX ===\n")
            # Les toolbox containers ne voient que $HOME. Si la calib est hors
            # de HOME (ex: /opt/llamacpp-daemon/quantize/calibration/), on la
            # copie sous HOME pour qu'elle soit accessible au container.
            calib_for_toolbox = ensure_toolbox_accessible(
                calib, log_dir / "calibs"
            )
            if calib_for_toolbox != calib.resolve():
                console.print(
                    f"[dim]Calib copiée sous HOME pour accès toolbox : "
                    f"{calib_for_toolbox}[/]"
                )
                log_stream.write(f"calib copied to: {calib_for_toolbox}\n")
            try:
                elapsed = run_imatrix(
                    toolbox=toolbox,
                    f16_path=model.first_shard,
                    calib_path=calib_for_toolbox,
                    out_imatrix=imatrix_path,
                    chunks=cfg["imatrix"]["chunks"],
                    ctx=cfg["imatrix"]["ctx"],
                    batch=cfg["imatrix"]["batch"],
                    ngl=cfg["imatrix"]["ngl"],
                    log_stream=log_stream,
                )
                console.print(f"[green]✓[/] Imatrix en {fmt_duration(elapsed)}  "
                              f"({fmt_size(imatrix_path.stat().st_size)})\n")
            except Exception as exc:
                console.print(f"[red]✗ Imatrix échec : {exc}[/]")
                console.print(f"[dim]Détails dans {log_path}[/]")
                sys.exit(1)
        else:
            console.print(f"[yellow]→[/] Imatrix existante réutilisée\n")

        # Mode imatrix_only : stop après la matrice, pas de quantize.
        if mode == MODE_IMATRIX_ONLY:
            console.print()
            console.rule("[bold green]Imatrix générée[/]", style="green")
            console.print(f"[bold]Fichier[/]       {imatrix_path}")
            console.print(f"[bold]Taille[/]        {fmt_size(imatrix_path.stat().st_size)}")
            console.print(f"[bold]Log[/]           {log_path}")
            console.print()
            console.print(
                "[dim]Étape suivante typique : "
                "[bold]./inspect-imatrix.py " + str(imatrix_path) + "[/] "
                "ou relance brain-quant → mode [bold]Inspect imatrix[/].[/]"
            )
            return

        # Quantize chaque variante
        for q in quants:
            q.setdefault("source_top_type", model.top_type)
            out = next_versioned_gguf(
                output_dir / f"{model.base_name}-brain-{q['name']}.gguf"
            )
            log_stream.write(f"\n=== QUANTIZE {q['name']} → {out.name} ===\n")
            try:
                elapsed = run_quantize(
                    toolbox=toolbox,
                    f16_path=model.first_shard,
                    imatrix_path=imatrix_path,
                    out_path=out,
                    quant_cfg=q,
                    log_stream=log_stream,
                )
                out_size = out.stat().st_size if out.exists() else 0
                console.print(
                    f"[green]✓[/] {q['name']:<14} "
                    f"{fmt_size(out_size):>10}  "
                    f"en {fmt_duration(elapsed)}"
                )
                # Post-quantize validation
                vw = _validate_output_gguf(model.first_shard, out)
                for w in vw:
                    console.print(f"  [bold yellow]⚠  {w}[/]")
                results.append((q["name"], out, elapsed, None))
            except Exception as exc:
                console.print(f"[red]✗ {q['name']} échec : {exc}[/]")
                results.append((q["name"], out, 0.0, str(exc)))
                continue

    total_elapsed = time.time() - total_t0

    # ── Quality eval optionnelle ───────────────────────────────────────────
    # Lance la suite quality_suite.jsonl sur chaque GGUF produit. Pas un
    # release gate qui bloque — juste un signal numérique reproductible.
    quality_reports = run_quality_eval_step(
        results=results,
        toolbox=toolbox,
        log_dir=log_dir,
        ts=ts,
    )

    # ── Résumé final ───────────────────────────────────────────────────────
    console.print()
    console.rule("[bold green]Pipeline terminée[/]", style="green")

    table = Table(show_header=True, header_style="bold magenta", box=None, padding=(0, 2))
    table.add_column("Quant")
    table.add_column("Fichier", overflow="fold")
    table.add_column("Taille", justify="right")
    table.add_column("Durée", justify="right")
    table.add_column("Statut")
    table.add_column("Quality", justify="right")
    for name, out, dur, err in results:
        # Cherche le rapport quality correspondant (par quant_name)
        q_cell = "[dim]—[/]"
        for rep in quality_reports:
            if rep.get("quant_name") == name:
                s = rep.get("summary", {})
                pr = s.get("pass_rate", 0.0)
                color = "green" if pr >= 0.9 else ("yellow" if pr >= 0.7 else "red")
                q_cell = f"[{color}]{s.get('passed',0)}/{s.get('total',0)} ({pr*100:.0f}%)[/]"
                break

        if err is None and out.exists():
            table.add_row(
                name, out.name, fmt_size(out.stat().st_size),
                fmt_duration(dur), "[green]✓[/]", q_cell,
            )
        else:
            table.add_row(name, out.name, "—", "—",
                          f"[red]✗ {err or 'fichier absent'}[/]", q_cell)
    console.print(table)
    console.print()
    console.print(f"[bold]Total[/]         {fmt_duration(total_elapsed)}")
    console.print(f"[bold]Output[/]        {output_dir}")
    console.print(f"[bold]Log[/]           {log_path}")
    console.print()
    console.print(
        "[dim]Les GGUF sont dans models_path — le daemon les découvrira au "
        "prochain [bold]GET /mgmt/models[/].[/]"
    )


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        console.print("\n[yellow]Interrompu par l'utilisateur.[/]")
        sys.exit(130)
