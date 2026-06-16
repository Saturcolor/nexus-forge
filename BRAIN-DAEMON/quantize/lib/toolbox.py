"""Wrappers pour `toolbox run -c <container> ...` + helpers d'accessibilité.

Les toolbox containers ne montent que $HOME — tout fichier hors HOME est
invisible depuis le container. Ce module factorise les helpers pour vérifier
qu'un toolbox existe, qu'un binaire est dispo dedans, et copier au besoin
les fichiers hors-HOME vers un cache sous HOME.

Quand le brain-daemon tourne en root + `run_as_user: <user>` configuré
(setup standard prod), toutes les commandes toolbox/podman doivent être wrappées
en `sudo -u <user> --` pour avoir accès aux containers de <user> + résoudre
correctement son passwd entry (sinon erreur "unable to find user <user>").
Le pattern matche `BRAIN-DAEMON/updater/routes.py:_user_cmd`.

Port direct de brain-quant.py:327-428 + extension run_as_user pour le daemon.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

# Set par `set_run_as_user()` au boot du daemon depuis init_quant (lit la clé
# `run_as_user` du config brain-daemon). Si vide → commandes lancées directement.
_RUN_AS_USER: str = ""

# Map des backends natifs : nom logique → dossier contenant llama-imatrix +
# llama-quantize + llama-server. Set par `set_native_dirs()` au boot.
# Permet de bypass toolbox quand les containers sont cassés ou pour gagner
# en simplicité (single-user setup, /opt/llama-native/bin = build statique).
#
# Nommage : "native-vulkan", "native-rocm", "native-turboquant" — préfixe
# `native-` reconnu par `is_native()` pour router vers exec direct.
_NATIVE_DIRS: dict[str, Path] = {}


def set_run_as_user(user: str | None) -> None:
    """Configure le user sous lequel les commandes toolbox/podman sont lancées."""
    global _RUN_AS_USER
    _RUN_AS_USER = (user or "").strip()


def set_native_dirs(dirs: dict[str, str | Path]) -> None:
    """Configure les backends natifs disponibles.

    Ex: `{"native-vulkan": "/opt/llama-native/bin", "native-rocm": "/opt/llama-rocm/bin"}`
    Les binaires `llama-imatrix` et `llama-quantize` doivent vivre dans ces dossiers.
    """
    global _NATIVE_DIRS
    _NATIVE_DIRS = {name: Path(p) for name, p in dirs.items() if p}


def is_native(toolbox: str) -> bool:
    """True si le nom du 'toolbox' désigne un backend natif (pas un container)."""
    return toolbox.startswith("native") and toolbox in _NATIVE_DIRS


def native_dir(toolbox: str) -> Path | None:
    """Retourne le dossier des binaires pour un backend natif. None sinon."""
    return _NATIVE_DIRS.get(toolbox)


def _user_cmd(cmd: list[str]) -> list[str]:
    """Wrappe avec `sudo -u <user> --` si run_as_user est configuré.

    Sans ça, daemon en root + container owned par <run_as_user> = échec d'accès
    (`unable to find user <run_as_user> in passwd file`).
    """
    if _RUN_AS_USER:
        # `-E` préserve l'env du parent (HOME etc.) — pas utilisé ici car
        # toolbox/podman ont leur propre logique d'env.
        return ["sudo", "-u", _RUN_AS_USER, "--"] + cmd
    return cmd


def toolbox_exists(toolbox: str) -> bool:
    """True si le backend existe.

    - Mode native : check que le dossier + les binaires llama-imatrix +
      llama-quantize sont présents.
    - Mode container : `podman container ls --filter name=^X$` (plus robuste
      que `toolbox list` qui échoue avec "unable to find user X" quand daemon
      root tape sur des containers owned par <run_as_user>). Pattern aligné sur
      `BRAIN-DAEMON/updater/routes.py:_toolbox_exists`.
    """
    if toolbox.startswith("native"):
        d = _NATIVE_DIRS.get(toolbox)
        if d is None:
            return False
        return (d / "llama-imatrix").exists() and (d / "llama-quantize").exists()

    try:
        r = subprocess.run(
            _user_cmd([
                "podman", "container", "ls", "-a",
                "--filter", f"name=^{toolbox}$",
                "--format", "{{.Names}}",
            ]),
            capture_output=True, text=True, timeout=10,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False
    if r.returncode != 0:
        return False
    return toolbox in r.stdout.strip().splitlines()


def toolbox_has_binary(toolbox: str, binary: str) -> bool:
    """True si le binaire demandé est exécutable.

    Mode native : check fichier exists. Mode container : `which` dans le tbox.
    """
    if toolbox.startswith("native"):
        d = _NATIVE_DIRS.get(toolbox)
        return d is not None and (d / binary).exists()

    try:
        r = subprocess.run(
            _user_cmd(["toolbox", "run", "-c", toolbox, "which", binary]),
            capture_output=True, text=True, timeout=15,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False
    return r.returncode == 0


def _user_home() -> str:
    """Home dir du run_as_user si configuré, sinon Path.home() du process.

    Sous le daemon root + run_as_user=<user>, on veut cwd=<home du run_as_user>
    (pas /root) pour que les toolbox containers voient les paths attendus.
    """
    if _RUN_AS_USER:
        try:
            import pwd
            return pwd.getpwnam(_RUN_AS_USER).pw_dir
        except (KeyError, ImportError):
            pass
    return str(Path.home())


def _popen_kwargs() -> dict:
    """kwargs Popen partagés. `start_new_session=True` isole les subprocess dans
    leur propre group/session — permet de les retrouver et killer au boot
    (cf manager._recover_orphans, C1 audit) sans tuer le daemon parent."""
    return {
        "stdout": subprocess.PIPE,
        "stderr": subprocess.STDOUT,
        "cwd": _user_home(),
        "start_new_session": True,
    }


def _resolve_cmd(toolbox: str, args: list[str]) -> list[str]:
    """Construit la commandline finale selon le backend.

    - Mode native : remplace le premier arg (binary name type "llama-imatrix")
      par le path absolu dans _NATIVE_DIRS[toolbox]. Pas de wrap sudo car les
      binaires natifs vivent dans /opt accessible à tous.
    - Mode container : `toolbox run -c <tbox> <args>` wrappé en sudo -u si
      run_as_user configuré.
    """
    if toolbox.startswith("native"):
        d = _NATIVE_DIRS.get(toolbox)
        if d is None:
            raise RuntimeError(f"native backend not configured: {toolbox}")
        if not args:
            raise RuntimeError("native backend requires a binary name in args")
        # args[0] = "llama-imatrix" → /opt/llama-native/bin/llama-imatrix
        return [str(d / args[0])] + list(args[1:])
    return _user_cmd(["toolbox", "run", "-c", toolbox] + args)


def toolbox_popen(toolbox: str, args: list[str]) -> subprocess.Popen:
    """Lance une commande sous le backend choisi (native ou toolbox container).

    Mode container : `toolbox run -c <tbox> <args>` wrappé en sudo -u quand
    run_as_user configuré (sinon erreur passwd).
    Mode native : exec direct du binary natif dans _NATIVE_DIRS[toolbox].
    Le cwd est forcé à HOME du run_as_user (pas du daemon) — important pour
    les containers, neutre pour le natif.
    """
    cmd = _resolve_cmd(toolbox, args)
    return subprocess.Popen(cmd, text=True, bufsize=1, **_popen_kwargs())


def toolbox_popen_bytes(toolbox: str, args: list[str]) -> subprocess.Popen:
    """Variante bytes-mode pour lire stdout via select+os.read (run_imatrix).

    Sans TextIOWrapper, les lectures sont non-bloquantes par tranche de taille
    arbitraire — nécessaire pour parser les marqueurs `[N]` de llama-imatrix
    en streaming sans bloquer par paliers.
    """
    cmd = _resolve_cmd(toolbox, args)
    return subprocess.Popen(cmd, **_popen_kwargs())


def ensure_accessible(path: Path, cache_dir: Path) -> Path:
    """Si `path` est hors de HOME, copie dans cache_dir et renvoie le nouveau chemin.

    Les toolbox containers ne montent que $HOME. Tout fichier hors de HOME
    (typiquement dans /opt) est invisible depuis le container.

    Port direct de brain-quant.py:ensure_toolbox_accessible.
    """
    home = Path.home().resolve()
    abs_path = path.resolve()
    try:
        abs_path.relative_to(home)
        return abs_path
    except ValueError:
        pass

    cache_dir.mkdir(parents=True, exist_ok=True)
    target = cache_dir / path.name
    if not target.exists() or target.stat().st_mtime < abs_path.stat().st_mtime:
        shutil.copy2(abs_path, target)
    return target.resolve()


# Alias rétro-compat pour le TUI existant qui appelle ensure_toolbox_accessible.
ensure_toolbox_accessible = ensure_accessible


def check_writable(path: Path) -> tuple[bool, str]:
    """Vérifie qu'on peut écrire dans `path` (dossier ou futur dossier).

    Teste pour de vrai avec touch+unlink — plus fiable que os.access() qui
    peut mentir avec ACL/SELinux. Retourne (True, "") si OK, (False, "raison")
    sinon.

    Port direct de brain-quant.py:346.
    """
    try:
        if not path.exists():
            try:
                path.mkdir(parents=True, exist_ok=True)
            except PermissionError as e:
                return False, f"impossible de créer {path} : {e}"
            except OSError as e:
                return False, f"erreur création {path} : {e}"

        if not path.is_dir():
            return False, f"{path} existe mais n'est pas un dossier"

        test_file = path / ".brain-quant-write-test"
        try:
            test_file.touch()
            test_file.unlink()
        except (PermissionError, OSError) as e:
            try:
                import grp
                import pwd
                import stat as stmod
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
