# brain-daemon — module `atlas/` (v0.2)

Module opt-in pour l'extraction de control vectors via `llama-extract-vector`
(binaire C++ Vulkan natif du fork `atomic-llama-cpp-turboquant`).

## Architecture v0.2 (post-pivot natif 2026-05-20)

```
HTTP request /atlas/extract → routes.py
                            ↓
                       manager.py (async orchestration)
                            ↓
                       extractor.py (subprocess wrapper)
                            ↓
                  llama-extract-vector (C++ Vulkan)
                            ↓
                         GGUF output
```

L'historique v0.1 utilisait `transformers` + `torch` en Python. Le pivot v0.2
vers le binaire C++ natif élimine ces dépendances en prod tout en gardant un
contrat HTTP identique côté caller (atlasmind ne voit pas la différence).

## Activation

Ajouter à `config.yaml` de brain-daemon :

```yaml
atlas:
  enabled: true
  output_dir: /var/lib/atlas/vectors           # où les .gguf produits sont écrits
  extractor_binary: /opt/llamacpp-atlas/build/bin/llama-extract-vector
                                                # null = auto-discovery PATH
  default_ngl: 99                              # n_gpu_layers Vulkan par défaut
  default_threads: 8                           # CPU threads par défaut
  cleanup_temp_files: true                     # supprimer le tmp/ avec les prompts.txt après run
  serialize_extractions: true                  # une extraction à la fois (brain single-GPU)
```

Puis créer le dossier output avec les bonnes permissions :

```bash
sudo mkdir -p /var/lib/atlas/vectors
sudo chown $(whoami):$(whoami) /var/lib/atlas/vectors
```

Aucune dépendance Python supplémentaire requise — atlas v0.2 ne tire plus
torch / transformers / sklearn / accelerate. Le seul nouveau composant est
le binaire C++ qui doit être build depuis `atomic-llama-cpp-turboquant`.

## Patch daemon.py

Déjà appliqué dans le repo (6 lignes opt-in) :

```python
from atlas.routes import router as atlas_router, init_atlas
# ...
app.include_router(atlas_router, prefix="/atlas")
# ...
if config.get("atlas", {}).get("enabled", False):
    init_atlas(config, brain_manager=manager)
    logger.info("Atlas module initialized")
```

## Endpoints exposés

| Route | Méthode | Description |
|---|---|---|
| `/atlas/health` | GET | status (toujours répond même si désactivé) |
| `/atlas/models` | GET | list de modèles découverts (TODO autodiscovery v1.1) |
| `/atlas/extract` | POST | extraction synchrone (renvoie résultat final) |
| `/atlas/extract/stream` | POST | extraction streaming NDJSON (recommandé) |
| `/atlas/test` | POST | test inférence avec vecteurs appliqués (stub v1.1) |

## Format payload `/extract` (inchangé vs v0.1)

```json
{
  "model": "/home/<user>/.lmstudio/models/Google/gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q4_K_M.gguf",
  "dataset": {
    "name": "weird",
    "pairs": [
      {"pos": "...", "neg": "..."},
      ...
    ]
  },
  "layer": 20,
  "ngl": 99,
  "threads": 8,
  "method": "diff-of-means",
  "probe_eval": true,
  "max_pairs": null,
  "seed": null,
  "model_hint": null
}
```

Note importante par rapport à v0.1 :
- `model` est maintenant un **path .gguf** (quant existant), plus un HF id de safetensors
- Plus de `dtype` / `device` — Vulkan natif gère
- `ngl` et `threads` sont les controls llama.cpp standard

## Format réponse `/extract` (inchangé vs v0.1)

```json
{
  "vector_bytes_b64": "<base64 .gguf bytes>",
  "metadata": {
    "layer": 20,
    "hidden_dim": 4096,
    "n_layers": 56,
    "probe_accuracy": 0.92,
    "vector_norm": 4.32,
    "delta_norm": 4.32,
    "cosine_pos_neg": 0.85,
    "model_hint": "gemma",
    "method": "diff-of-means",
    "n_pairs": 100,
    "bad_count": 0,
    "sha256": "...",
    "model_id_source": "...",
    "vector_path_remote": "/var/lib/atlas/vectors/..."
  },
  "size_bytes": 16432
}
```

