# brain-quant

TUI standalone pour produire des quantifications custom de GGUF sur le brain
(Strix Halo), via toolbox `amd-strix-halo-toolboxes`.

Pipeline :

1. **Scan** `~/.lmstudio/models` pour GGUF F16/BF16 (shards groupés)
2. **TUI** : sélection modèle → calibration → quant(s) → confirmation
3. **imatrix** via `toolbox run -c <toolbox> llama-imatrix`
4. **quantize** N variantes avec tensor-type overrides (routers MoE + emb/out en F16)
5. **Sortie** dans `<models_path>/mercury/<model>-brain-<quant>.gguf`

Aucune dépendance au daemon — le script est 100% autonome. Le daemon
découvrira automatiquement les GGUF produits au prochain `GET /mgmt/models`
(scan récursif sur `models_path`).

---

## Installation

Les wrappers `brain-quant` et `brain-calib` gèrent l'installation tout seuls
au premier run (création venv + install deps) :

```bash
cd /opt/llamacpp-daemon/quantize
chmod +x brain-quant brain-calib           # au cas où
./brain-quant                              # premier lancement = setup auto
```

Dépendances système :
- `toolbox` CLI (podman)
- toolbox `llama-vulkan-radv` (défaut) et/ou `llama-rocm-7.2` créée
- `python3` ≥ 3.10

### Alias pratiques (optionnel)

Dans `~/.bashrc` ou `~/.zshrc` :
```bash
alias brain-quant='/opt/llamacpp-daemon/quantize/brain-quant'
alias brain-calib='/opt/llamacpp-daemon/quantize/brain-calib'
```

Après `source ~/.bashrc` tu peux lancer depuis n'importe où.

---

## Usage

```bash
# Dans tmux (recommandé — run long, 1h à 3h)
tmux new -s brain-quant
cd /opt/openrouter-llamacpp-daemon/quantize
source .venv/bin/activate
./brain-quant.py
```

Le script te guide en 4 écrans puis demande confirmation :

```
╭──── brain-quant — confirmation ────╮
│ Source         gemma-4-26B-A4B-it   │
│                52.3 GB · 2 shards   │
│                                     │
│ Calibration    sparring-fr.txt      │
│                ~525k tokens         │
│                                     │
│ Imatrix        à calculer — ~85 min │
│                                     │
│ Quants         2 variantes          │
│                • UD-Q6_K_XL ~21 GB  │
│                • UD-Q5_K_M ~17 GB   │
│                                     │
│ Output         .../mercury/         │
│   └ gemma-4-26B-A4B-it-brain-UD-Q6_K_XL.gguf
│   └ gemma-4-26B-A4B-it-brain-UD-Q5_K_M.gguf
│                                     │
│ Toolbox        llama-vulkan-radv    │
│ Flags          -fa 1 --no-mmap      │
│ Durée est.     ~2h15                │
╰─────────────────────────────────────╯

? Lancer la pipeline ? (Y/n)
```

---

## Configuration

Éditer `config.yaml` pour changer :

- `models_path` — racine scan (doit matcher le daemon)
- `output_subdir` — sous-dossier de sortie (default : `mercury`)
- `calibration_dir` — où chercher les `.txt` de calibration
- `toolbox` — default (override interactif possible)
- `imatrix.chunks` / `ctx` / `batch` — taille du calcul imatrix
- `quants` — liste des quants proposés dans le menu TUI

---

## Corpus de calibration

### Option 1 : auto depuis shared-memory (recommandé)

`build-calibration.py` parcourt ton `shared-memory` complet, filtre le bruit
machine, dédupe, mélange les paragraphes, et produit un `perso.txt` optimisé
pour ton usage réel :

```bash
./build-calibration.py                          # utilise config.yaml
./build-calibration.py --source ~/autre/dossier
./build-calibration.py --exclude secret Personal .secrets
```

Filtres appliqués automatiquement :
- **YAML frontmatter** retiré en tête de fichier
- **Blocs `### TOOL`** (dumps de ls, JSON, outputs) supprimés
- **Headers `### USER/ASSISTANT (timestamp)`** retirés (sinon "USER" et
  "ASSISTANT" deviennent sur-représentés dans la distrib)
