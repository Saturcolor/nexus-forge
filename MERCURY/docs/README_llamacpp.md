## Documentation LlamaCpp / llama.cpp (Mercury)

Ce document récapitule **tous les arguments principaux** utilisables avec LlamaCpp / `llama.cpp` dans ton setup Mercury :

- **Options de chargement du modèle** (daemon `/mgmt/load`, templates `llamacpp`)
- **Paramètres de génération** (chat / completions)
- **Options de cache KV** (dont `unified_kv_cache`)
- **Streaming & métriques d’usage (tokens)**

L’objectif est d’avoir une **référence rapide** quand tu ajustes un template ou le daemon.

---

## 1. Options de chargement modèle (daemon `/mgmt/load`, templates `llamacpp`)

Ces options contrôlent **comment le modèle est chargé en mémoire** par le daemon `llamacpp` (ou `llama-server`).  
Elles viennent en général de ton template (`load` / `options`) et sont transformées en corps JSON pour `/mgmt/load`.

### 1.1. Champs supportés côté Mercury

- **`ctx_size`**
  - **Rôle**: longueur maximum du contexte en tokens (équivalent `n_ctx` côté `llama.cpp`).
  - **Effet**: détermine combien de tokens prompt + génération peuvent tenir dans une seule requête.
  - **Valeurs typiques**: `4096`, `8192`, `32768`, `131072`…
  - **Attention**: plus c’est grand, plus la **mémoire VRAM/RAM** consommée par le KV cache augmente.

- **`n_gpu_layers`**
  - **Rôle**: nombre de couches du modèle offloadées sur le GPU (`-ngl` en CLI).
  - **Effet**: plus de couches sur GPU ⇒ génération plus rapide, mais consomme plus de VRAM.
  - **Valeurs**:
    - `0` → tout sur CPU
    - `N > 0` → N premières couches sur GPU
    - `-1` → toutes les couches sur GPU (si VRAM suffisante)

- **`flash_attn`**
  - **Rôle**: activer la Flash Attention si le binaire / build le supporte.
  - **Effet**: accélère l’Attention, surtout pour de grands contextes et sur GPU.
  - **Valeurs**: `true` / `false`
  - **Remarque**: certains builds n’implémentent pas Flash Attention pour tous les backends.

- **`no_mmap`**
  - **Rôle**: désactiver l’utilisation de `mmap` pour le chargement des poids.
  - **Effet**:
    - `false` (défaut typique): utilise `mmap`, plus efficace en mémoire et en démarrage.
    - `true`: charge le modèle entièrement en RAM; peut aider sur certains systèmes / FS exotiques.

- **`parallel`**
  - **Rôle**: niveau de parallélisme du daemon (interprété par l’implémentation serveur).
  - **Effet général**: jusqu’à combien de requêtes peuvent être traitées en parallèle / pipeliné.
  - **Valeurs**: `1`, `2`, `4`… selon les capacités CPU/GPU.

- **`ctx_shift`**
  - **Rôle**: activer le « context shifting » ou fenêtres glissantes.
  - **Effet**: permet de supporter des conversations longues en déplaçant la fenêtre de contexte au lieu de tout rejeter.
  - **Remarque**: la sémantique exacte peut dépendre de la version du daemon; sert à mieux gérer la croissance du KV sur de longues sessions.

- **`unified_kv_cache`**
  - **Rôle**: activer le **cache KV unifié** (`kv_unified` dans `llama_context_params`).
  - **Effet**:
    - Le daemon utilise un **buffer KV partagé** entre différentes séquences / requêtes.
    - Peut améliorer l’empreinte mémoire et la gestion de contextes longs / multiples sessions.
  - **Valeurs**: `true` / `false`
  - **Lien interne**: mappé vers `kv_unified: bool` côté `llama.cpp`.

- **`extra_args`**
  - **Rôle**: passer des flags CLI **bruts** au binaire `llama-server` / daemon.
  - **Type**: liste de chaînes.
  - **Exemples**:
    - `["--host", "0.0.0.0"]`
    - `["--mlock"]`
  - **Attention**: non typé; tu peux casser le démarrage si les flags sont invalides.

---

## 2. Paramètres de contexte bas niveau (`llama_context_params`)

Ces champs existent côté `llama.cpp` et sont parfois exposés directement ou indirectement via le daemon (ou `llama-cpp-python`).  
Ils expliquent la **logique interne** derrière certaines options de template.