## Format stream `/extract/stream` (NDJSON, enrichi vs v0.1)

Une ligne JSON par event :

```
{"event":"queued","job_id":"..."}
{"event":"writing_prompts","tmp_dir":"..."}
{"event":"spawning","binary":"...","args":[...]}
{"event":"loaded","n_layers":56,"hidden_dim":4096}
{"event":"progress","label":"pos","done":42,"total":100}
{"event":"progress","label":"neg","done":42,"total":100}
{"event":"computing"}
{"event":"exporting"}
{"event":"subprocess_done","exit_code":0}
{"event":"result","vector_bytes_b64":"...","metadata":{...},"size_bytes":16432}
{"event":"error","message":"...","stage":"init|load|extract|compute|export|subprocess|post"}
```

## Contrat avec `llama-extract-vector` (C++)

Le binaire doit respecter EXACTEMENT cette interface pour que le wrapper
Python le consomme correctement.

**CLI args** :
```
llama-extract-vector \
    --model <path/to/model.gguf> \
    --prompts-pos <path/to/pos.txt> \     # un prompt par ligne UTF-8
    --prompts-neg <path/to/neg.txt> \
    --layer <int> \
    --output <path/to/output.gguf> \
    --model-hint <gemma|llama|qwen|mistral|phi|mixtral> \
    --dataset-name <str> \
    --method diff-of-means \
    --ngl <int> \
    --threads <int> \
    [--probe-eval] [--max-pairs N] [--seed N]
```

**stdout NDJSON streaming** (1 event/ligne, fflush après chaque) :
```
{"event":"loaded","n_layers":N,"hidden_dim":N}
{"event":"progress","label":"pos|neg","done":N,"total":M}
{"event":"computing"}
{"event":"exporting"}
{"event":"done","output":"...","probe_accuracy":F,"vector_norm":F,
 "delta_norm":F,"cosine_pos_neg":F,"sha256":"...","n_pairs":N,
 "hidden_dim":N,"layer":N,"bad_count":N}
{"event":"error","message":"...","stage":"load|extract|compute|export"}
```
stderr : libre (logs llama.cpp). Exit 0 = OK, 1 = erreur.

**GGUF output schema** (compatible llama.cpp `--control-vector`) :
```
general.architecture     = "controlvector"
controlvector.model_hint = <str>
controlvector.layer_count = 1
atlasmind.dataset_name   = <str>
atlasmind.method         = "diff-of-means"
atlasmind.n_pairs        = <int>
atlasmind.layer          = <int>
atlasmind.probe_accuracy = <float>   # 0.0 si non calculé
atlasmind.vector_norm    = <float>
tensor direction.<layer> = shape (hidden_dim,) f32
```

**Regression test obligatoire** :
`cosine_similarity(v_python_poc, v_cpp_binary) ≥ 0.95` sur même dataset/model/layer.

Référence Python pour le calcul attendu : `ATLASMIND/poc/extract_vector.py`.

## Lifecycle d'une extraction

1. atlasmind (VPS) POST `/atlas/extract/stream` via Mercury
2. Mercury proxy vers brain `/atlas/extract/stream` (whitelist + rate-limit)
3. brain `routes.py` → `manager.extract_stream(payload)`
4. manager sérialise les pairs en `/tmp/atlas-extract-XXX/{pos.txt, neg.txt}`
5. manager spawn `llama-extract-vector` via `extractor.run_extract()`
6. binaire C++ charge le modèle (Vulkan ~5-30s selon size + quant)
7. binaire forward chaque prompt, capture hidden_states[layer] last token
8. binaire compute diff-of-means + normalize + (optional) probe accuracy
9. binaire écrit le .gguf au `--output` path
10. manager lit le .gguf, base64-encode, emit event `"result"` final
11. manager cleanup le tmp dir (si `cleanup_temp_files: true`)
12. atlasmind reçoit le stream et stocke dans son SQLite + persiste le .gguf

