"""FastAPI routes pour brain-daemon /quant/*.

Phase 1 = endpoints read-only seulement (scan FS + preview surgical + validate GGUF).
Les jobs long-running (POST /quant/jobs, stream NDJSON, cancel) arrivent en Phase 2.

Montées dans daemon.py via :
    from quantize.routes import router as quant_router, init_quant
    app.include_router(quant_router, prefix="/quant")
    # puis dans startup: init_quant(config)

Le module charge sa propre config.yaml (BRAIN-DAEMON/quantize/config.yaml) qui
contient les presets canoniques + les chemins models/calib/imatrix. Cette config
est INDÉPENDANTE de celle du daemon (intentionnel : le daemon ne connaît pas les
presets de quant ; brain-quant.py SSH-direct et brain-daemon /quant/* partagent
la même source of truth quantize/config.yaml).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from quantize.lib import config as quant_config
from quantize.lib import cartography, gguf, imatrix, presets, quantize, scan, surgical, toolbox
from quantize.lib.paths import QuantPaths
from quantize.manager import QuantManager, get_manager, set_manager

log = logging.getLogger("brain.quant.routes")
router = APIRouter()

# Lazy-init state (set par init_quant)
_paths: QuantPaths | None = None
_cfg: dict | None = None
_enabled: bool = False


async def init_quant(daemon_config: dict | None = None) -> None:
    """Appelé depuis daemon.py startup (async pour démarrer le manager).

    `daemon_config` peut être passé pour permettre une feature flag globale
    (ex: `quant.enabled: false`). La config quantize/config.yaml est chargée
    indépendamment.
    """
    global _paths, _cfg, _enabled

    if daemon_config is not None:
        _enabled = bool(daemon_config.get("quant", {}).get("enabled", True))
    else:
        _enabled = True

    if not _enabled:
        log.info("quant routes initialized — DISABLED via config.quant.enabled=false")
        return

    # Forward `run_as_user` du config daemon vers lib.toolbox pour wrapper les
    # commandes toolbox/podman en sudo -u — sans ça, daemon root tape sur les
    # containers de <run_as_user> et fail avec "unable to find user <run_as_user>".
    if daemon_config is not None:
        toolbox.set_run_as_user(daemon_config.get("run_as_user", ""))
        # Forward aussi les backends natifs disponibles. Le dir parent du
        # native_vulkan_binary (ex: /opt/llama-native/bin) doit contenir
        # llama-imatrix + llama-quantize. Permet de bypass toolbox quand les
        # containers sont cassés (passwd, sudo, etc.) ou pour simplifier.
        native_dirs: dict[str, Any] = {}
        nv = daemon_config.get("native_vulkan_binary")
        if nv:
            native_dirs["native-vulkan"] = str(Path(nv).parent)
        nt = daemon_config.get("native_turboquant_binary")
        if nt:
            native_dirs["native-turboquant"] = str(Path(nt).parent)
        if native_dirs:
            toolbox.set_native_dirs(native_dirs)

    try:
        _cfg = quant_config.load_config()
        _paths = QuantPaths.from_config(_cfg)
        log.info(
            f"quant routes initialized — models={_paths.models_path} "
            f"outputs={_paths.output_dir} imatrix={_paths.imatrix_dir} "
            f"presets={len(_cfg.get('quants', []))} "
            f"run_as_user={daemon_config.get('run_as_user', '(none)') if daemon_config else '(none)'}"
        )
        manager = QuantManager(_cfg, _paths)
        await manager.start()
        set_manager(manager)
    except quant_config.ConfigError as exc:
        log.warning(f"quant disabled — config.yaml invalide : {exc}")
        _enabled = False


async def shutdown_quant() -> None:
    """Appelé depuis daemon.py shutdown."""
    mgr = get_manager()
    if mgr is not None:
        await mgr.stop()
        set_manager(None)


def _require_enabled() -> tuple[dict, QuantPaths]:
    """Garde d'accès. Raise 503 si le module est désactivé / pas init."""
    if not _enabled or _cfg is None or _paths is None:
        raise HTTPException(
            503,
            "quant module disabled or not initialized — vérifier "
            "BRAIN-DAEMON/quantize/config.yaml et config.quant.enabled",
        )
    return _cfg, _paths


# ────────────────────────────────────────────────────────────────────────────
# Pydantic schemas
# ────────────────────────────────────────────────────────────────────────────

class SurgicalPreviewRequest(BaseModel):
    """Payload pour POST /quant/surgical/preview.

    `source` choisit l'origine des scores d'importance utilisés pour le top-X% :
      - "imatrix" (défaut) : tri par sum_values d'une .imatrix (calibration GPU).
      - "cartography" : tri par l2_norm des POIDS (stats statiques, SANS calib).
        Requiert source_path (le GGUF à scanner) ; imatrix_name est alors ignoré.
    """
    source: Literal["imatrix", "cartography"] = Field("imatrix")
    imatrix_name: str | None = Field(None, description="Nom de fichier .imatrix (requis si source=imatrix)")
    profile: str = Field("surgical", description="Profile (surgical|surgical-light|surgical-xl|2tier|3tier|4tier)")
    name: str = Field(..., description="Nom du preset à générer")
    base: str | None = None
    top_per_family: float | None = Field(None, ge=0.0, le=1.0)
    top_f16: float | None = Field(None, ge=0.0, le=1.0)
    top_q8: float | None = Field(None, ge=0.0, le=1.0)
    source_path: str | None = Field(None, description="GGUF source (optionnel) — si fourni, calcule est_size_bytes")


