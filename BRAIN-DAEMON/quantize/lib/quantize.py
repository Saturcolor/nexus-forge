"""quantize : builder d'overrides llama-quantize + runner + validator GGUF post-quant.

Logique pure (pas de console/rich). Le TUI et le daemon partagent ce module.

Fonctions :
    build_quantize_overrides(preset) -> list[str]  (flags llama-quantize)
    run_quantize(toolbox, f16, imatrix, out, preset, progress_cb, cancel_event, log_stream) -> RunResult
    validate_output_gguf(source, output) -> list[str]  (warnings, vide = OK)

Port direct de brain-quant.py:539-721.
"""
from __future__ import annotations

import asyncio
import os
import re
import select
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

from . import gguf
from . import toolbox as tb
from .imatrix import RunResult, _kill_group  # noqa: F401 — réutilise le helper SIGKILL group


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

# Parse "[ NN%] ..." inline output de llama-quantize (progress par couche).
_QUANTIZE_PCT_RE = re.compile(r"\[\s*(\d{1,3})%\]")


@dataclass
class QuantizeProgress:
    """Event poussé via progress_cb pendant run_quantize."""
    preset_name: str
    pct: float            # 0.0-100.0
    stage: str            # "spawning" | "running" | "done"
    elapsed_sec: float


ProgressCallback = Callable[[QuantizeProgress], None]
PidCallback = Callable[[int], None]

# Poll cadence pour le check cancel + lecture stdout non bloquante.
_QUANTIZE_POLL_SEC = 0.5


