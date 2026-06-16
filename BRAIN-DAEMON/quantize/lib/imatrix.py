"""imatrix : runner llama-imatrix + parser binaire .imatrix + cache lookup.

Logique pure (pas de console/rich). Le TUI et le daemon partagent ce module ;
chacun injecte son propre `progress_cb` pour observer la progression.

Runner :
    run_imatrix(toolbox, f16, calib, out, params, progress_cb, cancel_event, log_stream)

Parser :
    parse_imatrix(path) -> ImatrixData
    detect_architecture(tensors) -> "dense" | "moe" | "hybrid"

Cache :
    find_existing_imatrix(imatrix_dir, source, calib) -> Path | None
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import re
import select
import signal
import struct
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

from . import toolbox as tb


def _kill_group(proc: subprocess.Popen) -> None:
    """SIGKILL au process group entier (`toolbox run` + ses enfants llama-*).

    Le runner crée les subprocess via `toolbox_popen_bytes` qui passe
    `start_new_session=True` → pid == pgid. Un simple `proc.kill()` ne SIGKILL
    que le wrapper toolbox, laissant llama-imatrix orphelin qui squatte le GPU
    (audit R3-H2).
    """
    if proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except OSError:
        # fallback dégradé si killpg refuse (Windows test, container quirks…)
        try:
            proc.kill()
        except Exception:
            pass


# ────────────────────────────────────────────────────────────────────────────
# Constants
# ────────────────────────────────────────────────────────────────────────────

# Buffer sliding-window pour parser la sortie imatrix sans exploser en RAM.
# 64k accumulé → on garde les 16k de queue (les derniers marqueurs [N] y vivent).
_IMATRIX_BUFFER_MAX = 64_000
_IMATRIX_BUFFER_TAIL = 16_000

# Poll non-blocking sur stdout imatrix : cadence de rafraîchissement.
_IMATRIX_POLL_SEC = 0.1

# Parse "[N]..." inline output de llama-imatrix. Ancré sur un contexte gauche
# (début, virgule, espace, newline) pour ne pas matcher des `[N]` parasites.
_IMATRIX_CHUNK_RE = re.compile(r"(?:^|[,\s])\[(\d+)\]")


# ────────────────────────────────────────────────────────────────────────────
# Data classes
# ────────────────────────────────────────────────────────────────────────────

@dataclass
class TensorStat:
    """Stats d'un tensor depuis le parser .imatrix.

    Port direct de inspect-imatrix.py:107.
    """
    name: str
    ncall: int
    nval: int
    sum_values: float
    l2_norm: float
    mean_value: float
    concentration_top10: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "ncall": self.ncall,
            "nval": self.nval,
            "sum_values": self.sum_values,
            "l2_norm": self.l2_norm,
            "mean_value": self.mean_value,
            "concentration_top10": self.concentration_top10,
        }


@dataclass
class ImatrixData:
    """Résultat complet du parsing d'une .imatrix."""
    tensors: list[TensorStat]
    ncall_total: int
    dataset: str
    architecture: str    # "dense" | "moe" | "hybrid"

    def to_dict(self) -> dict[str, Any]:
        return {
            "tensors": [t.to_dict() for t in self.tensors],
            "ncall_total": self.ncall_total,
            "dataset": self.dataset,
            "architecture": self.architecture,
        }


@dataclass
class ImatrixProgress:
    """Event poussé via progress_cb pendant run_imatrix."""
    stage: str           # "spawning" | "running" | "done"
    chunk_current: int
    chunk_total: int
    elapsed_sec: float


@dataclass
class RunResult:
    """Résultat d'un run_imatrix / run_quantize."""
    elapsed_sec: float
    returncode: int
    output_path: Path
    cancelled: bool = False


# ────────────────────────────────────────────────────────────────────────────
# Parser
# ────────────────────────────────────────────────────────────────────────────