class CustomSurgicalPreviewRequest(BaseModel):
    """Payload pour POST /quant/surgical/custom-preview — builder per-family.

    Contrairement à SurgicalPreviewRequest qui dispatch sur un profile fixe,
    ce request laisse l'utilisateur définir explicitement le quant par famille
    de tensors + un bonus top-X% F16 optionnel par famille + des pins F16.

    `source` (comme SurgicalPreviewRequest) choisit l'origine des tensors/scores :
      - "imatrix" (défaut) : familles + sum_values d'une .imatrix (calibration GPU).
      - "cartography" : familles + l2_norm des POIDS (stats statiques, SANS calib).
        Requiert source_path ; imatrix_name est alors ignoré. Permet un custom
        per-family sans avoir buildé d'imatrix (ex: requantize Q8→Q6).
    """
    source: Literal["imatrix", "cartography"] = Field("imatrix")
    imatrix_name: str | None = Field(None, description="Nom de fichier .imatrix (requis si source=imatrix)")
    name: str = Field(..., description="Nom du preset à générer")
    base: str = Field("Q8_0", description="Quant de base (fallback pour familles non spécifiées)")
    family_quants: dict[str, str] = Field(
        default_factory=dict,
        description='Map {famille → type}. Type peut être "F16", "Q8_0", "Q6_K", "Q5_K_M", "Q4_K_M", "Q3_K_M" ou "base". Familles absentes → base.',
    )
    # Accepte soit un float (global) soit un dict {fam → pct} pour bonus per-family
    top_per_family_f16: dict[str, float] | float = Field(
        0.0,
        description="Fraction [0..1] des top tensors par famille (par sum_values) à forcer en bonus_type. Float global ou dict {fam → pct}.",
    )
    f16_pins: list[str] | None = Field(
        None,
        description="Regex F16 supplémentaires. Si None, utilise F16_PIN_REGEXES par défaut (norms + MoE routers + SSM).",
    )
    # Restreint via Literal — sans ça, replace("=F16", f"={bonus_type}") produit
    # des regex invalides envoyées à llama-quantize (audit H2). La docstring de
    # surgical.emit_preset_custom n'autorise déjà que ces deux valeurs en pratique.
    bonus_type: Literal["F16", "Q8_0"] = Field(
        "F16",
        description='"F16" pour source F16/BF16, "Q8_0" pour source Q8 (re-quantize).',
    )
    source_path: str | None = Field(None, description="GGUF source (optionnel) — si fourni, calcule est_size_bytes")


class ValidateGgufRequest(BaseModel):
    """Payload pour POST /quant/validate-gguf."""
    source_path: str | None = Field(
        None,
        description="GGUF source (peut être shardé). Si absent / introuvable, "
                    "résolution auto par base_name depuis scan_source_models.",
    )
    output_path: str = Field(..., description="GGUF produit à valider")


class CartographyRequest(BaseModel):
    """Payload pour POST /quant/cartography — scan des poids d'un modèle.

    Fast path (with_health=False) : header GGUF seulement → specs instantanées
    (arch, params, taille, breakdown par famille/type). Aucune lecture de valeurs.

    Deep path (with_health=True) : lit + déquant les VALEURS (cartography.py) et
    ajoute la santé par famille (outliers de scale, saturation, mean-drift).
    Lourd (~30-60s sur un 35B) mais caché mtime-keyed.
    """
    source_path: str = Field(..., description="GGUF source (1er shard si shardé)")
    with_health: bool = Field(True, description="False = specs header only (instantané) ; True = + scan valeurs/santé")
    force: bool = Field(False, description="Ignore le cache cartography")


# ────────────────────────────────────────────────────────────────────────────
# Health + system
# ────────────────────────────────────────────────────────────────────────────

@router.get("/health")
async def health():
    """État du module quant. Toujours répond (même désactivé)."""
    mgr = get_manager()
    current = mgr.current_job() if mgr else None
    return {
        "enabled": _enabled,
        "initialized": _cfg is not None and _paths is not None,
        "models_path": str(_paths.models_path) if _paths else None,
        "output_dir": str(_paths.output_dir) if _paths else None,
        "imatrix_dir": str(_paths.imatrix_dir) if _paths else None,
        "calib_dir": str(_paths.calib_dir) if _paths else None,
        "presets_canonical_count": len(_cfg.get("quants", [])) if _cfg else 0,
        "current_job": current.to_dict() if current else None,
        "queue_len": mgr.queue_len() if mgr else 0,
    }