- **Lignes système** (`[Contexte compacté le ...]`, `✓ model → ...`)
- **Timestamps isolés** (`Tue Mar 24 2026 19:18:35 GMT...`)
- **Clusters de dump `ls -F`** (≥3 lignes `d  dir` / `f  file` consécutives)
- **Code blocks > 50 lignes** (probables logs)
- **Tables markdown > 30 rows** (data dumps)
- **Paragraphes < 20 caractères** (titres orphelins)
- **Dédup exact** sur hash SHA1 du paragraphe normalisé (lowercase + ws
  collapsed). Indispensable — les "résumés conversation précédente" se
  dupliquent massivement à travers les archives.

Paragraphes **mélangés** par défaut (seed=42 reproductible). Raison :
llama-imatrix traite en chunks de 4096 tokens. Si un chunk tombe entièrement
sur un seul sujet, les stats d'activation sont biaisées. Mélanger assure
que chaque chunk voit un échantillon diversifié.

Sortie dans `calibration/perso.txt`, visible automatiquement par
`brain-quant.py` au prochain run.

### Option 2 : corpus manuel

Pose n'importe quel `.txt` dans `calibration/`, il apparaîtra dans le menu.

Le TUI annote les fichiers par taille :
- `⚠ petit` si < 50k tokens
- `✓ optimal` si 200-600k tokens
- `⚠ très long` si > 1.5M tokens (coûteux sans gain significatif)

### Enrichir depuis des exports externes

```bash
cat ~/exports-chatgpt/*.txt       >> calibration/externes.txt
cat ~/lectures-ocr/*.txt          >> calibration/externes.txt
cat ~/notes-obsidian/**/*.md      >> calibration/externes.txt
```

Puis pointer le TUI sur `externes.txt`, ou ajouter le dossier à
`shared-memory` et relancer `build-calibration.py`.

---

## Naming convention

| Input | Output |
|---|---|
| `gemma-4-26B-A4B-it-F16-00001-of-00002.gguf` | `gemma-4-26B-A4B-it-brain-UD-Q6_K_XL.gguf` |
| `Qwen3.5-35B-A3B-BF16-00001-of-00002.gguf` | `Qwen3.5-35B-A3B-brain-UD-Q5_K_M.gguf` |

Règle : strip suffix `-F16*` / `-BF16*` / `-NNNNN-of-NNNNN`, append `-brain-<QUANT>.gguf`.

---

## Tensor-type overrides (UD-* / *_XL)

Appliqués automatiquement aux quants `UD-*` et `*_XL` :

| Tensor | Override | Pourquoi |
|---|---|---|
| `token_embd` | F16 | ~1% du poids, énorme impact qualité |
| `output.weight` | F16 | idem, préserve la distribution finale |
| `ffn_gate_inp.*` | F16 | **routers MoE** — critique, 0.1% du poids |
| `attn_{k,q,v,output}.*` | Q8_0 | précision attention > précision FFN |
| FFN autres | base quant (Q6_K, Q5_K_M...) | le gros du volume |

C'est la recette Unsloth Dynamic, reproduite avec les flags `--tensor-type`
de llama-quantize. Si ta toolbox est trop vieille et le flag manque, le
script échoue proprement à l'étape de check.

---

## Durées estimées (Strix Halo, Vulkan RADV)

Pour un F16 de 52 Go (Gemma 4 26B A4B) avec 200 chunks calibration :

| Étape | Durée |
|---|---|
| Imatrix (200 chunks × 4096 ctx) | ~85 min |
| 1 quant (variante custom) | ~25 min |
| 3 quants (même imatrix) | ~75 min |
| **Total pipeline complète** | **~2h40** |

ROCm 7.2 : ~5-10 % plus rapide sur l'imatrix, identique sur le quant (CPU-bound).

Imatrix calculée → réutilisable indéfiniment, survit aux re-runs et aux
re-téléchargements du modèle. Centralisées dans un dossier dédié (configurable
via `imatrix_dir` dans `config.yaml`, default `~/mercury/matrix/`) :
```
~/mercury/matrix/<model-base>-<hash>.imatrix
```