def detect_architecture(tensors: list[TensorStat]) -> str:
    """Heuristique MoE/dense depuis les noms de tensors.

    Port direct de inspect-imatrix.py:79, élargi pour mieux catcher l'hybride :
    - dense  : pas d'experts, FFN classique
    - moe    : experts uniquement, pas de signe d'hybride
    - hybrid : experts ET au moins un signe d'hybridité (FFN dense, shared
      experts, SSM, attention gate). Sans cette détection plus large, des
      modèles avec experts + shared experts (Gemma-4) ou experts + SSM (Qwen3.6
      hybrid) étaient classés `moe` et leurs familles shexp/ssm tombaient sans
      badge (CATEGORY_PRIORITY['moe'] ne couvre pas ces catégories).
    """
    has_exps = any("_exps" in t.name for t in tensors)
    if not has_exps:
        return "dense"
    has_dense_ffn = any(
        re.search(r"ffn_(gate|up|down)\.weight", t.name) and "_exps" not in t.name
        for t in tensors
    )
    has_shexp = any("_shexp" in t.name for t in tensors)
    has_ssm = any(re.search(r"(?:^|\.)ssm_", t.name) for t in tensors)
    has_attn_gate = any(re.search(r"(?:^|\.)attn_gate\.", t.name) for t in tensors)
    if has_dense_ffn or has_shexp or has_ssm or has_attn_gate:
        return "hybrid"
    return "moe"