- **`n_ctx`**
  - Longueur de contexte effective en tokens.
  - Correspond globalement à ton `ctx_size`.

- **`n_batch`**
  - Taille de batch logique pour le traitement du prompt (appel à `llama_decode`).
  - Plus grand = plus rapide sur GPU, mais plus de mémoire.

- **`n_ubatch`**
  - Taille de sous-batch physique.
  - Optimisation avancée, parfois réglée automatiquement.

- **`n_threads`**
  - Threads utilisés pour la génération token par token.

- **`n_threads_batch`**
  - Threads utilisés pour le traitement du prompt / batch initial.

- **`pooling_type`**
  - Type de pooling utilisé pour les embeddings (NONE / MEAN / CLS / LAST / RANK).

- **`rope_scaling_type`**
  - Stratégie de RoPE scaling (ex: LINEAR, YARN, LONGROPE).

- **`rope_freq_base`, `rope_freq_scale`**
  - Paramétrage fin de RoPE (base et scale des fréquences).

- **`yarn_ext_factor`, `yarn_attn_factor`**
  - Paramètres spécifiques au mode YaRN (extrapolation du contexte).

- **`type_k`, `type_v`**
  - Type de quantization pour K et V dans le KV cache (ex: f16, q8_0…).
  - Impact direct sur **mémoire du KV cache** et parfois les perfs.

- **`offload_kqv`**
  - Indique si K/Q/V sont offloadés sur GPU.

- **`flash_attn`**
  - Identique à l’option de chargement `flash_attn`: active Flash Attention.

- **`op_offload`**
  - Offload d’opérations supplémentaires host → device.

- **`swa_full`**
  - Utilisation d’un cache SWA pleine taille (optimisation avancée).

- **`kv_unified`**
  - **Champ interne correspondant à `unified_kv_cache`.**
  - Active le buffer KV unifié / partagé.

- **`embeddings`**
  - Si `true`: le contexte est configuré pour retourner des embeddings (endpoints d’embedding).

---

## 3. Paramètres de génération (chat / completions)

Ces paramètres sont passés **par requête** sur les endpoints de type OpenAI (`/v1/chat/completions`, etc.) du daemon LlamaCpp.  
Ils contrôlent la **créativité, la longueur et la forme** de la génération.

- **`max_tokens`**
  - **Rôle**: nombre maximum de tokens générés pour la réponse.
  - **Valeurs**:
    - `> 0` → limite stricte.
    - `None` ou `-1` (selon implémentation) → pas de limite explicite (mais borné par le contexte).

- **`temperature`**
  - **Rôle**: contrôle l’aléatoire.
  - `0` → déterministe (toujours le même token le plus probable).
  - `0.2–1.0` → plage habituelle.
  - `> 1` → très créatif / chaotique.

- **`top_k`**
  - **Rôle**: garde seulement les `k` meilleurs tokens avant sampling.
  - `0` → désactivé.
  - Valeurs courantes: `40`, `50`, `100`.

- **`top_p`**
  - **Rôle**: nucleus sampling (garder les tokens dont la somme des probas ≤ `p`).
  - Valeurs typiques: `0.8–0.95`.
  - Plus petit = sorties plus « focalisées ».

- **`min_p`**
  - **Rôle**: minimum-p sampling; écarte les tokens très peu probables même si `top_p` les laisserait.
  - Option avancée; peut stabiliser le comportement.

- **`typical_p`**
  - **Rôle**: locally-typical sampling; alternative à `top_p`.
  - Généralement exclusif à certains réglages ; à manipuler avec précaution.

- **`repeat_penalty`**
  - **Rôle**: pénalise les tokens déjà générés (évite les boucles).
  - `1.0` → désactivé.
  - `1.1–1.3` → valeurs classiques.

- **`frequency_penalty`**
  - **Rôle**: pénalise les tokens en fonction de leur fréquence absolue dans le texte.
  - Semblable au comportement OpenAI.

- **`presence_penalty`**
  - **Rôle**: pénalise le simple fait qu’un token soit déjà apparu, indépendamment de la fréquence.

- **`tfs_z`**
  - **Rôle**: paramètre Tail-Free Sampling.
  - Option avancée de sampling.

- **`mirostat_mode`**
  - **Rôle**: active le sampling Mirostat pour contrôler l’entropie.
  - `0` → désactivé.
  - `1` ou `2` → différentes variantes de Mirostat.

