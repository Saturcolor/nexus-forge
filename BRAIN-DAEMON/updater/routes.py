"""Routes /updater/* — gestion des toolboxes llama.cpp (versions, update, backup, restore).
Remplace les scripts bash interactifs par une API pilotable depuis Mercury."""
import asyncio
import logging
import os
import re
from pathlib import Path
from typing import Optional

from fastapi import APIRouter
from fastapi.responses import JSONResponse

logger = logging.getLogger("brain-daemon")
router = APIRouter()

_DAEMON_DIR = Path(__file__).resolve().parent.parent

# Config toolbox (initialisee par init_updater)
_config: dict = {}
_update_in_progress = False
_update_log: list[str] = []


_run_as_user = ""


def _user_cmd(cmd: list[str]) -> list[str]:
    """Wrappe une commande avec sudo -u si run_as_user est configure."""
    if _run_as_user:
        return ["sudo", "-u", _run_as_user, "--"] + cmd
    return cmd


def init_updater(config: dict):
    global _config, _run_as_user
    _run_as_user = config.get("run_as_user", "")
    _native_binary = config.get("native_vulkan_binary", "/opt/llama-native/bin/llama-server")
    _native_prefix = str(Path(_native_binary).parent.parent)  # /opt/llama-native
    _build_script = str(_DAEMON_DIR / "build-native.sh")
    _config = {
        "vulkan": {
            "type": "toolbox",
            "toolbox_name": config.get("toolbox_name", "llama-vulkan-radv"),
            "upstream_image": "docker.io/kyuz0/amd-strix-halo-toolboxes:vulkan-radv",
            "local_image": "localhost/llama-vulkan-radv:local",
            "backup_image": "localhost/llama-vulkan-radv:backup",
            "dockerfile": str(_DAEMON_DIR / "brain tools/amd-strix-halo-toolboxes/toolboxes/Dockerfile.vulkan-radv"),
            "toolbox_args": "--device /dev/dri --group-add video --security-opt seccomp=unconfined",
        },
        "rocm": {
            "type": "toolbox",
            "toolbox_name": config.get("toolbox_rocm_name", "llama-rocm-7.2"),
            "upstream_image": "docker.io/kyuz0/amd-strix-halo-toolboxes:rocm-7.2",
            "local_image": "localhost/llama-rocm-7.2:local",
            "backup_image": "localhost/llama-rocm-7.2:backup",
            "dockerfile": str(_DAEMON_DIR / "brain tools/amd-strix-halo-toolboxes/toolboxes/Dockerfile.rocm-7.2"),
            "toolbox_args": "--device /dev/dri --device /dev/kfd --group-add video --group-add render --group-add sudo --security-opt seccomp=unconfined",
        },
        "vllm-rocm": {
            "type": "toolbox",
            "toolbox_name": config.get("toolbox_vllm_name", "vllm"),
            "upstream_image": "docker.io/kyuz0/vllm-therock-gfx1151:stable",
            "local_image": "localhost/vllm-therock-gfx1151:local",
            "backup_image": "localhost/vllm-therock-gfx1151:backup",
            # Pas de Dockerfile vendoré pour l'instant — kyuz0 ship dans un repo
            # séparé (amd-strix-halo-vllm-toolboxes). Pull marche, Build erreurera
            # tant qu'on n'a pas vendoré le Dockerfile.
            "dockerfile": "",
            "toolbox_args": "--device /dev/dri --device /dev/kfd --group-add video --group-add render --group-add sudo --security-opt seccomp=unconfined",
            "version_cmd": ["vllm", "--version"],
        },
        "native-vulkan": {
            "type": "native",
            "binary": _native_binary,
            "install_prefix": _native_prefix,
            "src_dir": f"{_native_prefix}/src/llama.cpp",
            "build_script": _build_script,
            "build_info": f"{_native_prefix}/BUILD_INFO",
            # No pr/branch → uses build-native.sh defaults (master)
        },
    }

    # Register extra native backends declared in config.yaml. Each entry maps a
    # backend name (e.g. "native-dflash") to its build settings. The build
    # script is the shared `build-native.sh`; we just pass it different
    # --prefix / --pr / --branch flags so multiple slots coexist on disk.
    extra: dict = config.get("extra_native_backends") or {}
    for name, spec in extra.items():
        if not isinstance(spec, dict):
            logger.warning("extra_native_backends.%s: not a dict, skipped", name)
            continue
        binary = spec.get("binary")
        if not binary or not isinstance(binary, str):
            logger.warning("extra_native_backends.%s: missing 'binary' string, skipped", name)
            continue
        if name in _config:
            logger.warning("extra_native_backends.%s: shadows a builtin, overriding", name)
        prefix = str(Path(binary).parent.parent)  # /opt/llama-native-dflash
        _config[name] = {
            "type": "native",
            "binary": binary,
            "install_prefix": prefix,
            "src_dir": f"{prefix}/src/llama.cpp",
            "build_script": _build_script,
            "build_info": f"{prefix}/BUILD_INFO",
            "pr": spec.get("pr"),          # int — passed to build-native.sh as --pr N
            "branch": spec.get("branch"),  # str — passed as --branch NAME (ignored if pr is set)
        }
        logger.info(
            "extra_native_backends: registered %s (binary=%s, pr=%s, branch=%s)",
            name, binary, spec.get("pr"), spec.get("branch"),
        )