@router.get("/toolboxes")
async def list_toolboxes():
    """Liste des backends disponibles (toolboxes containers + backends natifs).

    Les backends natifs (préfixe `native-`) sont exposés en premier car plus
    simples (pas de toolbox CLI, pas de sudo, pas de namespace passwd à craindre).
    Sur ton setup le native-vulkan = `/opt/llama-native/bin` est typiquement
    le plus stable. Les containers toolbox restent en option si tu en as besoin
    (ex: ROCm pour des tests perf).
    """
    cfg, _ = _require_enabled()
    default = cfg.get("toolbox", "llama-vulkan-radv")
    out = []
    # Backends natifs d'abord (set par init_quant depuis daemon_config)
    for name in sorted(toolbox._NATIVE_DIRS.keys()):
        out.append({
            "name": name,
            "available": toolbox.toolbox_exists(name),
            "is_default": name == default,
            "kind": "native",
            "path": str(toolbox._NATIVE_DIRS[name]),
        })
    # Containers toolbox connus + default
    known = ["llama-vulkan-radv", "llama-rocm-7.2"]
    if default not in known and not default.startswith("native"):
        known.append(default)
    for name in known:
        out.append({
            "name": name,
            "available": toolbox.toolbox_exists(name),
            "is_default": name == default,
            "kind": "toolbox",
        })
    return {"toolboxes": out, "default": default}


# ────────────────────────────────────────────────────────────────────────────
# Scan endpoints
# ────────────────────────────────────────────────────────────────────────────

@router.get("/models")
async def list_models():
    """Liste les modèles GGUF SOURCES (F16/BF16/Q8_0) candidats à un quant."""
    _, paths = _require_enabled()
    models = scan.scan_source_models(paths.models_path)
    return {
        "models": [m.to_dict() for m in models],
        "count": len(models),
        "models_path": str(paths.models_path),
    }


@router.get("/outputs")
async def list_outputs():
    """Liste les GGUFs produits (dans output_dir = <models>/mercury/).

    Inclut tous les GGUFs trouvés sous models_path (pas que ceux dans
    output_subdir) pour permettre à l'UI d'afficher l'historique complet.
    """
    _, paths = _require_enabled()
    all_gguf = scan.scan_all_gguf(paths.models_path)
    # Filtre : seulement ceux dans <output_subdir>/, plus les éventuels
    # quants brain hors-Mercury que l'utilisateur aurait migrés.
    output_str = str(paths.output_dir)
    outputs = [g for g in all_gguf if output_str in str(g.path) or "brain-" in g.path.name]
    return {
        "outputs": [g.to_dict() for g in outputs],
        "count": len(outputs),
        "output_dir": str(paths.output_dir),
    }


@router.get("/calibrations")
async def list_calibrations():
    """Liste les fichiers .txt de calibration."""
    _, paths = _require_enabled()
    calibs = scan.scan_calibrations(paths.calib_dir)
    return {
        "calibrations": [c.to_dict() for c in calibs],
        "count": len(calibs),
        "calib_dir": str(paths.calib_dir),
    }


@router.get("/imatrices")
async def list_imatrices():
    """Liste les .imatrix cachés (headers seulement — pas le contenu binaire)."""
    _, paths = _require_enabled()
    imatrices = scan.scan_imatrices(paths.imatrix_dir)
    return {
        "imatrices": [i.to_dict() for i in imatrices],
        "count": len(imatrices),
        "imatrix_dir": str(paths.imatrix_dir),
    }


@router.delete("/imatrices/{name}")
async def delete_imatrix(name: str):
    """Supprime une imatrix du disque. Irréversible — l'UI doit confirmer.

    Validation path-traversal : pas de séparateur ni `..` dans le name.
    """
    _, paths = _require_enabled()
    if "/" in name or "\\" in name or ".." in name:
        raise HTTPException(400, "nom d'imatrix invalide")
    p = paths.imatrix_dir / name
    if not p.exists():
        raise HTTPException(404, f"imatrix introuvable : {name}")
    if not p.is_file():
        raise HTTPException(400, f"{name} n'est pas un fichier")
    try:
        p.unlink()
    except OSError as exc:
        raise HTTPException(500, f"delete échoué : {exc}")
    log.info(f"deleted imatrix {p}")
    return {"deleted": str(p)}