## Anatomie du module

```
atlas/
├── __init__.py
├── routes.py        APIRouter (HTTP endpoints, contrat préservé v0.1↔v0.2)
├── manager.py       AtlasManager (async orchestration, lifecycle, locking)
├── extractor.py     subprocess wrapper (spawn binaire + parse NDJSON)
├── compute.py       DEPRECATED stub (logique en C++)
├── exporter.py      DEPRECATED stub (GGUF écrit par C++)
└── README.md        (ce fichier)
```

## Pourquoi cette archi

- **Process isolation** : un crash du binaire (OOM, segfault Vulkan, etc.) ne
  tue pas brain-daemon. Le wrapper Python recouvre l'erreur via exit code.
- **Pas de fuite mémoire intra-process** : chaque extraction = fresh subprocess.
- **Vulkan natif** : 5-10× plus rapide que CPU transformers pour les forward
  pass (validé 70 t/s gen sur Strix Halo 8060S Q4_K_M).
- **Utilise les quants existants** : pas besoin de re-DL le modèle non-quanté
  (15-60 GB économisés selon size). Cohérence quant ↔ vecteur (le vecteur est
  extrait sur EXACTEMENT le modèle qu'on va steer).
- **Deps allégées** : brain-daemon n'a plus besoin de torch/transformers/
  sklearn en prod.

## Si le binaire n'est pas installé

Au boot avec `atlas.enabled: true`, le manager probe le binaire et logge un
warning si introuvable. Les extractions échouent alors immédiatement avec une
erreur claire via event `{"event":"error","stage":"init"}` — pas de crash de
brain-daemon, juste un endpoint qui retourne 500 avec message d'install.

Pour installer le binaire : voir `atomic-llama-cpp-turboquant` fork + commande
cmake / install habituelle (cf `memory/project_atomic_turboquant.md`).

## Regression test (à run après chaque rebase upstream du fork)

```bash
# 1. Génère les prompts depuis weird.json
jq -r '.pairs[:10][].pos' ATLASMIND/datasets/weird.json > /tmp/pos.txt
jq -r '.pairs[:10][].neg' ATLASMIND/datasets/weird.json > /tmp/neg.txt

# 2. Run le binaire C++
llama-extract-vector \
    --model ~/.lmstudio/models/Google/gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q4_K_M.gguf \
    --prompts-pos /tmp/pos.txt --prompts-neg /tmp/neg.txt \
    --layer 20 --output /tmp/cpp_vec.gguf \
    --model-hint gemma --dataset-name weird_smoke \
    --method diff-of-means --ngl 99 --threads 8 --probe-eval

# 3. Run le POC Python (regression source-of-truth)
cd ATLASMIND/poc && source venv/bin/activate
python extract_vector.py \
    --model <path d'un Gemma sur lequel transformers peut load — E4B safetensors > \
    --dataset ../datasets/weird.json --layer 20 \
    --output /tmp/py_vec.gguf --max-pairs 10 --device cpu --dtype fp32

# 4. Compare
python3 -c "
import gguf, numpy as np
def load(p):
    r = gguf.GGUFReader(p)
    t = next(t for t in r.tensors if t.name.startswith('direction'))
    return np.array(t.data, dtype=np.float32)
v1 = load('/tmp/py_vec.gguf')
v2 = load('/tmp/cpp_vec.gguf')
cos = float(np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2)))
print(f'cosine_similarity = {cos:.4f}')
assert cos > 0.95, f'TOO LOW: {cos}'
print('OK regression passes')
"
```

Si <0.95 : debug avant tout déploiement. Probablement un détail de
tokenisation, de quel token capturer (last? mean pool?), ou de normalisation.

## Sécurité

- Atlas désactivé par défaut.
- Le binaire C++ tourne dans le process brain-daemon (même UID).
- Les .gguf produits restent dans `output_dir` (config), pas d'accès aux poids
  du modèle source — read-only extraction.
- Les prompts.txt temporaires sont nettoyés après run (si `cleanup_temp_files: true`).
