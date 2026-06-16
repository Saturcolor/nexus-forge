"""Wrapper subprocess pour `llama-extract-vector` (binaire C++ Vulkan natif).

ARCHI v0.2 (2026-05-20) — pivot stratégique post-validation POC.

Pourquoi subprocess :
- Le binaire `llama-extract-vector` vit dans le fork `atomic-llama-cpp-turboquant`,
  build Vulkan natif. 5-10× plus rapide que transformers CPU, utilise les quants
  existants (Mercury surgical Q5, Gembrain BF16, etc.) sans re-DL du non-quanté.
- Supprime la dépendance torch/transformers/sklearn côté brain-daemon prod.
- Process isolation = OOM-safe, kill-able, pas de fuite mémoire intra-process.

Contrat CLI / stdout NDJSON / GGUF figé — voir BRAIN-DAEMON/atlas/README.md
et memory/project_atlasmind.md.

L'ancienne implem transformers est conservée dans ATLASMIND/poc/extract_vector.py
comme regression test (la sortie C++ doit produire un vecteur avec
cosine_similarity ≥ 0.95 vs cette implem Python).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncIterator

log = logging.getLogger("brain.atlas.extractor")

DEFAULT_BINARY_CANDIDATES = [
    "/opt/llamacpp-atlas/build/bin/llama-extract-vector",  # canonical path (fork dédié atlas)
    "/opt/llama-native-turboquant/bin/llama-extract-vector",  # legacy / si co-installé
    "/opt/llama-native/bin/llama-extract-vector",
    "llama-extract-vector",  # fallback PATH lookup
]


@dataclass
class ExtractorConfig:
    """Config pour un appel extract — généré par AtlasManager depuis sa config + payload."""
    binary_path: str
    model_path: str
    layer: int
    output_path: Path
    model_hint: str
    dataset_name: str
    method: str = "diff-of-means"
    ngl: int = 99           # all layers offloaded by default
    threads: int = 8
    probe_eval: bool = True
    max_pairs: int | None = None
    seed: int | None = None
    cleanup_temp: bool = True


@dataclass
class ExtractorResult:
    """Résultat structuré du run extract — extrait du dernier event 'done' du stream NDJSON."""
    output_path: Path
    probe_accuracy: float | None
    vector_norm: float
    delta_norm: float
    cosine_pos_neg: float
    sha256: str
    n_pairs: int
    hidden_dim: int
    n_layers: int
    layer: int
    bad_count: int


def resolve_binary(configured: str | None = None) -> str:
    """Trouve le binaire llama-extract-vector.

    Priorité : configured > DEFAULT_BINARY_CANDIDATES (premier qui existe et est x).
    Raise FileNotFoundError si aucun n'est trouvé.
    """
    candidates: list[str] = []
    if configured:
        candidates.append(configured)
    candidates.extend(DEFAULT_BINARY_CANDIDATES)

    for c in candidates:
        # Si chemin absolu, vérifier existence + permission exec
        if os.path.isabs(c):
            if os.path.isfile(c) and os.access(c, os.X_OK):
                return c
        else:
            # PATH lookup
            found = shutil.which(c)
            if found:
                return found

    raise FileNotFoundError(
        f"llama-extract-vector binary not found. Tried: {candidates}. "
        "Build the binary in atomic-llama-cpp-turboquant fork "
        "and either install to /opt/llama-native-turboquant/bin/ or set "
        "atlas.extractor_binary in brain-daemon config.yaml."
    )


def write_prompts_files(pairs: list[dict[str, str]], dest_dir: Path) -> tuple[Path, Path]:
    """Sérialise les paires en deux fichiers .txt (un prompt par ligne, UTF-8).

    Le binaire C++ lit ces fichiers en mode text-mode-one-per-line.
    Returns (pos_path, neg_path).
    """
    dest_dir.mkdir(parents=True, exist_ok=True)
    pos_path = dest_dir / "pos.txt"
    neg_path = dest_dir / "neg.txt"

    # Sanity : pas de \n dans un prompt (sinon casse le one-per-line)
    def _clean(s: str) -> str:
        return s.replace("\r", " ").replace("\n", " ").strip()

    with open(pos_path, "w", encoding="utf-8") as f:
        for p in pairs:
            f.write(_clean(p["pos"]) + "\n")
    with open(neg_path, "w", encoding="utf-8") as f:
        for p in pairs:
            f.write(_clean(p["neg"]) + "\n")

    log.info(f"prompts files written: {pos_path} + {neg_path} ({len(pairs)} pairs)")
    return pos_path, neg_path


def build_cli_args(cfg: ExtractorConfig, pos_path: Path, neg_path: Path) -> list[str]:
    """Construit la liste d'args pour subprocess.exec, alignée sur le contrat CLI.

    Voir BRAIN-DAEMON/atlas/README.md pour la spec exhaustive.
    """
    args: list[str] = [
        cfg.binary_path,
        "--model", cfg.model_path,
        "--prompts-pos", str(pos_path),
        "--prompts-neg", str(neg_path),
        "--layer", str(cfg.layer),
        "--output", str(cfg.output_path),
        "--model-hint", cfg.model_hint,
        "--dataset-name", cfg.dataset_name,
        "--method", cfg.method,
        "--ngl", str(cfg.ngl),
        "--threads", str(cfg.threads),
    ]
    if cfg.probe_eval:
        args.append("--probe-eval")
    if cfg.max_pairs is not None:
        args += ["--max-pairs", str(cfg.max_pairs)]
    if cfg.seed is not None:
        args += ["--seed", str(cfg.seed)]
    return args


async def run_extract(
    cfg: ExtractorConfig,
    pairs: list[dict[str, str]],
) -> AsyncIterator[dict]:
    """Spawn `llama-extract-vector`, parse stdout NDJSON ligne par ligne, yield events.

    Events possibles (passés tels quels par le binaire, voir contrat) :
        {"event":"loaded","n_layers":N,"hidden_dim":N}
        {"event":"progress","label":"pos|neg","done":N,"total":M}
        {"event":"computing"}
        {"event":"exporting"}
        {"event":"done", "output":"...", "probe_accuracy":F, ...}
        {"event":"error","message":"...","stage":"load|extract|compute|export"}

    Yield aussi quelques events orchestrateur Python pour visibilité :
        {"event":"writing_prompts"}
        {"event":"spawning","binary":"...","args":[...]}
        {"event":"subprocess_done","exit_code":N}

    Le caller (manager.py) est responsable de :
    - extraire l'event "done" pour construire le ExtractorResult final
    - matérialiser le .gguf (le binaire l'a déjà écrit à cfg.output_path)
    - cleanup le temp dir si cfg.cleanup_temp
    """
    # 1. Préparer le temp dir pour les prompts files
    tmp = Path(tempfile.mkdtemp(prefix="atlas-extract-"))
    log.info(f"temp dir: {tmp}")
    yield {"event": "writing_prompts", "tmp_dir": str(tmp)}

    try:
        pos_path, neg_path = write_prompts_files(pairs, tmp)

        # 2. Build args + spawn
        args = build_cli_args(cfg, pos_path, neg_path)
        log.info("spawning: %s", " ".join(args))
        yield {"event": "spawning", "binary": cfg.binary_path, "args": args}

        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        # 3. Lecture concurrente stdout (NDJSON events) + stderr (free-form log)
        stderr_chunks: list[bytes] = []

        async def read_stderr():
            assert proc.stderr is not None
            while True:
                line = await proc.stderr.readline()
                if not line:
                    return
                stderr_chunks.append(line)
                decoded = line.decode("utf-8", "replace").rstrip()
                if decoded:
                    log.info("[binary stderr] %s", decoded)

        stderr_task = asyncio.create_task(read_stderr())

        assert proc.stdout is not None
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            line_str = line.decode("utf-8", "replace").strip()
            if not line_str:
                continue
            try:
                ev = json.loads(line_str)
            except json.JSONDecodeError:
                # Le binaire a écrit du texte non-JSON sur stdout — log et skip
                log.warning("non-JSON stdout line: %r", line_str[:200])
                continue
            yield ev

        # 4. Attendre la fin du process + stderr drain
        exit_code = await proc.wait()
        await stderr_task

        yield {"event": "subprocess_done", "exit_code": exit_code}

        if exit_code != 0:
            stderr_text = b"".join(stderr_chunks).decode("utf-8", "replace")[-2000:]
            # Logger en WARN (pas DEBUG) quand le binaire crashe — sinon on perd
            # toute info diag avec log_level=info par défaut côté brain.
            log.warning(
                "binary exited with code %s. stderr tail:\n%s",
                exit_code, stderr_text or "(empty)",
            )
            yield {
                "event": "error",
                "message": f"binary exited with code {exit_code}",
                "stage": "subprocess",
                "stderr_tail": stderr_text,
            }

    finally:
        if cfg.cleanup_temp:
            try:
                shutil.rmtree(tmp, ignore_errors=True)
                log.debug(f"cleanup temp dir {tmp}")
            except Exception:  # noqa: BLE001
                log.exception(f"failed to cleanup {tmp}")


def detect_model_hint(model_path_or_id: str) -> str:
    """Heuristique : devine le model_hint depuis le nom du modèle."""
    m = model_path_or_id.lower()
    for k in ("gemma", "llama", "qwen", "mistral", "phi", "mixtral"):
        if k in m:
            return k
    return "unknown"