@router.delete("/outputs")
async def delete_output(path: str):
    """Supprime un GGUF output (passé en query param `?path=<absolute>`).

    Sécurité : on valide le path-as-specified sans `.resolve()` pour ne pas
    suivre les symlinks (bug-hunt finding #4 : `mercury/alias.gguf` symlink vers
    `important.gguf` aurait permis de supprimer le target au lieu de l'alias).
    Le delete utilise `unlink()` qui ne suit pas non plus les symlinks.

    Le path-as-specified doit déjà être sous models_path après `.absolute()`.
    On rejette aussi les `..` qui pourraient échapper après normalisation.
    """
    import stat as stmod
    _, paths = _require_enabled()
    p = Path(path).absolute()
    # Pas de resolve() : on vérifie le path tel que fourni, pas sa cible.
    # `..` est explicitement banni — `relative_to` peut passer avec un `..`
    # qui re-rentre sous models_path par accident, mais c'est suspect.
    if ".." in p.parts:
        raise HTTPException(400, f"path contient `..` : {p}")
    try:
        p.relative_to(paths.models_path.resolve())
    except ValueError:
        raise HTTPException(400, f"path hors de models_path : {p}")
    # lstat ne suit pas les symlinks — on inspecte le fichier/lien tel quel
    try:
        st = p.lstat()
    except FileNotFoundError:
        raise HTTPException(404, f"output introuvable : {p}")
    is_regular = stmod.S_ISREG(st.st_mode)
    is_link = stmod.S_ISLNK(st.st_mode)
    if not (is_regular or is_link):
        raise HTTPException(400, f"{p} n'est pas un fichier ou symlink")
    if p.suffix.lower() != ".gguf":
        raise HTTPException(400, f"refus de supprimer un non-GGUF : {p.suffix}")
    try:
        p.unlink()  # supprime le lien lui-même si symlink, sinon le fichier
    except OSError as exc:
        raise HTTPException(500, f"delete échoué : {exc}")
    log.info(f"deleted output {p} ({'symlink' if is_link else 'file'})")
    return {"deleted": str(p)}


@router.get("/imatrices/{name}")
async def get_imatrix(name: str, source_path: str | None = None):
    """Détails d'un .imatrix — parse binaire complet (TensorStat[] + arch).

    `name` doit être le nom de fichier dans imatrix_dir (sans path). Renvoie
    404 si le fichier n'existe pas. Réponse potentiellement grande pour des
    modèles 235B (centaines de tensors) — pas de pagination en v1 (single-user).

    Si `source_path` est fourni et pointe vers le GGUF source du modèle, on
    enrichit chaque famille avec `bytes` et `bytes_pct` (poids réel sur disque,
    pas l'agrégation naïve de nval — `nval` = d_in d'activation, pas l'élément
    count du tensor). Permet à l'UI Inspector d'afficher le ratio énergie/poids.
    """
    _, paths = _require_enabled()
    # Sécurité : empêche le path traversal
    if "/" in name or "\\" in name or ".." in name:
        raise HTTPException(400, "nom d'imatrix invalide")
    p = paths.imatrix_dir / name
    if not p.exists():
        raise HTTPException(404, f"imatrix introuvable : {name}")
    try:
        data = imatrix.parse_imatrix(p)
    except Exception as exc:
        raise HTTPException(500, f"parse échoué : {exc}")

    # Agrégation par famille pour la UI Inspector
    families: dict[str, dict[str, Any]] = {}
    for t in data.tensors:
        fam = surgical._family_of(t.name)
        if fam not in families:
            families[fam] = {"tensors": 0, "sum": 0.0, "pct": 0.0}
        families[fam]["tensors"] += 1
        families[fam]["sum"] += t.sum_values
    total_sum = sum(f["sum"] for f in families.values()) or 1.0
    for f in families.values():
        f["pct"] = f["sum"] / total_sum

    # Si source GGUF fourni, enrichit chaque famille avec son poids réel.
    # On parcourt les tensors du GGUF source (cached) plutôt que ceux de
    # l'imatrix — l'imatrix ne contient que d_in par tensor, pas la shape totale.
    if source_path:
        src = Path(source_path)
        _ensure_under_models_path(src, paths)
        if src.exists():
            try:
                src_hdr = _get_cached_gguf_header(src)
                bytes_by_family: dict[str, int] = {}
                for tens in src_hdr.tensors:
                    fam = surgical._family_of(tens.name)
                    bytes_by_family[fam] = bytes_by_family.get(fam, 0) + tens.bytes_current
                total_bytes = sum(bytes_by_family.values()) or 1
                for fam, info in families.items():
                    b = bytes_by_family.get(fam, 0)
                    info["bytes"] = b
                    info["bytes_pct"] = b / total_bytes
            except Exception as exc:
                log.warning(
                    f"family bytes enrichment failed for {source_path}: {exc!s}"
                )

    return {
        **data.to_dict(),
        "families": families,
    }


# ────────────────────────────────────────────────────────────────────────────
# Presets
# ────────────────────────────────────────────────────────────────────────────

@router.get("/presets/canonical")
async def list_canonical_presets():
    """Liste les presets canoniques depuis config.yaml (lecture seule).

    Les custom presets (surgical builder) sont stockés côté AtlasMind DB,
    pas ici.
    """
    cfg, _ = _require_enabled()
    quants = presets.list_canonical(cfg)
    defaults = presets.default_canonical_names(cfg)
    return {
        "presets": quants,
        "default_names": sorted(defaults),
        "count": len(quants),
    }


@router.get("/family-catalog")
async def family_catalog():
    """Doc pédagogique + recos arch-aware + priorités pour le Surgical Builder.

    Retourne families/categories/f16_pins_default/arch_reco/family_priority/
    category_priority — la UI applique l'arch détectée de l'imatrix sélectionnée
    pour afficher les bons badges priorité par famille.
    """
    return surgical.family_catalog()