async def _run(cmd: list[str], timeout: int = 600, stream_logs: bool = False) -> tuple[int, str, str]:
    """Execute une commande et retourne (returncode, stdout, stderr).
    Si stream_logs=True, chaque ligne de stdout/stderr est loggee en temps reel."""
    try:
        if not stream_logs:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
            return proc.returncode or 0, stdout.decode(errors="replace"), stderr.decode(errors="replace")

        # Streaming mode : log chaque ligne en temps reel dans les daemon logs
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        lines: list[str] = []
        try:
            async def read_output():
                assert proc.stdout is not None
                async for raw_line in proc.stdout:
                    line = raw_line.decode(errors="replace").rstrip()
                    if line:
                        lines.append(line)
                        logger.info("[updater] %s", line)

            await asyncio.wait_for(read_output(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            logger.error("[updater] timeout after %ds", timeout)
            return -1, "\n".join(lines), "timeout"
        await proc.wait()
        return proc.returncode or 0, "\n".join(lines), ""
    except asyncio.TimeoutError:
        return -1, "", "timeout"
    except Exception as e:
        return -1, "", str(e)


async def _get_llama_version(toolbox_name: str, version_cmd: list[str] | None = None) -> str:
    """Recupere la version d'un binaire serveur dans un toolbox.
    `version_cmd` override la commande par défaut `llama-server --version` (utile pour vLLM)."""
    cmd = version_cmd or ["llama-server", "--version"]
    rc, out, err = await _run(_user_cmd(["toolbox", "run", "-c", toolbox_name, *cmd]), timeout=15)
    combined = f"{out}\n{err}"
    # llama.cpp format : "version: NNNNN (sha)"
    m = re.search(r"version:\s*(\d+)\s*\(([0-9a-f]+)\)", combined)
    if m:
        return f"{m.group(1)} ({m.group(2)})"
    m = re.search(r"version:\s*(\d+)", combined)
    if m:
        return m.group(1)
    # vLLM format : "0.X.Y" — peut sortir sur stderr et/ou avec rc != 0 selon build.
    # On scan combined (out+err) au lieu de exiger rc==0 sur stdout.
    m = re.search(r"\b(\d+\.\d+\.\d+(?:\.\w+)?)\b", combined)
    if m:
        return m.group(1)
    # Dernier filet : première ligne non vide de combined.
    for line in combined.splitlines():
        line = line.strip()
        if line:
            return line[:100]
    return "unknown"


async def _get_native_version(binary: str) -> str:
    """Recupere la version d'un llama-server natif."""
    if not os.path.isfile(binary):
        return "not installed"
    rc, out, err = await _run([binary, "--version"], timeout=10)
    combined = f"{out}\n{err}"
    m = re.search(r"version:\s*(\d+)\s*\(([0-9a-f]+)\)", combined)
    if m:
        return f"{m.group(1)} ({m.group(2)})"
    m = re.search(r"version:\s*(\d+)", combined)
    if m:
        return m.group(1)
    if rc == 0 and out.strip():
        return out.strip()[:100]
    return "unknown"


def _read_build_info(path: str) -> dict:
    """Lit le fichier BUILD_INFO genere par build-native.sh."""
    result = {}
    try:
        with open(path, "r") as f:
            for line in f:
                if "=" in line:
                    k, v = line.strip().split("=", 1)
                    result[k] = v
    except FileNotFoundError:
        pass
    return result


async def _toolbox_exists(name: str) -> bool:
    rc, out, _ = await _run(
        _user_cmd(["podman", "container", "ls", "-a", "--filter", f"name=^{name}$",
                   "--format", "{{.Names}}"]),
        timeout=10,
    )
    if rc != 0:
        return False
    return name in out.strip().splitlines()


async def _image_exists(image: str) -> bool:
    rc, _, _ = await _run(_user_cmd(["podman", "image", "exists", image]), timeout=10)
    return rc == 0


# ── Routes ────────────────────────────────────────────────────────────────────

async def _status_for_backend(cfg: dict) -> dict:
    """Build status dict for a single backend (toolbox or native)."""
    if cfg["type"] == "native":
        binary = cfg["binary"]
        installed = os.path.isfile(binary)
        version = await _get_native_version(binary) if installed else None
        build_info = _read_build_info(cfg["build_info"])
        return {
            "type": "native",
            "binary": binary,
            "installed": installed,
            "version": version,
            "build_info": build_info,
            "has_backup": os.path.isfile(binary + ".bak"),
        }
    # Toolbox backend
    name = cfg["toolbox_name"]
    exists = await _toolbox_exists(name)
    version = await _get_llama_version(name, cfg.get("version_cmd")) if exists else None
    has_backup = await _image_exists(cfg["backup_image"])
    return {
        "type": "toolbox",
        "toolbox_name": name,
        "exists": exists,
        "version": version,
        "has_backup": has_backup,
    }


@router.get("/status")
async def updater_status():
    """Statut des backends : version, existence, backup disponible."""
    result = {}
    for backend_key, cfg in _config.items():
        result[backend_key] = await _status_for_backend(cfg)
    result["update_in_progress"] = _update_in_progress
    return JSONResponse(content=result)


@router.get("/status/{backend}")
async def updater_status_backend(backend: str):
    """Statut d'un seul backend."""
    cfg = _config.get(backend)
    if not cfg:
        return JSONResponse(status_code=404, content={"error": f"backend inconnu: {backend}"})
    return JSONResponse(content=await _status_for_backend(cfg))


@router.post("/backup/{backend}")
async def updater_backup(backend: str):
    """Sauvegarde l'image actuelle du toolbox ou le binaire natif."""
    cfg = _config.get(backend)
    if not cfg:
        return JSONResponse(status_code=404, content={"error": f"backend inconnu: {backend}"})

    if cfg["type"] == "native":
        binary = cfg["binary"]
        if not os.path.isfile(binary):
            return JSONResponse(status_code=400, content={"error": f"binaire inexistant: {binary}"})
        backup = binary + ".bak"
        import shutil
        shutil.copy2(binary, backup)
        logger.info("Native backup: %s -> %s", binary, backup)
        return JSONResponse(content={"ok": True, "source": binary, "backup": backup})

    if not await _toolbox_exists(cfg["toolbox_name"]):
        return JSONResponse(status_code=400, content={"error": f"toolbox '{cfg['toolbox_name']}' inexistant"})

    # Trouver l'image du container
    rc, out, _ = await _run(_user_cmd(["podman", "container", "inspect", cfg["toolbox_name"],
                              "--format", "{{.ImageName}}"]), timeout=10)
    current_img = out.strip() if rc == 0 and out.strip() else cfg["upstream_image"]

    rc, _, err = await _run(_user_cmd(["podman", "tag", current_img, cfg["backup_image"]]), timeout=30)
    if rc != 0:
        return JSONResponse(status_code=500, content={"error": f"podman tag failed: {err[:200]}"})

    logger.info("Backup cree: %s -> %s", current_img, cfg["backup_image"])
    return JSONResponse(content={"ok": True, "source": current_img, "backup": cfg["backup_image"]})


@router.post("/pull/{backend}")
async def updater_pull(backend: str):
    """Pull la derniere image upstream et recree le toolbox.
    Pour native-vulkan, equivalent a --update (git pull + rebuild)."""
    global _update_in_progress
    cfg = _config.get(backend)
    if not cfg:
        return JSONResponse(status_code=404, content={"error": f"backend inconnu: {backend}"})
    if _update_in_progress:
        return JSONResponse(status_code=409, content={"error": "update deja en cours"})

    _update_in_progress = True
    _update_log.clear()
    try:
        if cfg["type"] == "native":
            return await _native_build(cfg, update=True)

        # Pull
        logger.info("[updater] Pulling %s...", cfg["upstream_image"])
        _update_log.append(f"Pulling {cfg['upstream_image']}...")
        rc, out, err = await _run(_user_cmd(["podman", "pull", cfg["upstream_image"]]), timeout=600, stream_logs=True)
        if rc != 0:
            _update_log.append(f"Pull failed: {err[:300]}")
            return JSONResponse(status_code=500, content={"error": f"pull failed: {err[:300]}"})
        _update_log.append("Pull OK")

        # Recreer toolbox
        _update_log.append(f"Recreating toolbox {cfg['toolbox_name']}...")
        await _run(_user_cmd(["toolbox", "rm", "-f", cfg["toolbox_name"]]), timeout=30)
        args = cfg["toolbox_args"].split()
        rc, out, err = await _run(
            _user_cmd(["toolbox", "create", cfg["toolbox_name"], "--image", cfg["upstream_image"], "--"] + args),
            timeout=60,
        )
        if rc != 0:
            _update_log.append(f"Toolbox create failed: {err[:300]}")
            return JSONResponse(status_code=500, content={"error": f"toolbox create failed: {err[:300]}"})

        version = await _get_llama_version(cfg["toolbox_name"], cfg.get("version_cmd"))
        _update_log.append(f"Done. Version: {version}")
        logger.info("Toolbox %s mis a jour (version %s)", cfg["toolbox_name"], version)
        return JSONResponse(content={"ok": True, "version": version, "log": _update_log})
    finally:
        _update_in_progress = False


async def _native_build(cfg: dict, update: bool = False) -> JSONResponse:
    """Run build-native.sh (clone or update + compile). Called from /pull and /build.

    The script accepts --prefix, --pr, --branch so multiple native slots can
    coexist (master + PR builds). For the default native-vulkan slot we don't
    pass --prefix (the script's default /opt/llama-native is correct), but for
    extra_native_backends we pass --prefix and either --pr or --branch.
    """
    script = cfg["build_script"]
    if not os.path.isfile(script):
        _update_log.append(f"Build script introuvable: {script}")
        return JSONResponse(status_code=400, content={"error": f"build script introuvable: {script}"})

    args = [script]
    # Pass --prefix only when it diverges from the script's default, otherwise
    # let the script keep its baked-in /opt/llama-native to stay backward-compat.
    install_prefix = cfg.get("install_prefix")
    if install_prefix and install_prefix != "/opt/llama-native":
        args += ["--prefix", install_prefix]
    # PR takes priority over branch (matches build-native.sh semantics).
    pr = cfg.get("pr")
    branch = cfg.get("branch")
    if pr:
        args += ["--pr", str(pr)]
    elif branch:
        args += ["--branch", str(branch)]
    if update:
        args.append("--update")

    label = "update" if update else "build"
    logger.info("[updater] Native %s via %s (args=%s)", label, script, args[1:])
    _update_log.append(f"Native {label}: running {' '.join(args)}...")

    rc, out, err = await _run(args, timeout=1800, stream_logs=True)  # 30min max
    if rc != 0:
        _update_log.append(f"Native {label} failed (rc={rc}): {err[:500]}")
        return JSONResponse(status_code=500, content={"error": f"native {label} failed (rc={rc}): {err[:500]}"})

    version = await _get_native_version(cfg["binary"])
    build_info = _read_build_info(cfg["build_info"])
    _update_log.append(f"Done. Version: {version}")
    logger.info("Native %s complete (version %s)", label, version)
    return JSONResponse(content={"ok": True, "version": version, "build_info": build_info, "log": _update_log})


@router.post("/build/{backend}")
async def updater_build(backend: str):
    """Build local depuis le Dockerfile ou build-native.sh (dernier llama.cpp master)."""
    global _update_in_progress
    cfg = _config.get(backend)
    if not cfg:
        return JSONResponse(status_code=404, content={"error": f"backend inconnu: {backend}"})
    if _update_in_progress:
        return JSONResponse(status_code=409, content={"error": "update deja en cours"})

    _update_in_progress = True
    _update_log.clear()
    try:
        if cfg["type"] == "native":
            return await _native_build(cfg, update=False)

        dockerfile = cfg["dockerfile"]
        if not os.path.isfile(dockerfile):
            return JSONResponse(status_code=400, content={"error": f"Dockerfile introuvable: {dockerfile}"})

        logger.info("[updater] Building %s from %s...", cfg["local_image"], dockerfile)
        _update_log.append(f"Building {cfg['local_image']} from {dockerfile}...")
        context_dir = os.path.dirname(dockerfile)
        rc, out, err = await _run(
            _user_cmd(["podman", "build", "-f", dockerfile, "-t", cfg["local_image"], context_dir]),
            timeout=3600,  # 1h max pour un build
            stream_logs=True,
        )
        if rc != 0:
            _update_log.append(f"Build failed: {err[:500]}")
            return JSONResponse(status_code=500, content={"error": f"build failed: {err[:500]}"})
        _update_log.append("Build OK")

        # Recreer toolbox
        await _run(_user_cmd(["toolbox", "rm", "-f", cfg["toolbox_name"]]), timeout=30)
        args = cfg["toolbox_args"].split()
        rc, out, err = await _run(
            _user_cmd(["toolbox", "create", cfg["toolbox_name"], "--image", cfg["local_image"], "--"] + args),
            timeout=60,
        )
        if rc != 0:
            _update_log.append(f"Toolbox create failed: {err[:300]}")
            return JSONResponse(status_code=500, content={"error": f"toolbox create failed: {err[:300]}"})

        version = await _get_llama_version(cfg["toolbox_name"], cfg.get("version_cmd"))
        _update_log.append(f"Done. Version: {version}")
        logger.info("Toolbox %s rebuild (version %s)", cfg["toolbox_name"], version)
        return JSONResponse(content={"ok": True, "version": version, "log": _update_log})
    finally:
        _update_in_progress = False


@router.post("/restore/{backend}")
async def updater_restore(backend: str, body: dict | None = None):
    """Restaure le toolbox depuis le backup ou l'upstream.
    Pour native-vulkan, restaure le binaire .bak.
    Body: { "source": "backup" | "upstream" }  (default: backup)
    """
    global _update_in_progress
    cfg = _config.get(backend)
    if not cfg:
        return JSONResponse(status_code=404, content={"error": f"backend inconnu: {backend}"})
    if _update_in_progress:
        return JSONResponse(status_code=409, content={"error": "update deja en cours"})

    if cfg["type"] == "native":
        binary = cfg["binary"]
        backup = binary + ".bak"
        if not os.path.isfile(backup):
            return JSONResponse(status_code=400, content={"error": "pas de backup disponible"})
        import shutil
        shutil.copy2(backup, binary)
        version = await _get_native_version(binary)
        logger.info("Native restore: %s -> %s (version %s)", backup, binary, version)
        return JSONResponse(content={"ok": True, "source": "backup", "version": version})

    source = (body or {}).get("source", "backup")
    if source == "backup":
        image = cfg["backup_image"]
        if not await _image_exists(image):
            return JSONResponse(status_code=400, content={"error": "pas de backup disponible"})
    elif source == "upstream":
        image = cfg["upstream_image"]
    else:
        return JSONResponse(status_code=400, content={"error": f"source invalide: {source}"})

    _update_in_progress = True
    try:
        if source == "upstream":
            logger.info("[updater] Pulling %s for restore...", image)
            await _run(_user_cmd(["podman", "pull", image]), timeout=600, stream_logs=True)
        await _run(_user_cmd(["toolbox", "rm", "-f", cfg["toolbox_name"]]), timeout=30)
        args = cfg["toolbox_args"].split()
        rc, out, err = await _run(
            _user_cmd(["toolbox", "create", cfg["toolbox_name"], "--image", image, "--"] + args),
            timeout=60,
        )
        if rc != 0:
            return JSONResponse(status_code=500, content={"error": f"restore failed: {err[:300]}"})
        version = await _get_llama_version(cfg["toolbox_name"], cfg.get("version_cmd"))
        logger.info("Toolbox %s restaure depuis %s (version %s)", cfg["toolbox_name"], source, version)
        return JSONResponse(content={"ok": True, "source": source, "version": version})
    finally:
        _update_in_progress = False


@router.get("/log")
async def updater_log():
    """Retourne le log de la derniere operation de mise a jour."""
    return JSONResponse(content={"log": _update_log, "in_progress": _update_in_progress})