- **`mirostat_tau`**
  - **Rôle**: entropie cible pour Mirostat (plus haut = plus surprenant).
  - Valeurs typiques: autour de `5.0`.

- **`mirostat_eta`**
  - **Rôle**: taux d’apprentissage pour l’ajustement Mirostat.
  - Valeurs typiques: `0.1`.

- **`seed`**
  - **Rôle**: graine aléatoire.
  - Même `seed` + même prompt + même modèle/config = génération reproductible (tant que tout le reste est identique).
  - `-1` ou `None` → seed aléatoire.

- **`stop`**
  - **Rôle**: une string ou une liste de strings où arrêter la génération.
  - Ex: `["</s>", "\nUser:"]`.

- **`logit_bias`**
  - **Rôle**: appliquer un biais sur certains token-ids (forcer / interdire des tokens).
  - Usage avancé, comme dans l’API OpenAI.

- **`n_gpu_layers` (runtime, si exposé)**
  - Peut, selon l’impl, surcharger la valeur de chargement pour une requête donnée.
  - Rarement utile; dangereux pour la stabilité si changé dynamiquement.

---

## 4. Streaming & métriques d’usage

La partie streaming et usage est importante pour les **logs** et pour la visibilité dans le frontend.

- **`stream`**
  - **Rôle**: si `true`, la réponse est envoyée en **SSE** / chunks.
  - Le client reçoit petit à petit les tokens générés.

- **`stream_options.include_usage`**
  - **Rôle**: demander explicitement au daemon d’inclure un bloc `usage` dans le **dernier chunk**.
  - Effet côté Mercury:
    - Le backend `llamacpp` collecte ce `usage`.
    - `_normalize_usage` le transforme en:
      - `input_tokens` (à partir de `prompt_tokens`)
      - `output_tokens` (à partir de `completion_tokens`)
    - Le wrapper `StreamWithUsage` expose `result.usage` après la fin du stream, pour les logs.

- **`usage.prompt_tokens` / `usage.completion_tokens` / `usage.total_tokens`**
  - Champs **natifs** renvoyés par `llama.cpp` / bindings.
  - Mercury les re-map en:
    - `input_tokens` = `prompt_tokens`
    - `output_tokens` = `completion_tokens`
  - Ces valeurs sont utilisées par le frontend (`formatUsageSummary`) pour afficher les tokens dans les logs.

---

## 5. Spécificités KV cache & `unified_kv_cache`

Pour résumer autour du **cache KV**:

- **`unified_kv_cache` (template / `/mgmt/load`)**
  - Booléen, passé au daemon dans le corps JSON.
  - Active `kv_unified` côté `llama_context_params`.
  - Objectif: partager / unifier le buffer KV pour améliorer l’utilisation mémoire sur multi-sessions / contextes longs.

- **`kv_unified` (interne `llama.cpp`)**
  - Même sémantique, champ interne du contexte.

- **`type_k`, `type_v`**
  - Décident du type de quantization pour les clés et valeurs dans le cache KV.
  - Impact direct sur la taille mémoire et potentiellement la précision.

- **`ctx_shift`, `swa_full`**
  - Options avancées pour **déplacer la fenêtre de contexte** et/ou faire de la defrag / optimisation du KV cache.

---

## 6. Bonnes pratiques de réglage

- **Pour un PC perso avec GPU moyen (8–12 Go VRAM)**:
  - `ctx_size`: `8192–32768` max selon le modèle.
  - `n_gpu_layers`: commencer par `30–35` ou `-1` si la VRAM le permet.
  - `flash_attn`: `true` si build compatible.
  - `unified_kv_cache`: `true` si tu gères plusieurs sessions ou du long contexte.

- **Pour des générations stables / non délirantes**:
  - `temperature`: `0.2–0.7`
  - `top_p`: `0.8–0.95`
  - `repeat_penalty`: `1.1–1.3`
  - Utiliser quelques `stop` bien choisis pour couper proprement.

- **Pour bien suivre les coûts / perfs**:
  - Toujours activer `stream_options.include_usage = true` quand tu streames.
  - Vérifier dans les logs que `input_tokens` / `output_tokens` remontent bien.

---

Si tu veux, je peux aussi ajouter un lien vers ce fichier depuis un éventuel `README.md` principal ou compléter la doc avec des exemples concrets de templates `llamacpp` issus de ton projet (charge + options de génération). 