# ────────────────────────────────────────────────────────────────────────────
# GGUF header cache — parsing 35B+ sharded headers prend 7-8s, et le Surgical
# Builder live-preview re-fire à chaque slider move. Sans ça, brain reste busy
# 7-8s/appel, Mercury time out sur /quant/health en parallèle (502s observés
# 2026-05-24). Cache simple {(path_resolved, mtime): GGUFHeader} avec maxsize=8.
# ────────────────────────────────────────────────────────────────────────────

_gguf_header_cache: dict[tuple[str, float], Any] = {}
_GGUF_CACHE_MAXSIZE = 8


def _get_cached_gguf_header(source_path: Path):
    """Renvoie le header parsé (sharded-aware) avec cache mtime-keyed.

    Le mtime change si le fichier est ré-écrit → cache invalidé automatiquement.
    Si le cache déborde maxsize, on évacue la plus vieille entrée (FIFO simple,
    pas LRU strict mais suffisant pour 8 modèles max).
    """
    abs_path = source_path.resolve()
    try:
        mtime = abs_path.stat().st_mtime
    except OSError as exc:
        raise RuntimeError(f"stat({abs_path}) échoué : {exc}") from exc
    key = (str(abs_path), mtime)
    if key in _gguf_header_cache:
        return _gguf_header_cache[key]
    hdr = gguf.read_gguf_header_sharded(abs_path)
    if len(_gguf_header_cache) >= _GGUF_CACHE_MAXSIZE:
        oldest_key = next(iter(_gguf_header_cache))
        _gguf_header_cache.pop(oldest_key, None)
    _gguf_header_cache[key] = hdr
    return hdr


# Cache cartography (scan de VALEURS, ~30-60s, jusqu'à ~30min sur un gros MoE).
# DEUX niveaux :
#   - RAM (_carto_cache, mtime-keyed) : hits instantanés intra-process.
#   - DISQUE (_carto_cache_dir/*.json) : SURVIT au restart du daemon + partagé par
#     TOUS les chemins (Inspect /cartography, surgical preview/quantize source=carto).
#     Sans ça, chaque restart brain re-scanne (30min sur MiniMax) — cf incident 2026-05-30.
_carto_cache: dict[tuple[str, float], Any] = {}
_CARTO_CACHE_MAXSIZE = 4


def _carto_cache_dir() -> Path | None:
    """Dossier du cache disque cartography (sibling de imatrix_dir, writable daemon)."""
    if _paths is None:
        return None
    return _paths.imatrix_dir.parent / "cartography_cache"


def _carto_disk_path(abs_path: Path, mtime: float, size: int) -> Path | None:
    cache_dir = _carto_cache_dir()
    if cache_dir is None:
        return None
    h = hashlib.sha256(f"{abs_path}|{int(mtime)}|{size}".encode("utf-8")).hexdigest()[:32]
    return cache_dir / f"{h}.json"


def _get_cached_cartography(source_path: Path, model_name: str, force: bool = False):
    """Cartography des poids avec cache RAM + DISQUE (mtime+size-keyed).

    Le cache disque rend le scan persistant aux restarts du daemon : un MiniMax
    déjà scanné n'est jamais re-scanné (sauf force=True ou mtime changé).
    """
    abs_path = source_path.resolve()
    try:
        st = abs_path.stat()
    except OSError as exc:
        raise RuntimeError(f"stat({abs_path}) échoué : {exc}") from exc
    mtime = st.st_mtime
    key = (str(abs_path), mtime)

    # 1) RAM
    if not force and key in _carto_cache:
        return _carto_cache[key]

    # 2) Disque
    disk_path = _carto_disk_path(abs_path, mtime, st.st_size)
    if not force and disk_path is not None and disk_path.exists():
        try:
            data = json.loads(disk_path.read_text(encoding="utf-8"))
            carto = cartography.Cartography.from_dict(data)
            if len(_carto_cache) >= _CARTO_CACHE_MAXSIZE:
                _carto_cache.pop(next(iter(_carto_cache)), None)
            _carto_cache[key] = carto
            log.info("cartography: cache DISQUE hit %s (%d tensors, pas de re-scan)",
                     disk_path.name, carto.n_tensors)
            return carto
        except Exception as exc:
            log.warning("cartography: lecture cache disque échouée %s : %s — re-scan",
                        disk_path, exc)

    # 3) Compute (lourd) puis remplit RAM + disque
    carto = cartography.compute_cartography(abs_path, model_name=model_name)
    if len(_carto_cache) >= _CARTO_CACHE_MAXSIZE:
        _carto_cache.pop(next(iter(_carto_cache)), None)
    _carto_cache[key] = carto
    if disk_path is not None:
        try:
            disk_path.parent.mkdir(parents=True, exist_ok=True)
            disk_path.write_text(
                json.dumps(carto.to_dict(), ensure_ascii=False), encoding="utf-8")
            log.info("cartography: écrit cache DISQUE %s (survit aux restarts)", disk_path.name)
        except Exception as exc:
            log.warning("cartography: écriture cache disque échouée %s : %s", disk_path, exc)
    return carto