Le hash (8 chars du SHA1 du chemin relatif) évite les collisions entre deux
modèles qui partagent le même basename (ex: `gemma-F16.gguf` dans deux
sous-dossiers). Le TUI détecte automatiquement les imatrix existantes et
propose de les réutiliser.

---

## Logs

Chaque run écrit un log complet dans :
```
~/.cache/brain-quant/run-<timestamp>-<model>.log
```

Contient tous les outputs `llama-imatrix` et `llama-quantize` pour debug
post-mortem.

---

## Quality eval auto

À la fin du pipeline (après tous les `llama-quantize`), brain-quant propose
optionnellement de lancer une **quality eval reproductible** sur les GGUF
produits. Suite par défaut : `calibration/quality_suite.jsonl` (18 samples
courts en FR/EN couvrant knowledge, reasoning, coding, tool_use,
long_context, formatting, safety).

Chaque sample exécute un `llama-cli --jinja` (chat template appliqué
automatiquement → fonctionne sur Gemma, Qwen, Mistral, etc.) avec
`temperature=0` pour un signal déterministe. Le scoring est automatique :

| Scorer | Effet |
|---|---|
| `contains` | passed si une des `expected` strings est dans l'output |
| `contains_all` | passed si toutes les `expected` strings sont présentes |
| `exact` | match exact après strip |
| `regex` | regex match (case-insensitive, dotall) |
| `json_valid` | output parse en JSON (markdown fences ```json``` tolérées) |
| `json_contains` | parse JSON + tous les couples `expected{key:value}` matchent |

À la fin, table comparative pass_rate par catégorie pour les N quants :

```
              UD-Q6_K_XL    UD-Q5_K_M    UD-Q4_K_M
coding          100%          100%         67%
formatting      100%          100%        100%
knowledge       100%          100%        100%
long_context    100%           50%         50%
stem_reasoning   75%           75%         50%
tool_use        100%          100%        100%
Overall         95.0%         88.9%       77.8%
```

Tu vois immédiatement où la dégradation tombe (ex: Q4 perd 25 pp sur reasoning →
ship Q5).

Rapports JSON détaillés (un par quant) :
```
~/.cache/brain-quant/quality-<timestamp>-<gguf-stem>.json
```

Format : `schema=brain-quant.gguf_quality_eval.v1`, contient summary global,
per-category, et un dump par sample (prompt, stdout, stderr_tail, score
detail). Permet de reproduire et debugger un échec.

### Lancer manuellement la quality eval

```bash
cd /opt/llamacpp-daemon/quantize
source .venv/bin/activate
python quality_eval.py \
  ~/.lmstudio/models/mercury/gemma-4-26B-A4B-it-brain-UD-Q5_K_M.gguf \
  --suite calibration/quality_suite.jsonl \
  --output /tmp/quality-q5.json \
  --toolbox llama-vulkan-radv \
  --quant-name UD-Q5_K_M
```

### Étendre la suite

Ajoute un sample en append au JSONL :

```jsonl
{"id":"my_test","category":"reasoning","prompt":"...","expected":["..."],"scorer":"contains","max_tokens":32}
```

Catégories libres (apparaissent dans la table comparative), `max_tokens` par
défaut = 64. Pour `tool_use`, préfère `json_contains` avec un dict `expected`.

Coût indicatif : 18 samples × ~8s/sample × N quants = ~2.5 min/quant
sur Strix Halo. Largement amorti vs tester à la main dans Mercury.

---

## Workflow recommandé

1. `tmux new -s brain-quant`
2. `./brain-quant.py` → TUI → confirme
3. `Ctrl-b d` pour détacher
4. Laisse tourner 2-3h
5. `tmux attach -t brain-quant` pour checker
6. À la fin : les GGUF sont dans `~/.lmstudio/models/mercury/`
7. Le daemon les voit au prochain `/mgmt/models` — load direct :

```bash
curl -X POST http://127.0.0.1:4321/mgmt/load \
  -H 'Content-Type: application/json' \
  -d '{
    "model_id": "mercury/gemma-4-26B-A4B-it-brain-UD-Q6_K_XL",
    "ctx_size": 32768,
    "backend": "vulkan"
  }'
```
