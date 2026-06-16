import asyncio
import json
import logging
import os
import re
import shlex
import signal
import socket
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import httpx

logger = logging.getLogger("brain-daemon.manager")


def _hf_dir_is_complete(parent: Path) -> bool:
    """Vrai si le repo HF est complètement téléchargé (config + tous les shards).

    Évite d'exposer un repo en cours de download (cf scan_models race) :
    - HF multi-shard a `model.safetensors.index.json` qui référence tous les shards
      via weight_map → on vérifie que tous les fichiers nommés existent.
    - Mono-shard : un seul `model.safetensors` suffit (pas d'index.json généré).
    On lit le marqueur de complétude `.download_complete` du downloader si présent
    (futur-proof — actuellement le downloader brain ne le pose pas systématiquement).
    """
    if (parent / ".download_complete").is_file():
        return True
    if not (parent / "config.json").is_file():
        return False
    safetensors = list(parent.glob("*.safetensors"))
    if not safetensors:
        return False
    index = parent / "model.safetensors.index.json"
    if index.is_file():
        try:
            data = json.loads(index.read_text(encoding="utf-8"))
            expected = set(data.get("weight_map", {}).values())
            existing = {f.name for f in safetensors}
            return bool(expected) and expected.issubset(existing)
        except Exception:
            return False
    # Pas d'index → mono-shard (le seul .safetensors présent suffit).
    return True


@dataclass
class ModelInstance:
    model_id: str
    gguf_path: str
    port: int
    ctx_size: int
    toolbox_name: str = ""
    backend_type: str = ""           # "toolbox" | "native" | "vllm-toolbox"
    process: Optional[asyncio.subprocess.Process] = None
    ready: bool = False       # True une fois que le serveur HTTP répond
    loading_pct: int = 0      # 0-99 pendant le chargement, 100 quand prêt
    prompt_pct: int = 0       # 1-99 pendant le prompt processing, 0 sinon
    thermal_stopped: bool = False  # True when SIGSTOP by thermal controller
    last_inference_ts: float = 0.0       # time.time() du dernier forward (LRU)
    protected: bool = False               # True = exclu de l'eviction auto memoire
    vram_delta_mb: float = 0.0           # VRAM consommee (delta sysfs mesure au load)
    ram_delta_mb: float = 0.0            # RAM consommee (delta systeme mesure au load)
    ram_rss_mb: float = 0.0              # RAM mesuree (RSS process, debug only)
    ram_estimated_mb: float = 0.0        # RAM estimee (fallback si pas de delta)
    kv_cache_auto_dump: bool = False     # Sauver KV cache avant eviction
    load_order: int = 0                  # Ordre de chargement (1er, 2eme...)
    log_buffer: deque = field(default_factory=lambda: deque(maxlen=2000))
    _log_subscribers: list = field(default_factory=list)
    _log_task: Optional[asyncio.Task] = None

    @property
    def base_url(self):
        return f"http://127.0.0.1:{self.port}"

    @property
    def is_running(self):
        return self.process is not None and self.process.returncode is None

    def subscribe_logs(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=500)
        self._log_subscribers.append(q)
        return q

    def unsubscribe_logs(self, q: asyncio.Queue):
        try:
            self._log_subscribers.remove(q)
        except ValueError:
            pass