def _header_specs(header: Any, model_name: str) -> dict[str, Any]:
    """Specs instantanées depuis le header (aucune lecture de valeurs)."""
    fams = gguf.group_by_family(header)
    families = []
    for fam, ts in sorted(fams.items(), key=lambda kv: -sum(t.bytes_current for t in kv[1])):
        types: dict[str, int] = {}
        for t in ts:
            types[t.type_name] = types.get(t.type_name, 0) + 1
        families.append({
            "family": fam,
            "category": surgical.family_category(fam),
            "count": len(ts),
            "params": sum(t.n_params for t in ts),
            "bytes": sum(t.bytes_current for t in ts),
            "types": types,
        })
    return {
        "model": model_name,
        "architecture": imatrix.detect_architecture(header.tensors),
        "total_params": header.total_params,
        "total_bytes": header.total_bytes,
        "n_tensors": len(header.tensors),
        "families": families,
        "health": None,
        "health_elapsed_sec": None,
    }


@router.post("/cartography")
async def cartography_scan(req: CartographyRequest):
    """Inspect d'un modèle : specs header (rapide) + santé des poids (opt-in, lourd).

    with_health=False → instantané (header). with_health=True → scan + déquant des
    valeurs (caché). Sert le popup Inspect ET le surgical sans-imatrix (qui passe
    plutôt par /surgical/preview source=cartography).
    """
    _require_enabled()
    src = Path(req.source_path)
    if not src.exists():
        raise HTTPException(404, f"source introuvable : {req.source_path}")
    model_name = src.name
    try:
        header = _get_cached_gguf_header(src)
    except Exception as exc:
        raise HTTPException(500, f"lecture header échouée : {exc}")
    out = _header_specs(header, model_name)
    if req.with_health:
        try:
            carto = _get_cached_cartography(src, model_name, force=req.force)
        except Exception as exc:
            raise HTTPException(500, f"scan cartography échoué : {exc}")
        out["architecture"] = carto.architecture
        out["health"] = cartography.family_health(carto)
        out["health_elapsed_sec"] = carto.elapsed_sec
        # Détail complet par tensor (pour l'export JSON / diff par bloc). ~733
        # entrées sur un 35B MoE = quelques dizaines de Ko, négligeable.
        out["tensors"] = [t.to_dict() for t in carto.tensors]
    return out


# ────────────────────────────────────────────────────────────────────────────
# Surgical preview (sync, léger)
# ────────────────────────────────────────────────────────────────────────────

