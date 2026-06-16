"""AtlasManager — coordination du module atlas.

Owns config + lock pour sérialiser les extractions. Délègue le boulot lourd à
`llama-extract-vector` (binaire C++ Vulkan natif) via le wrapper subprocess
dans `atlas.extractor`.

Pattern v0.2 (post-pivot natif 2026-05-20) :
- atlas.manager : orchestration async + streaming progress + lifecycle
- atlas.extractor : spawn binaire C++, parse stdout NDJSON, yield events
- atlas.compute / atlas.exporter : stubs deprecated (logique en C++)
- atlas.routes : HTTP endpoints (contrat inchangé vs v0.1)
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import logging
import re
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator

from atlas.extractor import (
    ExtractorConfig,
    detect_model_hint,
    resolve_binary,
    run_extract,
)

log = logging.getLogger("brain.atlas.manager")


# ─── thinking extraction ──────────────────────────────────────────────────
# Port direct de MASTERMIND/packages/backend/.../thinkAnswerFSM.ts splitThinkAndAnswer().
# Couvre les patterns "thinking" qu'on rencontre en prod :
#   - <think>...</think>      (Qwen 3.6, DeepSeek, standard récent)
#   - <|channel>thought ... <channel|>  (Gemma 4 IT, channel format)
# Plus tolérance pour un bloc unclosed en fin (génération coupée par max_tokens
# en plein thinking → on capture quand même le contenu partial).
#
# Conventions :
#   - Plusieurs blocs fermés sont concaténés avec "\n\n"
#   - L'output retourné est le texte hors blocs thinking, trimmé
#   - Si aucun bloc détecté, output = texte d'origine, thinking = None
_THINK_PATTERNS: list[tuple[re.Pattern[str], re.Pattern[str]]] = [
    # (capture pattern, unclosed-trailing pattern)
    (
        re.compile(r"<think>([\s\S]*?)</think>", re.IGNORECASE),
        re.compile(r"<think>([\s\S]*)$", re.IGNORECASE),
    ),
    (
        re.compile(r"<\|channel>thought([\s\S]*?)<channel\|>"),
        re.compile(r"<\|channel>thought([\s\S]*)$"),
    ),
]


def _split_think_and_answer(text: str) -> tuple[str | None, str]:
    """Extract reasoning blocks from raw model output.

    Returns (thinking, answer). thinking is None if no block detected.
    """
    if not text:
        return None, text
    reasoning_parts: list[str] = []
    answer = text
    # Pass 1 : capture tous les blocs fermés, pour chaque pattern connu.
    for closed_re, _unclosed_re in _THINK_PATTERNS:
        def _collect(m: re.Match[str]) -> str:
            reasoning_parts.append(m.group(1).strip())
            return ""
        answer = closed_re.sub(_collect, answer)
    # Pass 2 : tolère un bloc unclosed trailing (génération coupée).
    # On le cherche pour chaque pattern et on garde le 1er match (typiquement
    # un seul bloc unclosed possible en fin de stream).
    for _closed_re, unclosed_re in _THINK_PATTERNS:
        m = unclosed_re.search(answer)
        if m:
            reasoning_parts.append(m.group(1).strip())
            answer = answer[: m.start()].rstrip()
            break
    if reasoning_parts:
        return "\n\n".join(p for p in reasoning_parts if p), answer.strip()
    return None, text.strip()


@dataclass
class AtlasConfig:
    enabled: bool = False
    output_dir: Path = field(default_factory=lambda: Path("/var/lib/atlas/vectors"))
    extractor_binary: str | None = None
    test_binary: str | None = None  # llama-cli pour /atlas/test
    default_ngl: int = 99
    default_threads: int = 8
    test_timeout_sec: int = 600  # cold load 31B (~60s) + génération 256 tokens → 180s trop court
    cleanup_temp_files: bool = True
    serialize_extractions: bool = True


class AtlasManager:
    def __init__(self, config: dict, brain_manager: Any | None = None):
        atlas_cfg = config.get("atlas", {}) or {}
        self.cfg = AtlasConfig(
            enabled=bool(atlas_cfg.get("enabled", False)),
            output_dir=Path(atlas_cfg.get("output_dir", "/var/lib/atlas/vectors")),
            extractor_binary=atlas_cfg.get("extractor_binary"),
            test_binary=atlas_cfg.get("test_binary"),
            default_ngl=int(atlas_cfg.get("default_ngl", 99)),
            default_threads=int(atlas_cfg.get("default_threads", 8)),
            test_timeout_sec=int(atlas_cfg.get("test_timeout_sec", 600)),
            cleanup_temp_files=bool(atlas_cfg.get("cleanup_temp_files", True)),
            serialize_extractions=bool(atlas_cfg.get("serialize_extractions", True)),
        )
        self.brain_manager = brain_manager  # référence ModelManager (pour stop chat éventuel pendant extraction)
        self._extract_lock = asyncio.Lock()
        self._test_lock = asyncio.Lock()  # sérialise les /atlas/test (chaque appel load le modèle, parallèle = OOM)
        self._current_job: dict[str, Any] | None = None

        if self.cfg.enabled:
            self.cfg.output_dir.mkdir(parents=True, exist_ok=True)
            # Probe binary at init pour fail-fast si pas installé
            try:
                resolved = resolve_binary(self.cfg.extractor_binary)
                log.info(f"AtlasManager — binary resolved: {resolved}")
            except FileNotFoundError as e:
                log.warning(
                    f"AtlasManager initialized but extractor binary not found: {e}. "
                    "Extractions will fail until the binary is installed."
                )
        log.info(f"AtlasManager initialized — enabled={self.cfg.enabled}")

    def is_enabled(self) -> bool:
        return self.cfg.enabled

    def current_job(self) -> dict[str, Any] | None:
        return self._current_job

    async def extract_stream(
        self, payload: dict[str, Any]
    ) -> AsyncIterator[dict[str, Any]]:
        """Streaming generator yielding events for a single extract run.

        Payload attendu :
            {
              "model": "<path/to/model.gguf>",   # quant existant, .gguf
              "dataset": {"name": "...", "pairs": [{"pos":..., "neg":...}, ...]},
              "layer": 25,
              "ngl": 99,                          # optional override
              "threads": 8,                       # optional override
              "method": "diff-of-means",          # optional
              "probe_eval": true,                 # optional
              "max_pairs": null,                  # optional
              "seed": null,                       # optional
              "model_hint": null                  # optional, sinon auto-detect depuis path
            }

        Events yieldés (qui passeront à atlasmind via Mercury streaming NDJSON) :
            {"event":"queued","job_id":"..."}
            {"event":"writing_prompts","tmp_dir":"..."}
            {"event":"spawning","binary":"...","args":[...]}
            {"event":"loaded","n_layers":N,"hidden_dim":N}
            {"event":"progress","label":"pos|neg","done":N,"total":M}
            {"event":"computing"} / {"event":"exporting"}
            {"event":"subprocess_done","exit_code":N}
            {"event":"result","vector_bytes_b64":"...","metadata":{...}}
            {"event":"error","message":"...","stage":"..."}
        """
        if not self.is_enabled():
            yield {"event": "error", "message": "atlas module disabled in config", "stage": "init"}
            return

        job_id = uuid.uuid4().hex[:12]
        yield {"event": "queued", "job_id": job_id}

        async with self._extract_lock if self.cfg.serialize_extractions else _NullCtx():
            self._current_job = {
                "job_id": job_id,
                "model": payload.get("model"),
                "started_at": time.time(),
            }
            try:
                async for ev in self._do_extract(payload, job_id):
                    yield ev
            finally:
                self._current_job = None

    async def _do_extract(
        self, payload: dict[str, Any], job_id: str
    ) -> AsyncIterator[dict[str, Any]]:
        # 1. Validate payload
        model_path = payload.get("model")
        if not model_path:
            yield {"event": "error", "message": "missing 'model' in payload", "stage": "init"}
            return
        dataset = payload.get("dataset") or {}
        pairs = dataset.get("pairs", [])
        if not pairs:
            yield {"event": "error", "message": "dataset has no pairs", "stage": "init"}
            return
        layer = payload.get("layer")
        if layer is None:
            yield {"event": "error", "message": "missing 'layer' in payload", "stage": "init"}
            return

        # 2. Resolve binary
        try:
            binary_path = resolve_binary(self.cfg.extractor_binary)
        except FileNotFoundError as e:
            yield {"event": "error", "message": str(e), "stage": "init"}
            return

        # 3. Build ExtractorConfig
        dataset_name = dataset.get("name", "unnamed")
        model_hint = payload.get("model_hint") or detect_model_hint(model_path)
        out_name = (
            f"{dataset_name}_{Path(model_path).stem.replace('.', '_')}"
            f"_l{int(layer)}_{job_id}.gguf"
        )
        out_path = self.cfg.output_dir / out_name

        cfg = ExtractorConfig(
            binary_path=binary_path,
            model_path=model_path,
            layer=int(layer),
            output_path=out_path,
            model_hint=model_hint,
            dataset_name=dataset_name,
            method=payload.get("method", "diff-of-means"),
            ngl=int(payload.get("ngl", self.cfg.default_ngl)),
            threads=int(payload.get("threads", self.cfg.default_threads)),
            probe_eval=bool(payload.get("probe_eval", True)),
            max_pairs=payload.get("max_pairs"),
            seed=payload.get("seed"),
            cleanup_temp=self.cfg.cleanup_temp_files,
        )

        # 4. Stream events from binary, intercept "done" pour matérialiser le résultat
        done_event: dict[str, Any] | None = None
        had_error = False
        t_start = time.time()
        async for ev in run_extract(cfg, pairs):
            etype = ev.get("event")
            elapsed = time.time() - t_start
            if etype == "writing_prompts":
                log.info("[extract %s] writing prompts to %s", job_id, ev.get("tmp_dir"))
            elif etype == "spawning":
                log.info("[extract %s] spawning binary: %s", job_id, ev.get("binary"))
            elif etype == "loaded":
                log.info(
                    "[extract %s] model loaded — n_layers=%s hidden_dim=%s (%.1fs)",
                    job_id, ev.get("n_layers"), ev.get("hidden_dim"), elapsed,
                )
            elif etype == "progress":
                log.info(
                    "[extract %s] progress %s: %s/%s (%.1fs)",
                    job_id, ev.get("label"), ev.get("done"), ev.get("total"), elapsed,
                )
            elif etype == "computing":
                log.info("[extract %s] computing direction vector (%.1fs)", job_id, elapsed)
            elif etype == "exporting":
                log.info("[extract %s] exporting GGUF (%.1fs)", job_id, elapsed)
            elif etype == "subprocess_done":
                log.info(
                    "[extract %s] subprocess done exit_code=%s (%.1fs)",
                    job_id, ev.get("exit_code"), elapsed,
                )
            elif etype == "done":
                done_event = ev
                log.info(
                    "[extract %s] done — probe_acc=%s cosine=%s norm=%s (%.1fs total)",
                    job_id,
                    ev.get("probe_accuracy"),
                    ev.get("cosine_pos_neg"),
                    ev.get("vector_norm"),
                    elapsed,
                )
                continue
            elif etype == "error":
                had_error = True
                log.error(
                    "[extract %s] error stage=%s: %s",
                    job_id, ev.get("stage"), ev.get("message"),
                )
            yield ev

        if had_error:
            # error event déjà yieldé, on s'arrête
            return

        if not done_event:
            yield {
                "event": "error",
                "message": "binary exited without emitting 'done' event",
                "stage": "post",
            }
            return

        # 5. Read .gguf bytes + b64-encode pour transport inline via Mercury
        if not out_path.exists():
            yield {
                "event": "error",
                "message": f"binary reported done but {out_path} doesn't exist",
                "stage": "post",
            }
            return

        with open(out_path, "rb") as f:
            gguf_bytes = f.read()
        b64 = base64.b64encode(gguf_bytes).decode("ascii")
        sha = hashlib.sha256(gguf_bytes).hexdigest()

        # Re-emit metadata enrichie pour atlasmind (compatible v0.1 contract)
        metadata = {
            "layer": int(layer),
            "hidden_dim": done_event.get("hidden_dim"),
            "n_layers": done_event.get("n_layers"),
            "probe_accuracy": done_event.get("probe_accuracy"),
            "vector_norm": done_event.get("vector_norm"),
            "delta_norm": done_event.get("delta_norm"),
            "cosine_pos_neg": done_event.get("cosine_pos_neg"),
            "model_hint": model_hint,
            "method": cfg.method,
            "n_pairs": done_event.get("n_pairs", len(pairs)),
            "bad_count": done_event.get("bad_count", 0),
            "sha256": sha if sha == done_event.get("sha256") else done_event.get("sha256", sha),
            "model_id_source": model_path,
            "vector_path_remote": str(out_path),
        }
        yield {
            "event": "result",
            "vector_bytes_b64": b64,
            "metadata": metadata,
            "size_bytes": len(gguf_bytes),
        }

    async def test_steering(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Inférence avec control vectors appliqués via `llama-cli`.

        Payload :
            {
              "model": "/path/to/model.gguf",
              "prompt": "...",
              "vectors": [{"path": "/path/to/vec.gguf", "alpha": 2.5, "layer": 25}, ...],
              "max_tokens": 200,
              "seed": 42  // optional
            }

        Implémentation : spawn `llama-cli` (du même fork atomic-turboquant que
        llama-extract-vector) avec `--control-vector-scaled <path> <alpha>` pour
        chaque vecteur. Capture stdout, retourne le texte généré.

        Note : chaque appel reload le modèle, donc ~10-60s d'overhead. Pour
        un vrai workflow productif il faudrait un slot persistant, mais pour
        valider un vecteur 1-2 fois c'est OK.
        """
        import time as _time

        model = payload.get("model")
        prompt = payload.get("prompt")
        vectors = payload.get("vectors", []) or []
        max_tokens = int(payload.get("max_tokens", 200))
        seed = payload.get("seed")
        # Knobs diagnostic (defaults conservateurs côté brain — l'UI atlasmind
        # surcharge avec ses propres defaults orientés repro/A-B testing).
        temperature = payload.get("temperature")  # None = utilise default binaire
        top_p = payload.get("top_p")              # None = default binaire (0.9)
        top_k = payload.get("top_k")              # None = default binaire (40)
        repeat_penalty = payload.get("repeat_penalty")  # None = default 1.0
        use_jinja = payload.get("jinja", True)    # True par défaut (chat template embarqué)
        explicit_binary = payload.get("binary")  # path explicite côté client
        if not model or not prompt:
            return {"error": "model + prompt requis"}

        # Résolution binaire : on cible `llama-completion` (non-interactif, stdout
        # = texte pur). `llama-cli` marche aussi mais pollue stdout avec bannière
        # ASCII / spinner / menu / stats perf → faut parser, fragile.
        # Si l'utilisateur passe explicitement un `binary` ou config `test_binary`,
        # on respecte son choix (échappatoire).
        bin_path: str | None = None
        is_completion_binary = True  # heuristique : si le path contient "llama-cli"
                                     # on adapte les flags (single-turn etc.)
        if explicit_binary:
            if not Path(explicit_binary).exists():
                return {
                    "error": (
                        f"binary explicitement demandé n'existe pas sur brain : "
                        f"{explicit_binary}"
                    )
                }
            bin_path = explicit_binary
            is_completion_binary = "llama-completion" in Path(explicit_binary).name
        else:
            candidates: list[str] = []
            if self.cfg.test_binary:
                candidates.append(self.cfg.test_binary)
            # llama-completion d'abord (binaire propre), llama-cli en fallback
            candidates += [
                "/opt/llama-native-turboquant/bin/llama-completion",
                "/opt/llama-native/bin/llama-completion",
                "/opt/llamacpp-atlas/build/bin/llama-completion",
                "/opt/llama-native-turboquant/bin/llama-cli",
                "/opt/llama-native/bin/llama-cli",
                "/opt/llamacpp-atlas/build/bin/llama-cli",
            ]
            if self.cfg.extractor_binary:
                ext_parent = Path(self.cfg.extractor_binary).parent
                candidates.append(str(ext_parent / "llama-completion"))
                candidates.append(str(ext_parent / "llama-cli"))
            tried: list[str] = []
            for cand in candidates:
                tried.append(cand)
                if Path(cand).exists():
                    bin_path = cand
                    is_completion_binary = "llama-completion" in Path(cand).name
                    break
            if not bin_path:
                return {
                    "error": (
                        "no test binary found. Tried (in order):\n"
                        + "\n".join(f"  - {p}" for p in tried)
                        + "\n\nFix : installer `llama-completion` ou `llama-cli` "
                        "ou set `atlas.test_binary` dans brain/config.yaml."
                    )
                }
        log.info(
            "test_steering: using binary %s (mode=%s)",
            bin_path, "completion" if is_completion_binary else "cli-interactive",
        )

        args = [
            bin_path,
            "-m", str(model),
            "-n", str(max_tokens),
            "-p", str(prompt),
            "-ngl", str(self.cfg.default_ngl),
            "-t", str(self.cfg.default_threads),
            "--no-warmup",
            "--no-display-prompt",
        ]
        # --jinja optionnel pour diagnostic : sur les modèles très alignés
        # (Gemma 4 IT) le chat template peut écraser l'effet d'un control vector
        # → toggler off pour tester en complétion pure et voir si le vecteur
        # reprend la main.
        if use_jinja:
            args += ["--jinja"]
        if not is_completion_binary:
            # llama-cli : exit après la 1re réponse, sinon boucle chat interactif
            args += ["--single-turn"]
        if seed is not None:
            args += ["-s", str(int(seed))]
        if temperature is not None:
            # llama-completion accepte --temp <float>. À 0 = greedy déterministe
            # (utile pour A/B test fair — sans seed mais sans sampling noise).
            args += ["--temp", str(float(temperature))]
        if top_p is not None:
            args += ["--top-p", str(float(top_p))]
        if top_k is not None:
            args += ["--top-k", str(int(top_k))]
        if repeat_penalty is not None:
            args += ["--repeat-penalty", str(float(repeat_penalty))]
        # Format : --control-vector-scaled FNAME:SCALE (un seul arg, colon-séparé).
        # Les deux binaires llama-native et turboquant utilisent ce format.
        bad_vectors: list[str] = []
        for v in vectors:
            path = v.get("path")
            alpha = v.get("alpha")
            if not path or alpha is None:
                return {"error": f"vector entry invalide : {v}"}
            if not Path(path).exists():
                bad_vectors.append(path)
                continue
            args += ["--control-vector-scaled", f"{path}:{float(alpha)}"]
        if bad_vectors:
            return {
                "error": (
                    "control vector file(s) introuvable(s) sur la machine brain :\n"
                    + "\n".join(f"  - {p}" for p in bad_vectors)
                    + "\n\nFix : ré-extraire le(s) vecteur(s) ou vérifier "
                    "atlas.output_dir côté brain."
                ),
            }

        # LoRA adapter — passé comme --lora si présent dans le payload
        lora_path = payload.get("lora_path")
        lora_scale = float(payload.get("lora_scale") or 1.0)
        if lora_path:
            lora_p = Path(lora_path)
            if not lora_p.exists():
                return {"error": f"LoRA file introuvable sur la machine brain : {lora_path}"}
            # Fork atomic-turboquant : --lora-scaled FNAME:SCALE (colon, 1 arg).
            # Même convention que --control-vector-scaled PATH:SCALE.
            # Supports comma-separated pour multi-LoRA : FNAME1:S1,FNAME2:S2
            args += ["--lora-scaled", f"{lora_p}:{lora_scale}"]
            log.info("test_steering: LoRA adapter: %s scale=%.2f", lora_path, lora_scale)

        async with self._test_lock:
            return await self._test_steering_impl(bin_path, args, model, vectors, max_tokens)

    async def _test_steering_impl(
        self,
        bin_path: str,
        args: list[str],
        model: Any,
        vectors: list,
        max_tokens: int,
    ) -> dict[str, Any]:
        import time as _time

        log.info(
            "test_steering: spawn %s (model=%s, %d vectors, max_tokens=%d)",
            bin_path, model, len(vectors), max_tokens,
        )
        log.info("test_steering: full args: %s", " ".join(args))
        t0 = _time.perf_counter()
        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as e:
            return {"error": f"binary spawn failed: {e}"}

        stdout_chunks: list[bytes] = []
        stderr_lines: list[str] = []

        async def _drain_stderr() -> None:
            assert proc.stderr is not None
            while True:
                line = await proc.stderr.readline()
                if not line:
                    return
                decoded = line.decode("utf-8", "replace").rstrip()
                if decoded:
                    stderr_lines.append(decoded)
                    log.info("[llama-cli] %s", decoded)

        async def _drain_stdout() -> None:
            assert proc.stdout is not None
            while True:
                chunk = await proc.stdout.read(65536)
                if not chunk:
                    return
                stdout_chunks.append(chunk)

        stderr_task = asyncio.create_task(_drain_stderr())
        stdout_task = asyncio.create_task(_drain_stdout())

        timed_out = False
        try:
            await asyncio.wait_for(
                asyncio.gather(proc.wait(), stderr_task, stdout_task),
                timeout=self.cfg.test_timeout_sec,
            )
        except asyncio.TimeoutError:
            timed_out = True
            proc.kill()
            try:
                await asyncio.wait_for(proc.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                pass
            stderr_task.cancel()
            stdout_task.cancel()

        elapsed_ms = int((_time.perf_counter() - t0) * 1000)

        if timed_out:
            log.warning(
                "test_steering: timeout after %ss (%.1fs elapsed). "
                "stderr tail:\n%s",
                self.cfg.test_timeout_sec,
                elapsed_ms / 1000,
                "\n".join(stderr_lines[-10:]) or "(empty)",
            )
            return {
                "error": (
                    f"llama-cli timeout after {self.cfg.test_timeout_sec}s "
                    f"(load + generation). Si le modèle est gros, augmente "
                    f"atlas.test_timeout_sec"
                ),
                "stderr_tail": "\n".join(stderr_lines[-20:]),
                "elapsed_ms": elapsed_ms,
            }

        if proc.returncode != 0:
            # Tail plus large : sur OOM / model load failure, l'info utile peut être
            # dans les ~100 premières lignes (ggml ctx, model arch dump). On garde
            # head + tail pour avoir les deux sans flooder.
            head = stderr_lines[:30]
            tail = stderr_lines[-70:] if len(stderr_lines) > 100 else stderr_lines[30:]
            err_dump = "\n".join(head + (["... [snip] ..."] if tail and len(stderr_lines) > 100 else []) + tail)
            log.warning(
                "test_steering: llama-cli exited code %s (%.1fs). stderr (%d lines):\n%s",
                proc.returncode, elapsed_ms / 1000, len(stderr_lines), err_dump or "(empty)",
            )
            return {
                "error": f"llama-cli exit {proc.returncode}",
                "stderr_tail": err_dump,
                "elapsed_ms": elapsed_ms,
            }

        output = b"".join(stdout_chunks).decode("utf-8", "replace").strip()
        # llama-completion imprime "> EOF by user" sur stdout quand stdin se ferme
        if output.endswith("> EOF by user"):
            output = output[: -len("> EOF by user")].rstrip()
        # Split reasoning/answer — port direct de MASTERMIND splitThinkAndAnswer()
        # (cf packages/backend/src/modules/telegram/stream/thinkAnswerFSM.ts).
        # Couvre les 2 formats observés en prod :
        #   - Gemma 4 : <|channel>thought ... <channel|>
        #   - Qwen 3.6 / DeepSeek / standard : <think> ... </think>
        # Logique : capture tous les blocs fermés + tolère un bloc <think> unclosed
        # en fin (génération coupée par max_tokens en plein thinking).
        thinking, output = _split_think_and_answer(output)
        log.info(
            "test_steering: done — %d chars output, %d vectors, %.1fs",
            len(output), len(vectors), elapsed_ms / 1000,
        )
        return {
            "output": output,
            "thinking": thinking,
            "elapsed_ms": elapsed_ms,
            "model": str(model),
            "n_vectors": len(vectors),
        }


class _NullCtx:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False
