"""Routes load / unload."""
import json
import logging

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from data import db as db_module
from routing.router import apply_db_overrides, get_config

from ._common import llamacpp_base, LOAD_TIMEOUT, _template_to_load_body

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/llamacpp/load")
async def post_llamacpp_load(body: dict):
    """Charge un modèle en appliquant son template DB. Body: { "model_id": "..." }"""
    base = llamacpp_base()
    if not base:
        return JSONResponse(status_code=400, content={"detail": "llamacpp désactivé"})
    model_id = (body.get("model_id") or body.get("model") or "").strip()
    if not model_id:
        return JSONResponse(status_code=400, content={"detail": "Champ 'model_id' requis"})

    # Récupérer le template (ou utiliser les defaults)
    template = db_module.get_llamacpp_template(model_id) or db_module.DEFAULT_LLAMACPP_TEMPLATE

    # Cohérence backend ↔ kind du modèle : DEFAULT_LLAMACPP_TEMPLATE.backend = native-vulkan
    # → un user qui clique Load sur un modèle HF (vLLM) sans avoir sauvé de template
    # chargerait en native-vulkan → brain-daemon cherche un GGUF → 404. On lookup le
    # `kind` côté brain-daemon et on auto-aligne le backend si incohérent.
    _entry = None
    try:
        async with httpx.AsyncClient(timeout=5.0) as _kc:
            _r_models = await _kc.get(f"{base}/mgmt/models")
        if _r_models.status_code == 200:
            _entry = next((m for m in _r_models.json() if m.get("model_id") == model_id or m.get("id") == model_id), None)
            _kind = (_entry or {}).get("kind", "gguf")
        else:
            _kind = "gguf"
    except Exception as _e:
        logger.warning("llamacpp load: lookup kind failed for %s: %s — assuming gguf", model_id, _e)
        _kind = "gguf"

    _tpl_backend = (template.get("load") or {}).get("backend", "")
    if _kind == "hf" and not _tpl_backend.startswith("vllm-"):
        # Auto-aligne sur vllm-rocm + ctx_size par défaut, garde extra_args si présent
        _load = dict(template.get("load") or {})
        _load["backend"] = "vllm-rocm"
        if not _load.get("ctx_size"):
            _load["ctx_size"] = 32768
        _load.setdefault("extra_args", [])
        template = {**template, "load": _load}
        logger.info("llamacpp load: model=%s kind=hf sans template → auto-backend vllm-rocm", model_id)
    elif _kind != "hf" and _tpl_backend.startswith("vllm-"):
        return JSONResponse(
            status_code=400,
            content={"detail": f"Template incohérent : modèle GGUF (kind={_kind}) avec backend vLLM ({_tpl_backend}). Édite le template."},
        )

    load_body = _template_to_load_body(model_id, template)

    # Refresh des presets AtlasMind avant load : si des presets sont assignés au
    # modèle, on re-fetch les valeurs courantes depuis AtlasMind plutôt que de
    # laisser le brain relire load_configs.json (snapshot figé au moment du
    # apply-preset). Garantit que modifier scale/cocktail sur AtlasMind est
    # reflété sans re-apply.
    #
    # Multi-select (apply-presets) : on lit `active_preset_ids` (liste exhaustive,
    # exposée par /mgmt/status depuis le refacto multi-LoRA). Fallback singleton
    # `[active_preset_id]` si la liste n'est pas présente (entry brain pre-multi).
    # On fetch les N presets en parallèle (asyncio.gather), puis on :
    #   - Concat les `lora_path` de tous les presets cochés (ordre = liste reçue)
    #     en `loras: [{path, default_scale}, ...]` qui va remplacer ce que le
    #     brain aurait pu mettre via son load_configs.json snapshot.
    #   - Prend les CV du PREMIER preset qui en a (cohérent avec apply-presets
    #     handler de routes_atlas.py — fusionner les CV de N presets avec
    #     layer_ranges potentiellement conflictuels est fragile).
    _entry_ids = (_entry or {}).get("active_preset_ids")
    _entry_id = (_entry or {}).get("active_preset_id")
    if isinstance(_entry_ids, list) and _entry_ids:
        active_preset_ids: list[int] = [int(pid) for pid in _entry_ids if pid is not None]
    elif _entry_id is not None:
        active_preset_ids = [int(_entry_id)]
    else:
        active_preset_ids = []
    # `active_preset_id` legacy pour les logs (premier id ou None).
    active_preset_id = active_preset_ids[0] if active_preset_ids else None

    if active_preset_ids:
        try:
            _cfg = get_config()
            _am_base = (_cfg.get("atlas_atlasmind_url") or "http://127.0.0.1:9300").rstrip("/")
            _am_key = (_cfg.get("atlas_atlasmind_api_key") or "").strip()
            _am_headers = {"Authorization": f"Bearer {_am_key}"} if _am_key else {}

            async def _fetch_preset(_pid: int):
                async with httpx.AsyncClient(timeout=10.0) as _pc:
                    return _pid, await _pc.get(
                        f"{_am_base}/api/atlasmind/presets/{_pid}",
                        headers=_am_headers,
                    )

            import asyncio as _asyncio
            _results = await _asyncio.gather(
                *(_fetch_preset(_pid) for _pid in active_preset_ids),
                return_exceptions=True,
            )
            # Sépare les succès des échecs sans tout péter (les autres presets peuvent
            # toujours apporter leurs LoRAs même si un seul est down côté AtlasMind).
            _fetched: list[tuple[int, dict]] = []
            for _r in _results:
                if isinstance(_r, BaseException):
                    logger.warning("llamacpp load: preset fetch raised: %s — ignored", _r)
                    continue
                _pid_done, _resp = _r
                if _resp.status_code == 200:
                    _fetched.append((_pid_done, _resp.json()))
                else:
                    logger.warning(
                        "llamacpp load: preset #%s fetch failed (status %s) — ignored from refresh",
                        _pid_done, _resp.status_code,
                    )

            if _fetched:
                # CV : on prend ceux du premier preset qui en a (cohérent avec apply-presets).
                _cv_chosen_pid: int | None = None
                _cv_chosen_preset: dict | None = None
                _cv_skipped: list[int] = []
                for _pid_iter, _p in _fetched:
                    try:
                        _ck = json.loads(_p.get("cocktail_json") or "[]")
                    except Exception:
                        _ck = []
                    _has = any(v.get("brain_path") for v in _ck)
                    if _has:
                        if _cv_chosen_pid is None:
                            _cv_chosen_pid = _pid_iter
                            _cv_chosen_preset = _p
                        else:
                            _cv_skipped.append(_pid_iter)
                if _cv_skipped:
                    logger.warning(
                        "llamacpp load: %d preset(s) ont des CV au-delà du premier (#%s) — CV ignorés : %s",
                        len(_cv_skipped), _cv_chosen_pid, _cv_skipped,
                    )

                if _cv_chosen_preset is not None:
                    try:
                        _cocktail = json.loads(_cv_chosen_preset.get("cocktail_json") or "[]")
                    except Exception:
                        _cocktail = []
                    _cvs = [
                        {"path": v["brain_path"], "scale": float(v.get("scale", 1.0))}
                        for v in _cocktail if v.get("brain_path")
                    ]
                    if _cvs:
                        # Backend vLLM/Lucebox ne supportent pas les control vectors
                        # (flag llama.cpp-only, cf _template_to_load_body) → on skip
                        # côté Mercury pour éviter le crash boot, même garde que le
                        # bloc LoRA plus bas.
                        _cv_backend = load_body.get("backend", "")
                        if _cv_backend.startswith("vllm-") or _cv_backend == "native-lucebox":
                            logger.warning(
                                "llamacpp load: preset #%s a %d control_vector(s) mais backend=%s ne supporte pas les CV — skipped",
                                _cv_chosen_pid, len(_cvs), _cv_backend,
                            )
                        else:
                            _layers = [int(v["layer"]) for v in _cocktail if v.get("layer") is not None]
                            if _layers:
                                _u = sorted(set(_layers))
                                _lr = [_u[0], _u[-1]]
                            else:
                                try:
                                    _lr = json.loads(_cv_chosen_preset["layer_range_json"]) if _cv_chosen_preset.get("layer_range_json") else None
                                except Exception:
                                    _lr = None
                            load_body["control_vectors"] = _cvs
                            if _lr:
                                load_body["control_vector_layer_range"] = _lr
                            logger.info(
                                "llamacpp load: preset #%s refreshed from AtlasMind — cv=%d layer_range=%s",
                                _cv_chosen_pid, len(_cvs), _lr,
                            )

                # LoRAs : concat de tous les `lora_path` des presets fetchés (ordre
                # = ordre des active_preset_ids reçus). Backend vLLM/Lucebox refusent
                # le flag --lora → on skip côté Mercury pour éviter le crash boot.
                _lb_backend = load_body.get("backend", "")
                if _lb_backend.startswith("vllm-") or _lb_backend == "native-lucebox":
                    _has_lora = any((p.get("lora_path") or "").strip() for _, p in _fetched)
                    if _has_lora:
                        logger.warning(
                            "llamacpp load: %d preset(s) lora_path set mais backend=%s ne supporte pas LoRA — skipped",
                            sum(1 for _, p in _fetched if (p.get("lora_path") or "").strip()),
                            _lb_backend,
                        )
                else:
                    _loras_stack: list[dict] = []
                    for _pid_iter, _p in _fetched:
                        _lp = (_p.get("lora_path") or "").strip()
                        if not _lp:
                            continue
                        _loras_stack.append({
                            "path": _lp,
                            "default_scale": float(_p.get("lora_scale") or 1.0),
                        })
                    if _loras_stack:
                        # On écrase ce que le template aurait pu poser (compat) et on
                        # remplace toujours par le stack frais — le user qui a appliqué
                        # N presets s'attend à voir EXACTEMENT ces N LoRAs au boot.
                        load_body["loras"] = _loras_stack
                        logger.info(
                            "llamacpp load: %d LoRA(s) injectés depuis presets %s : %s",
                            len(_loras_stack), active_preset_ids,
                            [(l["path"], l["default_scale"]) for l in _loras_stack],
                        )
                    else:
                        # Aucun preset coché n'apporte de LoRA → on s'assure de purger
                        # tout reste éventuel pour qu'il n'y ait pas de fantôme au boot.
                        load_body.pop("loras", None)
                        load_body.pop("lora", None)
                        logger.info(
                            "llamacpp load: presets %s n'apportent aucun LoRA — stack vide",
                            active_preset_ids,
                        )

                if _cv_chosen_preset is None:
                    logger.warning(
                        "llamacpp load: presets %s n'ont aucun control_vector exportable — "
                        "brain utilisera son snapshot load_configs.json (peut encore en avoir)",
                        active_preset_ids,
                    )
        except Exception as _pe:
            logger.warning(
                "llamacpp load: preset refresh failed for model=%s presets=%s: %s — brain utilisera son snapshot load_configs",
                model_id, active_preset_ids, _pe,
            )

    logger.info("llamacpp load: model=%s, kind=%s, backend=%s, ctx=%s, extra=%s", model_id, _kind, load_body["backend"], load_body["ctx_size"], load_body["extra_args"])

    try:
        async with httpx.AsyncClient(timeout=LOAD_TIMEOUT) as client:
            r = await client.post(f"{base}/mgmt/load", json=load_body)
        try:
            resp_body = r.json()
        except Exception:
            resp_body = {"error": r.text or str(r.status_code)}
        if r.status_code == 200:
            # Mettre le modèle en priorité 1 pour llamacpp
            cache_name = f"llamacpp/{model_id}"
            current = db_module.get_model_priority() or {}
            lc_list = list(current.get("llamacpp") or [])
            new_lc_list = [cache_name] + [x for x in lc_list if x != cache_name]
            db_module.set_model_priority({**current, "llamacpp": new_lc_list})
            apply_db_overrides()
            # Auto-restore KV cache si kv_cache_auto_dump activé dans le template
            template = db_module.get_llamacpp_template(model_id) or db_module.DEFAULT_LLAMACPP_TEMPLATE
            if template.get("load", {}).get("kv_cache_auto_dump", False):
                try:
                    async with httpx.AsyncClient(timeout=5.0) as kv_client:
                        status_r = await kv_client.get(f"{base}/mgmt/kv-cache/status/{model_id}")
                    if status_r.status_code == 200 and status_r.json().get("exists"):
                        async with httpx.AsyncClient(timeout=60.0) as kv_client:
                            restore_r = await kv_client.post(f"{base}/mgmt/kv-cache/restore/{model_id}")
                        if restore_r.status_code == 200:
                            logger.info("llamacpp load: KV cache restauré pour model=%s", model_id)
                        else:
                            logger.warning("llamacpp load: KV cache restore échoué model=%s: %s", model_id, restore_r.text[:200])
                except Exception as kv_exc:
                    logger.warning("llamacpp load: KV cache restore erreur model=%s: %s", model_id, kv_exc)
        else:
            logger.error("llamacpp load FAILED: model=%s, status=%d, daemon_response=%s", model_id, r.status_code, resp_body)
        return JSONResponse(status_code=r.status_code, content=resp_body)
    except Exception as e:
        logger.exception("POST /admin/llamacpp/load: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e)})


@router.post("/llamacpp/unload")
async def post_llamacpp_unload(body: dict):
    """Décharge une instance. Body: { "model_id": "..." }"""
    base = llamacpp_base()
    if not base:
        return JSONResponse(status_code=400, content={"detail": "llamacpp désactivé"})
    model_id = (body.get("model_id") or body.get("model") or "").strip()
    if not model_id:
        return JSONResponse(status_code=400, content={"detail": "Champ 'model_id' requis"})
    # Auto-save KV cache avant unload si kv_cache_auto_dump activé
    template = db_module.get_llamacpp_template(model_id) or db_module.DEFAULT_LLAMACPP_TEMPLATE
    if template.get("load", {}).get("kv_cache_auto_dump", False):
        try:
            async with httpx.AsyncClient(timeout=60.0) as kv_client:
                save_r = await kv_client.post(f"{base}/mgmt/kv-cache/save/{model_id}")
            if save_r.status_code == 200:
                logger.info("llamacpp unload: KV cache sauvegardé pour model=%s", model_id)
            else:
                logger.warning("llamacpp unload: KV cache save échoué model=%s: %s", model_id, save_r.text[:200])
        except Exception as kv_exc:
            logger.warning("llamacpp unload: KV cache save erreur model=%s: %s", model_id, kv_exc)
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(f"{base}/mgmt/unload", json={"model_id": model_id})
        try:
            resp_body = r.json()
        except Exception:
            resp_body = {"error": r.text or str(r.status_code)}
        return JSONResponse(status_code=r.status_code, content=resp_body)
    except Exception as e:
        logger.exception("POST /admin/llamacpp/unload: %s", e)
        return JSONResponse(status_code=500, content={"detail": str(e)})