@router.post("/surgical/preview")
async def surgical_preview(req: SurgicalPreviewRequest):
    """Génère un preset surgical depuis une imatrix existante — preview only.

    Pas de side-effect : ne sauvegarde rien. Le client (AtlasMind) reçoit
    le preset complet (tensor_overrides + family_quants) qu'il peut afficher,
    sauvegarder dans sa DB custom_presets, ou utiliser directement dans un
    payload `/quant/jobs` (Phase 2).
    """
    _, paths = _require_enabled()

    # Source des scores d'importance (top-X%/famille) : imatrix ou cartography.
    if req.source == "cartography":
        if not req.source_path:
            raise HTTPException(400, "source_path requis pour source=cartography")
        src = Path(req.source_path)
        if not src.exists():
            raise HTTPException(404, f"source introuvable : {req.source_path}")
        try:
            carto = _get_cached_cartography(src, src.name)
        except Exception as exc:
            raise HTTPException(500, f"scan cartography échoué : {exc}")
        tensors = cartography.to_tensorstats(carto)
        architecture = carto.architecture
        tensor_count = carto.n_tensors
        source_label = f"cartography:{src.name}"
    else:
        if not req.imatrix_name:
            raise HTTPException(400, "imatrix_name requis pour source=imatrix")
        if "/" in req.imatrix_name or "\\" in req.imatrix_name or ".." in req.imatrix_name:
            raise HTTPException(400, "imatrix_name invalide")
        p = paths.imatrix_dir / req.imatrix_name
        if not p.exists():
            raise HTTPException(404, f"imatrix introuvable : {req.imatrix_name}")
        try:
            data = imatrix.parse_imatrix(p)
        except Exception as exc:
            raise HTTPException(500, f"parse échoué : {exc}")
        tensors = data.tensors
        architecture = data.architecture
        tensor_count = len(data.tensors)
        source_label = req.imatrix_name

    try:
        preset, tier_counts = surgical.emit_preset(
            tensors=tensors,
            profile=req.profile,
            name=req.name,
            base=req.base,
            top_per_family=req.top_per_family,
            top_f16=req.top_f16,
            top_q8=req.top_q8,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except Exception as exc:
        raise HTTPException(500, f"emit_preset échoué : {exc}")

    # Estimation taille : si la source est fournie, parse son header GGUF puis
    # applique les règles du preset. None si pas de source — l'UI sait afficher
    # "—" dans ce cas. Pas raise sur exception : l'estimation est un nice-to-have,
    # le preset reste utilisable même si on ne peut pas l'évaluer.
    est_size_bytes: int | None = None
    est_current_bytes: int | None = None
    if req.source_path:
        try:
            src_hdr = _get_cached_gguf_header(Path(req.source_path))
            top_type = "Q8_0" if any(
                t.type_name.startswith("Q8") for t in src_hdr.tensors[:5]
            ) else "F16"
            est_size_bytes, est_current_bytes = surgical.estimate_preset_size(
                src_hdr, preset, top_type=top_type,
            )
        except Exception as exc:
            log.warning(f"size estimate failed for {req.source_path}: {exc!s}")

    return {
        "preset": preset,
        "tier_counts": tier_counts,
        "est_size_bytes": est_size_bytes,
        "est_current_bytes": est_current_bytes,
        "imatrix": source_label,
        "source": req.source,
        "architecture": architecture,
        "tensor_count": tensor_count,
    }


@router.post("/surgical/custom-preview")
async def surgical_custom_preview(req: CustomSurgicalPreviewRequest):
    """Génère un preset surgical custom — mapping per-family explicite.

    Mode principal du builder UI : l'utilisateur choisit le quant par famille
    (attn_k, ffn_down_exps, etc.) au lieu de laisser un profile décider. Permet
    le workflow validé en pratique (cf project_mastermind_ideas / config.yaml
    `Q_qwen3.6_custom` qui mixe Q8_0 sur attention + Q6_K sur experts + F16
    sur tout ce qui touche au routing/norms).

    Comme /surgical/preview, c'est sync léger : pas de side-effect, juste
    parse imatrix (ou scan cartography) + emit preset + retourne pour affichage
    / sauvegarde DB AtlasMind.
    """
    _, paths = _require_enabled()

    # Source des tensors/scores (familles + top-K% par sum_values) :
    # imatrix (calibration) ou cartography (l2_norm des poids, SANS calib).
    if req.source == "cartography":
        if not req.source_path:
            raise HTTPException(400, "source_path requis pour source=cartography")
        src = Path(req.source_path)
        if not src.exists():
            raise HTTPException(404, f"source introuvable : {req.source_path}")
        try:
            carto = _get_cached_cartography(src, src.name)
        except Exception as exc:
            raise HTTPException(500, f"scan cartography échoué : {exc}")
        tensors = cartography.to_tensorstats(carto)
        architecture = carto.architecture
        tensor_count = carto.n_tensors
        source_label = f"cartography:{src.name}"
    else:
        if not req.imatrix_name:
            raise HTTPException(400, "imatrix_name requis pour source=imatrix")
        if "/" in req.imatrix_name or "\\" in req.imatrix_name or ".." in req.imatrix_name:
            raise HTTPException(400, "imatrix_name invalide")
        p = paths.imatrix_dir / req.imatrix_name
        if not p.exists():
            raise HTTPException(404, f"imatrix introuvable : {req.imatrix_name}")
        try:
            data = imatrix.parse_imatrix(p)
        except Exception as exc:
            raise HTTPException(500, f"parse échoué : {exc}")
        tensors = data.tensors
        architecture = data.architecture
        tensor_count = len(data.tensors)
        source_label = req.imatrix_name

    try:
        preset, tier_counts = surgical.emit_preset_custom(
            tensors=tensors,
            name=req.name,
            base=req.base,
            family_quants=req.family_quants,
            top_per_family_f16=req.top_per_family_f16,
            f16_pins=req.f16_pins,
            bonus_type=req.bonus_type,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except Exception as exc:
        raise HTTPException(500, f"emit_preset_custom échoué : {exc}")

    est_size_bytes: int | None = None
    est_current_bytes: int | None = None
    if req.source_path:
        try:
            src_hdr = _get_cached_gguf_header(Path(req.source_path))
            top_type = "Q8_0" if any(
                t.type_name.startswith("Q8") for t in src_hdr.tensors[:5]
            ) else "F16"
            est_size_bytes, est_current_bytes = surgical.estimate_preset_size(
                src_hdr, preset, top_type=top_type,
            )
        except Exception as exc:
            log.warning(f"size estimate failed for {req.source_path}: {exc!s}")

    return {
        "preset": preset,
        "tier_counts": tier_counts,
        "est_size_bytes": est_size_bytes,
        "est_current_bytes": est_current_bytes,
        "imatrix": source_label,
        "source": req.source,
        "architecture": architecture,
        "tensor_count": tensor_count,
    }


# ────────────────────────────────────────────────────────────────────────────
# Validate GGUF (sync)
# ────────────────────────────────────────────────────────────────────────────

def _ensure_under_models_path(p: Path, paths) -> None:
    """Garde-fou : refuse les paths hors de models_path (bug-hunt #9 — sinon
    /quant/validate-gguf devenait un primitive de lecture arbitraire 4-byte
    via le magic GGUF leaké en error message)."""
    try:
        p.absolute().relative_to(paths.models_path.resolve())
    except ValueError:
        raise HTTPException(400, f"path hors de models_path : {p}")


@router.post("/validate-gguf")
async def validate_gguf(req: ValidateGgufRequest):
    """Compare un GGUF produit vs sa source. Retourne une liste de warnings.

    Si source_path est absent ou pointe vers un fichier inexistant, tente une
    résolution auto par base_name depuis le scan models_path. Évite à l'UI de
    deviner naïvement le path source (cas constaté : output dans `mercury/` mais
    source dans `qwen3.6/<base>-F16.gguf` — heuristique frontend tombait à côté).

    Sécurité : output_path ET source_path (si fourni) doivent être sous
    models_path — cf `_ensure_under_models_path`.
    """
    _, paths = _require_enabled()
    out = Path(req.output_path)
    _ensure_under_models_path(out, paths)
    if not out.exists():
        raise HTTPException(404, f"output introuvable : {out}")

    requested_src = Path(req.source_path) if req.source_path else None
    if requested_src is not None:
        _ensure_under_models_path(requested_src, paths)
    if requested_src and requested_src.exists():
        src = requested_src
    else:
        models = scan.scan_source_models(paths.models_path)
        match = scan.resolve_source_for_output(out, models)
        if match:
            src = match.first_shard
            log.info(
                f"validate-gguf: source auto-resolved {out.name} → "
                f"{src} (base_name={match.base_name})"
            )
        elif requested_src:
            raise HTTPException(
                404,
                f"source introuvable : {requested_src} "
                f"(et aucun match base_name dans {paths.models_path})",
            )
        else:
            raise HTTPException(
                400,
                f"source non fournie et aucun match base_name pour "
                f"{out.name} dans {paths.models_path}",
            )

    warnings = quantize.validate_output_gguf(src, out)
    return {
        "source_path": str(src),
        "output_path": str(out),
        "warnings": warnings,
        "ok": len(warnings) == 0,
    }


# ────────────────────────────────────────────────────────────────────────────
# Jobs — long-running pipeline (Phase 2)
# ────────────────────────────────────────────────────────────────────────────

class JobCreateRequest(BaseModel):
    type: str = Field(..., pattern="^(quantize|imatrix_build|analyze_gguf|calibration_build)$")
    payload: dict[str, Any]


def _require_manager() -> QuantManager:
    _require_enabled()
    mgr = get_manager()
    if mgr is None:
        raise HTTPException(503, "quant manager not initialized")
    return mgr


@router.post("/jobs")
async def create_job(req: JobCreateRequest):
    mgr = _require_manager()
    try:
        job = await mgr.submit_job(req.type, req.payload)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"job_id": job.id, "job": job.to_dict()}


@router.get("/jobs")
async def list_jobs(limit: int = 100):
    mgr = _require_manager()
    # Snapshot unique : sans ça, count peut diverger de len(jobs) si un job est
    # ajouté/retiré entre les 2 appels (audit R3-L9).
    jobs = mgr.list_jobs(limit)
    return {"jobs": [j.to_dict() for j in jobs], "count": len(jobs)}


@router.get("/jobs/{job_id}")
async def get_job(job_id: str):
    mgr = _require_manager()
    job = mgr.get_job(job_id)
    if not job:
        raise HTTPException(404, f"job {job_id} not found")
    return job.to_dict()


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: str):
    mgr = _require_manager()
    ok = await mgr.cancel_job(job_id)
    if not ok:
        raise HTTPException(404, f"job {job_id} not found or not cancellable")
    return {"cancelled": True, "job": mgr.get_job(job_id).to_dict() if mgr.get_job(job_id) else None}