class ModelManager:
    def __init__(self, config: dict):
        self.models_path = Path(config["models_path"]).expanduser()
        self.toolbox_name = config["toolbox_name"]
        self.native_vulkan_binary = config.get("native_vulkan_binary", "/opt/llama-native/bin/llama-server")
        self.base_port = config.get("base_port", 11430)
        self.default_ctx = config.get("default_context", 32768)
        self.default_extra_args = config.get("default_extra_args", [])
        self.run_as_user = config.get("run_as_user", "")
        # HuggingFace cache : optionnel — si configuré, scan_models walk aussi
        # `hub/models--<org>--<name>/snapshots/<sha>/` (layout standard HF cache)
        # en plus de models_path. Permet à un user qui a `huggingface-cli download`
        # ou snapshot_download dans ~/.cache/huggingface/hub d'avoir ses repos
        # exposés comme kind=hf sans devoir symlink dans models_path.
        # Default : respecte $HF_HOME/$HUGGINGFACE_HUB_CACHE, sinon ~/.cache/huggingface/hub.
        hf_cache_raw = config.get("hf_cache_path")
        if hf_cache_raw:
            self.hf_cache_path: Optional[Path] = Path(hf_cache_raw).expanduser()
        else:
            env_hub = os.environ.get("HUGGINGFACE_HUB_CACHE") or os.environ.get("HF_HUB_CACHE")
            if env_hub:
                self.hf_cache_path = Path(env_hub).expanduser()
            else:
                env_home = os.environ.get("HF_HOME")
                self.hf_cache_path = (
                    (Path(env_home).expanduser() / "hub") if env_home
                    else (Path.home() / ".cache" / "huggingface" / "hub")
                )
        self.instances: dict[str, ModelInstance] = {}
        self._used_ports: set[int] = set()
        kv_cache_dir_raw = config.get("kv_cache_dir", "")
        if kv_cache_dir_raw:
            self.kv_cache_dir: Optional[Path] = Path(kv_cache_dir_raw).expanduser().resolve()
            self.kv_cache_dir.mkdir(parents=True, exist_ok=True)
        else:
            self.kv_cache_dir = None

    def _safe_model_id(self, model_id: str) -> str:
        """Convertit un model_id en nom de fichier sûr (remplace / et \\ par _)."""
        return re.sub(r'[/\\]', '_', model_id)

    def kv_cache_path(self, model_id: str) -> Optional[Path]:
        """Retourne le chemin du fichier KV cache pour ce modèle, ou None si kv_cache_dir non configuré."""
        if not self.kv_cache_dir:
            return None
        return self.kv_cache_dir / f"{self._safe_model_id(model_id)}_slot0.bin"

    def kv_cache_exists(self, model_id: str) -> bool:
        """True si un fichier KV cache sauvegardé existe pour ce modèle."""
        p = self.kv_cache_path(model_id)
        return p is not None and p.exists()

    def delete_kv_cache(self, model_id: str) -> bool:
        """Supprime le fichier KV cache du modèle. Retourne True si supprimé."""
        p = self.kv_cache_path(model_id)
        if p and p.exists():
            p.unlink()
            return True
        return False

    def _port_is_free(self, port: int) -> bool:
        """Verifie que le port est reellement libre sur l'OS (pas juste dans notre tracking)."""
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(("127.0.0.1", port))
                return True
        except OSError:
            return False

    def _next_port(self) -> int:
        """Cherche le prochain port libre a partir de base_port.
        Cap a 100 tentatives pour eviter une boucle infinie si aucun port n'est libre."""
        port = self.base_port
        for _ in range(100):
            if port not in self._used_ports and self._port_is_free(port):
                self._used_ports.add(port)
                return port
            port += 1
        raise RuntimeError(
            f"Aucun port libre trouve dans la plage {self.base_port}-{self.base_port + 100}"
        )

    def scan_models(self) -> list[dict]:
        models = []
        # Dedup par (id, kind) pour autoriser coexistence GGUF + HF même nom de
        # repo (cas réel : downloader user récupère .gguf ET dossier HF du même
        # repo). Si on dédupliquait par id seul, le HF disparaissait silencieusement.
        seen_keys: set[tuple[str, str]] = set()
        # ── GGUF models (llama.cpp) ────────────────────────────────────────────
        for gguf in sorted(self.models_path.rglob("*.gguf")):
            name = gguf.name.lower()
            if any(x in name for x in ["mmproj", "projector", "clip"]):
                continue
            shard_match = re.search(r"-(\d{5})-of-(\d{5})\.gguf$", gguf.name, re.IGNORECASE)
            if shard_match:
                if shard_match.group(1) != "00001":
                    continue
                model_id = re.sub(r"-00001-of-\d{5}\.gguf$", "", str(gguf.relative_to(self.models_path)))
            else:
                model_id = str(gguf.relative_to(self.models_path).with_suffix(""))
            key = (model_id, "gguf")
            if key in seen_keys:
                continue
            seen_keys.add(key)
            instance = self.instances.get(model_id)
            models.append({
                "id": model_id,
                "kind": "gguf",
                "path": str(gguf),
                "size_gb": round(self._model_total_size(gguf) / 1e9, 2),
                "running": bool(instance and instance.is_running and instance.backend_type != "vllm-toolbox"),
                "port": instance.port if (instance and instance.is_running and instance.backend_type != "vllm-toolbox") else None,
                "ctx_size": instance.ctx_size if (instance and instance.is_running and instance.backend_type != "vllm-toolbox") else None,
            })
        # ── HuggingFace dirs (vLLM) ────────────────────────────────────────────
        # Repo HF = directory avec config.json + au moins un .safetensors + le
        # marqueur de complétude `.download_complete` posé par le downloader
        # (sinon on expose un repo en cours de téléchargement → vllm serve crash).
        # Blacklist nom de dossier sur les patterns vision/projector pour rester
        # cohérent avec le filtre GGUF (mmproj/projector/clip).
        _HF_BLACKLIST = ("mmproj", "projector", "clip", "vision_encoder")
        for cfg_json in sorted(self.models_path.rglob("config.json")):
            parent = cfg_json.parent
            try:
                if not _hf_dir_is_complete(parent):
                    # Repo en cours de download ou shards manquants → ne pas exposer
                    # (vllm serve crasherait au load).
                    continue
            except OSError:
                continue
            rel = str(parent.relative_to(self.models_path)).replace(os.sep, "/")
            rel_lower = rel.lower()
            if any(b in rel_lower for b in _HF_BLACKLIST):
                continue
            model_id = rel
            key = (model_id, "hf")
            if key in seen_keys:
                continue
            seen_keys.add(key)
            instance = self.instances.get(model_id)
            try:
                size_bytes = sum(p.stat().st_size for p in parent.glob("*.safetensors"))
            except OSError:
                size_bytes = 0
            models.append({
                "id": model_id,
                "kind": "hf",
                "path": str(parent),
                "size_gb": round(size_bytes / 1e9, 2),
                "running": bool(instance and instance.is_running and instance.backend_type == "vllm-toolbox"),
                "port": instance.port if (instance and instance.is_running and instance.backend_type == "vllm-toolbox") else None,
                "ctx_size": instance.ctx_size if (instance and instance.is_running and instance.backend_type == "vllm-toolbox") else None,
            })
        # ── HuggingFace cache standard (~/.cache/huggingface/hub par défaut) ──
        # Layout HF : `models--<org>--<name>/snapshots/<sha>/<files>` avec les
        # fichiers en symlinks vers `blobs/`. On résout le snapshot actif via
        # refs/main, on traite le repo comme un dir HF normal côté complétude
        # et taille. Permet à un user qui télécharge via `huggingface-cli` ou
        # `snapshot_download` d'avoir ses repos exposés sans symlink manuel.
        if self.hf_cache_path and self.hf_cache_path.is_dir():
            try:
                hub_entries = sorted(self.hf_cache_path.glob("models--*"))
            except OSError:
                hub_entries = []
            for hub_dir in hub_entries:
                if not hub_dir.is_dir():
                    continue
                # `models--<org>--<name>` → repo_id `<org>/<name>`. Format HF :
                # le séparateur entre org et name est `--`, et name peut contenir
                # `--` lui-même (rare). On split sur le PREMIER `--` après préfixe.
                stem = hub_dir.name[len("models--"):] if hub_dir.name.startswith("models--") else hub_dir.name
                if "--" not in stem:
                    continue
                org, name = stem.split("--", 1)
                model_id = f"{org}/{name}"
                key = (model_id, "hf")
                if key in seen_keys:
                    continue
                snap = self._hf_cache_active_snapshot(hub_dir)
                if not snap:
                    continue
                if not (snap / "config.json").is_file():
                    continue
                try:
                    if not _hf_dir_is_complete(snap):
                        continue
                except OSError:
                    continue
                # Blacklist nom de repo (cohérent avec scan models_path)
                _HF_BLACKLIST = ("mmproj", "projector", "clip", "vision_encoder")
                if any(b in model_id.lower() for b in _HF_BLACKLIST):
                    continue
                seen_keys.add(key)
                instance = self.instances.get(model_id)
                try:
                    size_bytes = sum(
                        p.stat().st_size for p in snap.glob("*.safetensors")
                    )
                except OSError:
                    size_bytes = 0
                models.append({
                    "id": model_id,
                    "kind": "hf",
                    "path": str(snap),
                    "size_gb": round(size_bytes / 1e9, 2),
                    "running": bool(instance and instance.is_running and instance.backend_type == "vllm-toolbox"),
                    "port": instance.port if (instance and instance.is_running and instance.backend_type == "vllm-toolbox") else None,
                    "ctx_size": instance.ctx_size if (instance and instance.is_running and instance.backend_type == "vllm-toolbox") else None,
                })
        return models

    def _model_total_size(self, gguf_path: Path) -> int:
        shard_match = re.search(r"-00001-of-(\d{5})\.gguf$", gguf_path.name)
        if not shard_match:
            return gguf_path.stat().st_size
        total = int(shard_match.group(1))
        base = re.sub(r"-00001-of-\d{5}\.gguf$", "", str(gguf_path))
        size = 0
        for i in range(1, total + 1):
            p = Path(f"{base}-{i:05d}-of-{total:05d}.gguf")
            if p.exists():
                size += p.stat().st_size
        return size

    def resolve_model_id(self, model_ref: str) -> Optional[str]:
        all_ids = [m["id"] for m in self.scan_models()]
        if model_ref in all_ids:
            return model_ref
        for mid in all_ids:
            if mid.lower() == model_ref.lower():
                return mid
        matches = [mid for mid in all_ids if model_ref.lower() in mid.lower()]
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            return min(matches, key=len)
        return None

    def _find_gguf_path(self, model_id: str) -> Optional[str]:
        direct = self.models_path / (model_id + ".gguf")
        if direct.exists():
            return str(direct)
        parent = (self.models_path / model_id).parent
        name = Path(model_id).name
        matches = list(parent.glob(f"{name}-00001-of-*.gguf"))
        if matches:
            return str(matches[0])
        return None

    def _find_hf_dir(self, model_id: str) -> Optional[str]:
        """Resolve model_id to a local HuggingFace model directory containing config.json.

        Cherche en deux endroits :
        1. models_path/<repo_id>/ — layout du downloader brain (cohérent avec GGUF)
        2. hf_cache_path/models--<org>--<name>/snapshots/<sha>/ — layout HF standard
           (huggingface-cli, snapshot_download). Le sha utilisé = `refs/main` si
           présent, sinon le snapshot le plus récent (mtime).
        """
        candidate = self.models_path / model_id
        if candidate.is_dir() and (candidate / "config.json").is_file():
            return str(candidate)
        # Fallback HF cache standard
        if "/" in model_id and self.hf_cache_path and self.hf_cache_path.is_dir():
            org, name = model_id.split("/", 1)
            hub_dir = self.hf_cache_path / f"models--{org}--{name}"
            if hub_dir.is_dir():
                snap = self._hf_cache_active_snapshot(hub_dir)
                if snap and (snap / "config.json").is_file():
                    return str(snap)
        return None

    @staticmethod
    def _hf_cache_active_snapshot(hub_dir: Path) -> Optional[Path]:
        """Retourne le snapshot 'actif' d'un repo HF cache : refs/main si présent,
        sinon le snapshot le plus récent. None si aucun snapshot valide."""
        snapshots = hub_dir / "snapshots"
        if not snapshots.is_dir():
            return None
        refs_main = hub_dir / "refs" / "main"
        if refs_main.is_file():
            try:
                sha = refs_main.read_text(encoding="utf-8").strip()
                if sha:
                    snap = snapshots / sha
                    if snap.is_dir():
                        return snap
            except OSError:
                pass
        # Fallback : plus récent par mtime
        candidates = [p for p in snapshots.iterdir() if p.is_dir()]
        if not candidates:
            return None
        return max(candidates, key=lambda p: p.stat().st_mtime)

    async def load_model(
        self,
        model_id: str,
        ctx_size: int = None,
        extra_args: list = None,
        toolbox_name: str = None,
        backend_type: str = "toolbox",
        native_binary: str = None,
        env_vars: dict | None = None,
        lucebox_draft: str | None = None,
        lucebox_server_script: str | None = None,
        lucebox_test_bin: str | None = None,
    ) -> ModelInstance:
        """Load a model under a given backend.

        For backend_type="native", `native_binary` overrides the default
        `self.native_vulkan_binary`. This lets the daemon route to multiple
        side-by-side native builds (master, DFlash PR, MTP PR, ...) referenced
        by name from `_BACKEND_MAP`.
        """
        if model_id in self.instances:
            old = self.instances[model_id]
            if old.is_running:
                return old
            # Instance morte → cleanup avant reload (libere le port leake)
            self._used_ports.discard(old.port)
            if old._log_task:
                old._log_task.cancel()
            del self.instances[model_id]

        # Resolve model location: GGUF file for llama.cpp backends, HF dir for vLLM.
        # The ModelInstance.gguf_path field carries the resolved path opaquely
        # (memory estimator gates GGUF-specific reads via try/except — HF dirs
        # degrade gracefully to "no estimate", VRAM delta still measured at load).
        if backend_type == "vllm-toolbox":
            gguf_path = self._find_hf_dir(model_id)
            if not gguf_path:
                raise ValueError(
                    f"HF model directory not found for: {model_id} "
                    f"(expected {self.models_path / model_id} with config.json)"
                )
        else:
            gguf_path = self._find_gguf_path(model_id)
            if not gguf_path:
                raise ValueError(f"GGUF file not found for: {model_id}")

        port = self._next_port()
        ctx = ctx_size or self.default_ctx
        raw = extra_args if extra_args is not None else self.default_extra_args
        # shlex-split any element that contains whitespace so Mercury's "one per
        # line" UI input ("--budget 22" on a single line) yields ["--budget","22"]
        # instead of the literal "--budget 22" token argparse rejects. Quoted
        # strings (e.g. '--system "You are X"') survive intact via shlex semantics.
        extra: list[str] = []
        for a in raw:
            if not isinstance(a, (str, int, float)):
                continue
            s = str(a)
            if not s:
                continue
            if (" " in s or "\t" in s) and s.lstrip().startswith("-"):
                # Seulement splitter les tokens qui ressemblent à "--flag value"
                # (commencent par -). Les chemins de fichiers avec espaces
                # (ex: "/home/user/loras/My Model.gguf") doivent rester intacts.
                try:
                    extra.extend(shlex.split(s))
                except ValueError:
                    # Unbalanced quotes etc → fall back to raw to surface a clear
                    # downstream error rather than silently dropping the token.
                    extra.append(s)
            else:
                extra.append(s)
        tbox = toolbox_name or self.toolbox_name
        binary = native_binary or self.native_vulkan_binary

        # Env vars normalisés en `KEY=VAL` strings, à injecter via `env` dans le toolbox
        # (sudo strip env, toolbox run inherits, mais on est sûr en passant explicitement).
        env_pairs: list[str] = []
        if env_vars and isinstance(env_vars, dict):
            for k, v in env_vars.items():
                if isinstance(k, str) and k and v is not None:
                    env_pairs.append(f"{k}={v}")

        # Build command depending on backend type
        if backend_type == "vllm-toolbox":
            # vLLM via toolbox: `toolbox run -c <vllm-tbox> [env K=V ...] vllm serve <hf-dir> ...`
            # No --slot-save-path equivalent; KV cache management is internal to vLLM.
            # `env KEY=VAL ...` prefix permet d'injecter PYTORCH_HIP_ALLOC_CONF, HF_HUB_OFFLINE, etc.
            # sans toucher au shell host (sudo strip env).
            env_prefix = ["env", *env_pairs] if env_pairs else []
            vllm_cmd = [
                "toolbox", "run", "-c", tbox,
                *env_prefix,
                "vllm", "serve", gguf_path,
                "--host", "127.0.0.1",
                "--port", str(port),
                "--max-model-len", str(ctx),
                *extra,
            ]
            if self.run_as_user:
                cmd = ["sudo", "-u", self.run_as_user, "--"] + vllm_cmd
            else:
                cmd = vllm_cmd
        elif backend_type == "native":
            base_cmd = [
                binary,
                "-m", gguf_path,
                "-c", str(ctx),
                "--host", "127.0.0.1",
                "--port", str(port),
                *extra,
            ]
            if self.kv_cache_dir:
                base_cmd += ["--slot-save-path", str(self.kv_cache_dir)]
            # Native: run as user directly (no toolbox wrapper)
            if self.run_as_user:
                cmd = ["sudo", "-u", self.run_as_user, "--"] + base_cmd
            else:
                cmd = base_cmd
        elif backend_type == "lucebox":
            # Lucebox DFlash speculative-decode server. Wraps test_dflash via a
            # Python FastAPI server.py exposing OpenAI-compatible /v1/* endpoints.
            # `binary` is the python interpreter; server_script + test_bin come
            # from the backend spec (config.yaml extra_native_backends.<name>);
            # lucebox_draft is per-model (load_configs.json).
            if not lucebox_draft:
                raise ValueError(
                    f"backend_type=lucebox requires 'lucebox_draft' for model {model_id}"
                )
            server_script = lucebox_server_script or "/opt/lucebox/dflash/scripts/server.py"
            test_bin      = lucebox_test_bin      or "/opt/lucebox/dflash/build/test_dflash"
            env_prefix = ["env", *env_pairs] if env_pairs else []
            base_cmd = [
                *env_prefix,
                binary, server_script,
                "--target",  gguf_path,
                "--draft",   lucebox_draft,
                "--bin",     test_bin,
                "--max-ctx", str(ctx),
                "--host",    "127.0.0.1",
                "--port",    str(port),
                *extra,
            ]
            # No --slot-save-path: Lucebox manages its own KV cache internally.
            if self.run_as_user:
                cmd = ["sudo", "-u", self.run_as_user, "--"] + base_cmd
            else:
                cmd = base_cmd
        else:
            toolbox_cmd = [
                "toolbox", "run", "-c", tbox, "llama-server",
                "-m", gguf_path,
                "-c", str(ctx),
                "--host", "127.0.0.1",
                "--port", str(port),
                *extra,
            ]
            if self.kv_cache_dir:
                toolbox_cmd += ["--slot-save-path", str(self.kv_cache_dir)]
            # Si on tourne en root, executer toolbox en tant que l'utilisateur configure
            if self.run_as_user:
                cmd = ["sudo", "-u", self.run_as_user, "--"] + toolbox_cmd
            else:
                cmd = toolbox_cmd

        import logging as _logging
        _logging.getLogger("llamacpp-daemon").info("load_model cmd: %s", " ".join(cmd))

        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            start_new_session=True,  # groupe de processus isolé pour kill propre
        )

        instance = ModelInstance(model_id=model_id, gguf_path=gguf_path, port=port, ctx_size=ctx, toolbox_name=tbox, backend_type=backend_type, process=process)
        self.instances[model_id] = instance
        instance._log_task = asyncio.create_task(self._stream_logs(instance))

        try:
            await self._wait_ready(instance)
            instance.ready = True  # HTTP server est prêt
        except Exception as exc:
            # Laisser le log streamer capturer les dernières lignes avant de détruire l'instance.
            # Tail volumineux : vLLM a un engine subprocess séparé du api_server, leurs deux
            # tracebacks empilés font ~150 lignes facile. 30 lignes ne capture que le wrapper
            # api_server "Engine core initialization failed" sans la cause racine.
            await asyncio.sleep(0.5)
            tail = 250 if instance.backend_type == "vllm-toolbox" else 60
            last_logs = list(instance.log_buffer)[-tail:]
            await self.unload_model(model_id)
            if last_logs:
                raise RuntimeError(
                    f"{exc}\n--- Dernières lignes du process ---\n" + "\n".join(last_logs)
                ) from exc
            raise

        return instance

    # Lignes à filtrer du log_buffer (bruit de polling interne, pas d'info utile)
    _LOG_NOISE_PATTERNS = (
        "srv  update_slots: all slots are idle",
        "srv  log_server_r: done request: GET /slots",
        "srv  log_server_r: done request: GET /health",
    )

    # Milestones de chargement → pourcentage approximatif (ordre important : du + spécifique au + générique)
    _LOAD_MILESTONES = (
        ("server is listening",        100),
        ("main: model loaded",          95),
        ("warming up",                  88),
        ("sched_reserve:",              82),
        ("llama_kv_cache:",             75),
        ("llama_context:",              68),
        ("load_tensors: offloaded",     60),
        ("load_tensors: offloading",    40),
        ("load_tensors: loading",       20),
        ("print_info: model type",      12),
        ("print_info:",                  8),
        ("llama_model_loader:",          5),
    )

    async def _stream_logs(self, instance: ModelInstance):
        log_file = Path(f"/tmp/llamacpp-{self._safe_model_id(instance.model_id)}.log")
        try:
            with open(log_file, "w") as f:
                async for line in instance.process.stdout:
                    decoded = line.decode(errors="replace").rstrip()
                    # Filtrer les lignes de polling interne pour ne pas noyer le buffer
                    if any(pat in decoded for pat in self._LOG_NOISE_PATTERNS):
                        continue
                    instance.log_buffer.append(decoded)
                    f.write(decoded + "\n")
                    f.flush()
                    if not instance.ready:
                        # Mettre à jour le pourcentage de chargement du modèle
                        for pattern, pct in self._LOAD_MILESTONES:
                            if pattern in decoded and pct > instance.loading_pct:
                                instance.loading_pct = pct
                                break
                    else:
                        # Suivre le prompt processing en cours. Deux formats supportés :
                        #   ancien (<2026)   : "srv  update_slots: ... prompt processing progress, ... progress = 0.XX"
                        #   nouveau (≥2026)  : "slot print_timing: ... | prompt processing, n_tokens = N, progress = 0.XX, t = ..."
                        # Le regex `progress\s*=\s*` cible le champ numérique commun aux deux.
                        if "prompt processing" in decoded and "progress" in decoded:
                            m = re.search(r"progress\s*=\s*([\d.]+)", decoded)
                            if m:
                                instance.prompt_pct = min(99, int(float(m.group(1)) * 100))
                        elif (
                            "prompt processing done" in decoded   # ancien marqueur fin-de-prefill
                            or "prompt eval time" in decoded      # nouveau bloc fin-de-prefill (avant génération)
                            or "slot      release:" in decoded    # fin de tâche (commun aux deux)
                        ):
                            instance.prompt_pct = 0
                    for q in list(instance._log_subscribers):
                        try:
                            q.put_nowait(decoded)
                        except asyncio.QueueFull:
                            pass
        except Exception:
            pass

    async def _wait_ready(self, instance: ModelInstance, timeout: int = 300):
        loop = asyncio.get_event_loop()
        deadline = loop.time() + timeout
        async with httpx.AsyncClient() as client:
            while loop.time() < deadline:
                if not instance.is_running:
                    raise RuntimeError(f"Process for {instance.model_id} died during startup")
                try:
                    r = await client.get(f"{instance.base_url}/health", timeout=2.0)
                    if r.status_code == 200:
                        return
                except Exception:
                    pass
                await asyncio.sleep(2)
        raise TimeoutError(f"Model {instance.model_id} did not start within {timeout}s")

    async def unload_model(self, model_id: str):
        instance = self.instances.pop(model_id, None)
        if not instance:
            raise ValueError(f"Model not loaded: {model_id}")
        self._used_ports.discard(instance.port)
        if instance._log_task:
            instance._log_task.cancel()
        if instance.process and instance.process.returncode is None:
            if instance.backend_type == "native":
                # Native: kill the process group directly (no container indirection)
                try:
                    pgid = os.getpgid(instance.process.pid)
                    os.killpg(pgid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    await asyncio.wait_for(instance.process.wait(), timeout=10)
                except asyncio.TimeoutError:
                    try:
                        pgid = os.getpgid(instance.process.pid)
                        os.killpg(pgid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            else:
                # Toolbox-shaped backend (llama.cpp or vLLM):
                # 1. Tuer le process serveur dans le container (ciblé par port).
                # vLLM spawn des workers (engine/multiproc) qui n'ont PAS `--port` dans
                # leur cmdline → pkill simple sur le pattern --port chope que le main et
                # laisse zombies + GPU lock résiduel. On fait une cascade :
                #   a. find main pid via --port
                #   b. SIGTERM ses enfants (-P) puis le main
                #   c. SIGKILL les stragglers (entrypoints, multiproc workers)
                # llama-server n'a pas ce souci — pkill direct sur llama-server.*--port.
                try:
                    tbox = instance.toolbox_name or self.toolbox_name
                    if instance.backend_type == "vllm-toolbox":
                        kill_script = (
                            f'main=$(pgrep -f "vllm.*--port {instance.port}" | head -1); '
                            f'if [ -n "$main" ]; then '
                            f'  pkill -TERM -P "$main" 2>/dev/null || true; '
                            f'  kill -TERM "$main" 2>/dev/null || true; '
                            f'  sleep 2; '
                            f'  pkill -KILL -P "$main" 2>/dev/null || true; '
                            f'  kill -KILL "$main" 2>/dev/null || true; '
                            f'fi; '
                            # Catch-all stragglers (engine workers sans --port en cmdline)
                            f'pkill -KILL -f "vllm.entrypoints" 2>/dev/null || true; '
                            f'pkill -KILL -f "vllm.engine" 2>/dev/null || true; '
                            f'true'
                        )
                        kill_cmd = ["toolbox", "run", "-c", tbox, "bash", "-c", kill_script]
                    else:
                        kill_cmd = ["toolbox", "run", "-c", tbox,
                                    "pkill", "-9", "-f", f"llama-server.*--port {instance.port}"]
                    if self.run_as_user:
                        kill_cmd = ["sudo", "-u", self.run_as_user, "--"] + kill_cmd
                    kill_proc = await asyncio.create_subprocess_exec(
                        *kill_cmd,
                        stdout=asyncio.subprocess.DEVNULL,
                        stderr=asyncio.subprocess.DEVNULL,
                    )
                    await asyncio.wait_for(kill_proc.wait(), timeout=5)
                except Exception:
                    pass
                # 2. Tuer le wrapper toolbox run côté host
                try:
                    pgid = os.getpgid(instance.process.pid)
                    os.killpg(pgid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    await asyncio.wait_for(instance.process.wait(), timeout=10)
                except asyncio.TimeoutError:
                    try:
                        pgid = os.getpgid(instance.process.pid)
                        os.killpg(pgid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    async def save_kv_cache(self, model_id: str, slot_id: int = 0) -> dict:
        """Sauvegarde l'état KV du slot via POST /slots/{slot_id} sur l'instance running."""
        instance = self.instances.get(model_id)
        if not instance or not instance.is_running:
            raise ValueError(f"Model not running: {model_id}")
        if not self.kv_cache_dir:
            raise RuntimeError("kv_cache_dir non configuré dans config.yaml")
        filename = f"{self._safe_model_id(model_id)}_slot0.bin"
        async with httpx.AsyncClient() as client:
            r = await client.post(
                f"{instance.base_url}/slots/{slot_id}",
                params={"action": "save"},
                json={"filename": filename},
                timeout=60.0,
            )
            if not r.is_success:
                raise RuntimeError(f"llama-server {r.status_code}: {r.text[:500]}")
            return {"status": "saved", "model_id": model_id, "filename": filename, "path": str(self.kv_cache_dir / filename)}

    async def restore_kv_cache(self, model_id: str, slot_id: int = 0) -> dict:
        """Restaure l'état KV du slot via POST /slots/{slot_id} sur l'instance (doit être ready)."""
        instance = self.instances.get(model_id)
        if not instance or not instance.ready:
            raise ValueError(f"Model not ready: {model_id}")
        if not self.kv_cache_dir:
            raise RuntimeError("kv_cache_dir non configuré dans config.yaml")
        filename = f"{self._safe_model_id(model_id)}_slot0.bin"
        cache_file = self.kv_cache_dir / filename
        if not cache_file.exists():
            raise FileNotFoundError(f"Fichier KV cache introuvable: {cache_file}")
        async with httpx.AsyncClient() as client:
            r = await client.post(
                f"{instance.base_url}/slots/{slot_id}",
                params={"action": "restore"},
                json={"filename": filename},
                timeout=60.0,
            )
            if not r.is_success:
                raise RuntimeError(f"llama-server {r.status_code}: {r.text[:500]}")
            return {"status": "restored", "model_id": model_id, "filename": filename}