def parse_imatrix(path: Path) -> ImatrixData:
    """Parse le fichier .imatrix binaire (format llama.cpp dat).

    Port direct de inspect-imatrix.py:117.

    Format binaire :
        u32 n_entries
        repeat n_entries:
            u32 name_len, char[name_len] name
            u32 ncall
            u32 nval
            f32[nval] sum_values
        u32 ncall_total
        u32 dataset_len, char[dataset_len] dataset
    """
    with open(path, "rb") as f:
        data = f.read()

    pos = 0
    n_entries = struct.unpack_from("<I", data, pos)[0]
    pos += 4

    tensors: list[TensorStat] = []
    for _ in range(n_entries):
        name_len = struct.unpack_from("<I", data, pos)[0]
        pos += 4
        name = data[pos:pos + name_len].decode("utf-8", errors="replace")
        pos += name_len
        ncall = struct.unpack_from("<I", data, pos)[0]
        pos += 4
        nval = struct.unpack_from("<I", data, pos)[0]
        pos += 4
        values = struct.unpack_from(f"<{nval}f", data, pos)
        pos += nval * 4

        # Stats agrégées
        sum_values = float(sum(values))
        l2_norm = float(sum(v * v for v in values) ** 0.5)
        mean_value = sum_values / nval if nval > 0 else 0.0

        # Concentration : top 10% des valeurs vs total
        if nval > 0 and sum_values > 0:
            sorted_vals = sorted(values, reverse=True)
            top10_n = max(1, nval // 10)
            top10_sum = sum(sorted_vals[:top10_n])
            concentration_top10 = top10_sum / sum_values
        else:
            concentration_top10 = 0.0

        tensors.append(TensorStat(
            name=name,
            ncall=ncall,
            nval=nval,
            sum_values=sum_values,
            l2_norm=l2_norm,
            mean_value=mean_value,
            concentration_top10=concentration_top10,
        ))

    # Trailer : ncall_total + dataset
    if pos + 4 <= len(data):
        ncall_total = struct.unpack_from("<I", data, pos)[0]
        pos += 4
    else:
        ncall_total = 0

    if pos + 4 <= len(data):
        dataset_len = struct.unpack_from("<I", data, pos)[0]
        pos += 4
        dataset = data[pos:pos + dataset_len].decode("utf-8", errors="replace")
    else:
        dataset = ""

    arch = detect_architecture(tensors)

    return ImatrixData(
        tensors=tensors,
        ncall_total=ncall_total,
        dataset=dataset,
        architecture=arch,
    )


# ────────────────────────────────────────────────────────────────────────────
# Cache lookup
# ────────────────────────────────────────────────────────────────────────────

def imatrix_name_for(source: Path, calib: Path) -> str:
    """Génère un nom canonique pour l'imatrix d'un (source, calib).

    Hash 8-char de (calib_path) pour éviter les collisions quand on a la
    même base_name avec des calib différentes.
    """
    stem = source.name
    stem = re.sub(r"\.gguf$", "", stem)
    stem = re.sub(r"-\d{5}-of-\d{5}$", "", stem)
    stem = re.sub(r"[-_.](F16|BF16|FP16|Q8_\w+)$", "", stem, flags=re.IGNORECASE)
    h = hashlib.sha256(str(calib.resolve()).encode("utf-8")).hexdigest()[:8]
    return f"{stem}-{h}.imatrix"


def find_existing_imatrix(imatrix_dir: Path, source: Path, calib: Path) -> Optional[Path]:
    """Retourne le path .imatrix existant pour ce (source, calib) si présent."""
    candidate = imatrix_dir / imatrix_name_for(source, calib)
    return candidate if candidate.exists() else None


# ────────────────────────────────────────────────────────────────────────────
# Runner
# ────────────────────────────────────────────────────────────────────────────

ProgressCallback = Callable[[ImatrixProgress], None]
PidCallback = Callable[[int], None]


# Heuristique de tokenization : 3.8 bytes/token pour FR/EN markdown mixé. Aligné
# avec `scan.CalibEntry.est_tokens` pour rester cohérent entre l'estimation
# affichée à l'UI et le check pré-spawn (sinon l'UI dirait "12k tokens OK" et le
# brain refuserait quand même).
_BYTES_PER_TOKEN_EST = 3.8

# Marge de sécurité pour le pré-flight : English markdown court-mot peut tomber
# à 4.4 b/t réel vs notre estimation 3.8 (bug-hunt finding #6 : un corpus 8 KB
# EN passait le pré-flight mais sortait à 1800 tokens réels au lieu de 2105 estimés).
# 10% de margin catche ce cas tout en gardant comfort sur FR (le sparring-fr de
# 36 KB a ~850 tokens de buffer après margin).
_PREFLIGHT_TOKEN_MARGIN = 0.90


def check_calibration_size(calib_path: Path, ctx: int) -> Optional[str]:
    """Pré-flight : llama-imatrix exige `tokens >= 2*ctx` sinon il sort en code 1
    avec "you need at least N tokens for a context of M tokens" (cf logs prod
    2026-05-23). Cette fonction renvoie un message d'erreur (à raise / publish)
    si la calib est trop petite, None si OK.

    Applique une marge de sécurité (cf _PREFLIGHT_TOKEN_MARGIN) car notre
    estimation b/t peut être optimiste sur EN short-word.
    """
    if not calib_path.exists():
        return f"calibration introuvable : {calib_path}"
    try:
        size = calib_path.stat().st_size
    except OSError as e:
        return f"impossible de lire {calib_path} : {e}"
    est_tokens = int(size / _BYTES_PER_TOKEN_EST * _PREFLIGHT_TOKEN_MARGIN)
    min_tokens = 2 * ctx
    if est_tokens < min_tokens:
        return (
            f"calibration trop petite : {calib_path.name} fait ~{est_tokens} tokens "
            f"({size} bytes, marge sécurité incluse), llama-imatrix exige ≥ {min_tokens} tokens "
            f"pour ctx={ctx}. Augmente le corpus ou diminue ctx."
        )
    return None


def _llama_imatrix_args(
    f16_path: Path,
    calib_path: Path,
    out_imatrix: Path,
    chunks: int,
    ctx: int,
    batch: int,
    ngl: int,
) -> list[str]:
    """Construit la commandline llama-imatrix (sans le wrap toolbox)."""
    return [
        "llama-imatrix",
        "-m", str(f16_path),
        "-f", str(calib_path),
        "-o", str(out_imatrix),
        "--output-format", "dat",
        "-c", str(ctx),
        "-b", str(batch),
        "--chunks", str(chunks),
        "-ngl", str(ngl),
        "-fa", "1",
        "--no-mmap",
        # Tokenise les tokens spéciaux (chat template <|im_start|>, marqueurs
        # d'outils) comme tokens au lieu de texte brut. Indispensable pour
        # calibrer un modèle instruct sur du corpus chat-template-aware / traces
        # de tool-calling (cf persoV5) : sinon ces tokens partent en sous-mots
        # parasites et l'imatrix sous-pondère les poids d'appel d'outil.
        "--parse-special",
        "-t", str(os.cpu_count() or 16),
    ]


def run_imatrix(
    toolbox: str,
    f16_path: Path,
    calib_path: Path,
    out_imatrix: Path,
    chunks: int,
    ctx: int,
    batch: int,
    ngl: int,
    progress_cb: Optional[ProgressCallback] = None,
    cancel_event: Optional[asyncio.Event] = None,
    log_stream=None,
    pid_cb: Optional[PidCallback] = None,
) -> RunResult:
    """Calcule imatrix. Émet des ImatrixProgress via progress_cb (si fourni).

    Le TUI passe un callback qui met à jour rich.Progress.
    Le daemon passe un callback qui pousse les events dans la queue NDJSON.
    `log_stream` (optionnel) reçoit le stdout brut (typiquement un fichier .log).
    `cancel_event` (optionnel) : si set, on tue le subprocess et retourne
    RunResult(cancelled=True).
    `pid_cb` (optionnel) : appelé une fois avec le PID du subprocess juste après
    spawn — permet au manager de persister le PID pour pouvoir tuer un orphelin
    au prochain boot daemon (C1 audit).

    Port de brain-quant.py:441 avec abstraction du callback de progression.
    """
    out_imatrix.parent.mkdir(parents=True, exist_ok=True)
    cmd = _llama_imatrix_args(f16_path, calib_path, out_imatrix, chunks, ctx, batch, ngl)

    # Trace la commande argv réelle + sanity check du flag parse-special, pour
    # confirmer dans le log du job qu'il est bien appliqué (sinon calibration
    # instruct silencieusement dégradée). Cf. issue 2026-06-02.
    if log_stream is not None:
        ps = "ON" if "--parse-special" in cmd else "OFF"
        log_stream.write(f"[imatrix] parse-special={ps}\n[imatrix] cmd: {' '.join(cmd)}\n")
        log_stream.flush()

    if progress_cb:
        progress_cb(ImatrixProgress("spawning", 0, chunks, 0.0))

    t0 = time.time()
    proc = tb.toolbox_popen_bytes(toolbox, cmd)
    if pid_cb is not None:
        try:
            pid_cb(proc.pid)
        except Exception:
            pass
    fd = proc.stdout.fileno()

    buffer = ""
    # Tail séparé du `buffer` (qui est consommé par le parser chunk). On garde
    # les ~4 KB derniers de stdout pour les inclure dans l'erreur si llama-imatrix
    # crash — sinon on a juste "exit code 1" sans aucune info de diag.
    stdout_tail = ""
    _TAIL_MAX = 4096
    max_seen = 0
    cancelled = False

    def _append_tail(s: str) -> None:
        nonlocal stdout_tail
        stdout_tail += s
        if len(stdout_tail) > _TAIL_MAX:
            stdout_tail = stdout_tail[-_TAIL_MAX:]

    try:
        while True:
            if cancel_event is not None and cancel_event.is_set():
                _kill_group(proc)
                cancelled = True
                break

            ready, _, _ = select.select([fd], [], [], _IMATRIX_POLL_SEC)
            if ready:
                raw = os.read(fd, 4096)
                if not raw:
                    break
                chunk = raw.decode("utf-8", errors="replace")
                buffer += chunk
                _append_tail(chunk)
                if log_stream is not None:
                    log_stream.write(chunk)
                    log_stream.flush()

                matches = _IMATRIX_CHUNK_RE.findall(buffer)
                if matches:
                    current = max(int(x) for x in matches)
                    new_max = min(current, chunks)
                    if new_max > max_seen:
                        max_seen = new_max
                        if progress_cb:
                            progress_cb(ImatrixProgress(
                                stage="running",
                                chunk_current=max_seen,
                                chunk_total=chunks,
                                elapsed_sec=time.time() - t0,
                            ))

                if len(buffer) > _IMATRIX_BUFFER_MAX:
                    buffer = buffer[-_IMATRIX_BUFFER_TAIL:]
            elif proc.poll() is not None:
                try:
                    remaining = os.read(fd, 65_536)
                except OSError:
                    remaining = b""
                if remaining:
                    remaining_str = remaining.decode("utf-8", errors="replace")
                    _append_tail(remaining_str)
                    if log_stream is not None:
                        log_stream.write(remaining_str)
                        log_stream.flush()
                break

        proc.wait()
    except KeyboardInterrupt:
        _kill_group(proc)
        cancelled = True
        proc.wait()
        raise
    finally:
        elapsed = time.time() - t0
        if progress_cb:
            progress_cb(ImatrixProgress("done", max_seen, chunks, elapsed))

    if not cancelled and proc.returncode != 0:
        tail = stdout_tail.strip()
        msg = f"llama-imatrix exited with code {proc.returncode}"
        if tail:
            msg += f"\n--- stdout tail ---\n{tail}"
        raise RuntimeError(msg)

    return RunResult(
        elapsed_sec=elapsed,
        returncode=proc.returncode,
        output_path=out_imatrix,
        cancelled=cancelled,
    )