@router.delete("/jobs/{job_id}")
async def delete_job(job_id: str):
    mgr = _require_manager()
    if not mgr.delete_job(job_id):
        raise HTTPException(409, f"job {job_id} not found or still running")
    return {"deleted": job_id}


@router.get("/jobs/{job_id}/log")
async def job_log(job_id: str, lines: int = 200):
    mgr = _require_manager()
    if not mgr.get_job(job_id):
        raise HTTPException(404, f"job {job_id} not found")
    return {"lines": mgr.tail_log(job_id, lines=lines)}


@router.get("/jobs/{job_id}/stream")
async def job_stream(job_id: str):
    """NDJSON stream des events live du job. Le client consomme ligne par ligne.

    Heartbeat émis toutes les 20s par le manager pour éviter le timeout Caddy.
    """
    mgr = _require_manager()
    if not mgr.get_job(job_id):
        raise HTTPException(404, f"job {job_id} not found")
    q = await mgr.stream(job_id)

    async def relay():
        try:
            while True:
                event = await q.get()
                yield (json.dumps(event) + "\n").encode("utf-8")
                # Si le job est terminé, on close après le dernier event done/cancelled/error.
                if event.get("event") in ("done", "cancelled", "error"):
                    # Laisse au client le temps de drainer
                    await asyncio.sleep(0.05)
                    break
        except asyncio.CancelledError:
            pass
        finally:
            mgr.remove_stream(job_id, q)

    return StreamingResponse(relay(), media_type="application/x-ndjson")