def build_quantize_overrides(preset: dict[str, Any]) -> list[str]:
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

    Port direct de brain-quant.py:539.
    """
    args: list[str] = []
    quant_name = preset.get("name", "")
    source_top_type = preset.get("source_top_type", "F16")

    # Si source est Q8_0 (ou autre non-F16), on doit autoriser la re-quantization
    if source_top_type not in ("F16", "BF16"):
        args += ["--allow-requantize"]

    preserve_emb = preset.get("preserve_embeddings")
    overrides = preset.get("tensor_overrides")
    family_quants = preset.get("family_quants")

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

    # preserve_embeddings : bumper output/token_embd vers le type haut de la source.
    # UNIQUEMENT depuis une source haute (F16/BF16/Q8_0). Depuis un K-quant/IQ déjà
    # bas (ex Q3_K_L, output déjà Q6_K), llama-quantize REFUSE le requant montant
    # ("requantizing from type q6_K is disabled") → on n'override pas : output/embd
    # suivent la recette de base et restent à leur niveau source (copiés).
    if preserve_emb and source_top_type in ("F16", "BF16", "Q8_0"):
        emb_type = "F16" if source_top_type in ("F16", "BF16") else "Q8_0"
        args += ["--token-embedding-type", emb_type,
                 "--output-tensor-type", emb_type]

    # 1. tensor_overrides en premier (priorité max) : pins F16 + top-X% F16 exacts
    for rule in (overrides or []):
        if "=" in rule:
            parts = rule.rsplit("=", 1)
            parts[1] = _TENSOR_TYPE_MAP.get(parts[1], parts[1])
            rule = "=".join(parts)
        args += ["--tensor-type", rule]

    # 2. family_quants ensuite : règle regex par famille.
    #    On skip les entrées "base" (redondant avec le fallback llama-quantize).
    for fam, qtype in (family_quants or {}).items():
        if qtype and qtype != "base":
            qtype = _TENSOR_TYPE_MAP.get(qtype, qtype)
            args += ["--tensor-type", f"{fam}\\..*={qtype}"]

    return args


def run_quantize(
    toolbox: str,
    f16_path: Path,
    imatrix_path: Optional[Path],
    out_path: Path,
    preset: dict[str, Any],
    progress_cb: Optional[ProgressCallback] = None,
    cancel_event: Optional[asyncio.Event] = None,
    log_stream=None,
    pid_cb: Optional[PidCallback] = None,
) -> RunResult:
    """Produit un quant. Overrides lus depuis preset (config.yaml ou custom).

    `imatrix_path` peut être None → llama-quantize tourne sans `--imatrix`
    (raw quant). Les K-quants restent valides sans imatrix, juste sans le bonus
    d'optimisation par importance. Utile pour des tests rapides ou des baselines
    de comparaison.

    Le TUI passe un callback qui met à jour rich.Progress.
    Le daemon passe un callback qui pousse les events dans la queue NDJSON.
    `log_stream` (optionnel) reçoit le stdout brut.
    `cancel_event` (optionnel) : si set, kill subprocess. Le check est fait
    en non-bloquant via select pour ne PAS attendre la fin d'une phase silencieuse
    de llama-quantize.
    `pid_cb` (optionnel) : appelé avec le PID du subprocess juste après spawn,
    pour persistence orphan recovery.

    En cas d'échec / cancel, le .gguf tronqué est supprimé pour éviter que
    le daemon le découvre et tente de le charger (crash garanti).
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)

    quant_name = preset["name"]
    quant_base = preset["base"]
    overrides = build_quantize_overrides(preset)

    cmd: list[str] = ["llama-quantize"]
    if imatrix_path is not None:
        cmd += ["--imatrix", str(imatrix_path)]
    cmd += overrides + [str(f16_path), str(out_path), quant_base]

    if progress_cb:
        progress_cb(QuantizeProgress(quant_name, 0.0, "spawning", 0.0))

    t0 = time.time()
    cancelled = False
    proc: Optional[subprocess.Popen] = None
    # Tail des derniers ~4 KB de stdout pour diag — sans ça, "exit code N" sans
    # contexte (pareil que imatrix.py).
    stdout_tail = ""
    _TAIL_MAX = 4096

    def _append_tail(s: str) -> None:
        nonlocal stdout_tail
        stdout_tail += s
        if len(stdout_tail) > _TAIL_MAX:
            stdout_tail = stdout_tail[-_TAIL_MAX:]

    try:
        # Bytes-mode + select pour pouvoir interrompre rapidement même si
        # llama-quantize traverse une phase silencieuse (cancel-aware).
        proc = tb.toolbox_popen_bytes(toolbox, cmd)
        if pid_cb is not None:
            try:
                pid_cb(proc.pid)
            except Exception:
                pass
        fd = proc.stdout.fileno()
        buffer = b""

        while True:
            if cancel_event is not None and cancel_event.is_set():
                # SIGKILL au group entier (audit R3-H2) — sinon llama-quantize
                # orphelin squatte le GPU après cancel UI.
                _kill_group(proc)
                cancelled = True
                break

            ready, _, _ = select.select([fd], [], [], _QUANTIZE_POLL_SEC)
            if ready:
                raw = os.read(fd, 4096)
                if not raw:
                    break  # EOF
                buffer += raw
                # On émet sur le log dès que dispo
                decoded = raw.decode("utf-8", errors="replace")
                _append_tail(decoded)
                if log_stream is not None:
                    try:
                        log_stream.write(decoded)
                        log_stream.flush()
                    except Exception:
                        pass
                # Parse les % par ligne complète (split sur \n et \r pour les
                # carriage-returns que llama-quantize utilise pour réécrire la
                # même ligne). On prend le PLUS TÔT des deux séparateurs sinon
                # une rafale `\r[50%]\r[60%]\r[70%]\n` était traitée comme une
                # seule "ligne" et seul le premier % était capturé (bug-hunt #8).
                while True:
                    positions = [x for x in (buffer.find(b"\n"), buffer.find(b"\r")) if x >= 0]
                    if not positions:
                        break
                    nl = min(positions)
                    line = buffer[:nl].decode("utf-8", errors="replace")
                    buffer = buffer[nl + 1:]
                    if progress_cb:
                        m = _QUANTIZE_PCT_RE.search(line)
                        if m:
                            pct = float(m.group(1))
                            progress_cb(QuantizeProgress(
                                preset_name=quant_name,
                                pct=pct,
                                stage="running",
                                elapsed_sec=time.time() - t0,
                            ))
            elif proc.poll() is not None:
                # Pas de données + process fini → drain et sort
                try:
                    remaining = os.read(fd, 65_536)
                except OSError:
                    remaining = b""
                if remaining:
                    remaining_str = remaining.decode("utf-8", errors="replace")
                    _append_tail(remaining_str)
                    if log_stream is not None:
                        try:
                            log_stream.write(remaining_str)
                            log_stream.flush()
                        except Exception:
                            pass
                break

        proc.wait()

        if not cancelled and proc.returncode != 0:
            tail = stdout_tail.strip()
            msg = f"llama-quantize exited with code {proc.returncode}"
            if tail:
                msg += f"\n--- stdout tail ---\n{tail}"
            raise RuntimeError(msg)
    except Exception:
        # Échec / Ctrl+C → on supprime le .gguf tronqué
        if out_path.exists():
            try:
                out_path.unlink()
            except OSError:
                pass
        raise
    finally:
        elapsed = time.time() - t0
        if progress_cb:
            progress_cb(QuantizeProgress(quant_name, 100.0 if not cancelled else 0.0, "done", elapsed))

    if cancelled and out_path.exists():
        try:
            out_path.unlink()
        except OSError:
            pass

    return RunResult(
        elapsed_sec=elapsed,
        returncode=proc.returncode if proc else -1,
        output_path=out_path,
        cancelled=cancelled,
    )


def validate_output_gguf(
    source_path: Path,
    output_path: Path,
) -> list[str]:
    """Validation post-quantize : parse le header du GGUF produit et vérifie
    la cohérence avec le source. Retourne une liste de warnings (vide = OK).
    Gère les modèles shardés (00001-of-NNNNN) en lisant tous les shards.

    Port direct de brain-quant.py:663 (renommé _validate_output_gguf → public).
    """
    warnings: list[str] = []

    try:
        src_hdr = gguf.read_gguf_header_sharded(source_path)
    except Exception:
        return warnings  # source unreadable, skip

    src_tensors = src_hdr.tensors
    if not src_tensors:
        return warnings

    try:
        out_hdr = gguf.read_gguf_header(output_path)
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
    if out_tensor_bytes > 0 and out_size < out_tensor_bytes * 0.80:
        warnings.append(
            f"Fichier output suspect : {out_size / (1024**3):.2f} GB "
            f"vs {out_tensor_bytes / (1024**3):.2f} GB estimé depuis le header"
        )

    return warnings
