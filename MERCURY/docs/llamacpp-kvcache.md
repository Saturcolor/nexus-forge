# llama.cpp - Sauvegarde KV Cache (Prompt Cache)

**Date:** 2026-03-21  
**Source:** Recherche web + doc officielle llama.cpp  
**Statut:** À tester en production Mercury

---

## 🎯 Fonctionnalité Native

Llama.cpp supporte nativement la sauvegarde et rechargement du KV cache via les flags suivants :

### Flags Disponibles

```bash
# Sauvegarder l'état complet (KV + prompt)
llama-server --prompt-cache /chemin/vers/cache.bin --prompt-cache-all

# Recharger le cache au démarrage
llama-server --prompt-cache /chemin/vers/cache.bin
```

---

## 📋 Cas d'Usage

### 1. Switch Modèles avec KV Cache Persistant

**Scénario :** Sauvegarder l'état du modèle A, charger le modèle B, puis revenir au modèle A instantanément sans reprocesser tout le prompt.

```bash
# Étape 1 : Démarrer Qwen3.5 et sauvegarder son KV cache
llama-server -m qwen3.5.gguf \
  --prompt-cache /tmp/qwen_cache.bin \
  --prompt-cache-all \
  -c 8192

# ... faire des trucs avec autre chose ...

# Étape 2 : Recharger Qwen3.5 + son KV cache (instantané)
llama-server -m qwen3.5.gguf \
  --prompt-cache /tmp/qwen_cache.bin
```

**Avantage :** Pas de reprocessing du prompt initial, gain de temps significatif sur contextes longs.

---

### 2. Session Persistante Entre Requêtes

**Scénario :** Garder un contexte actif entre plusieurs requêtes API sans perdre l'état KV.

```bash
# Démarrer avec cache persistant
llama-server -m model.gguf \
  --prompt-cache /tmp/session_cache.bin \
  --prompt-cache-all \
  -c 16384

# Les slots restent actifs entre requêtes tant que le serveur tourne
# Ou recharger après redémarrage :
llama-server -m model.gguf --prompt-cache /tmp/session_cache.bin
```

---

## ⚠️ Contraintes et Points d'Attention

| Contrainte | Détail |
|------------|--------|
| **Alignement Modèle** | Le KV cache est spécifique au modèle (pas interchangeable entre Qwen/Mistral/Nemotron) |
| **Prompt Identique** | Pour rechargement parfait, le prompt de base doit correspondre exactement |
| **Version llama.cpp** | Fonctionnalité disponible depuis fin 2024/début 2025 — vérifier ta version |
| **Taille Cache** | Dépend du contexte (-c) et taille modèle (Qwen3.5-122B = plusieurs GB possible) |

---

## 🧪 Commandes de Test

### Vérifier support des flags :
```bash
llama-server --help | grep "prompt-cache"
```

### Tester sauvegarde/recharge avec Qwen3.5-122B :
```bash
# Sauvegarder
llama-server -m qwen3.5.gguf \
  --prompt-cache /tmp/qwen_cache.bin \
  --prompt-cache-all \
  -c 8192

# Recharger (dans un autre terminal ou après redémarrage)
llama-server -m qwen3.5.gguf \
  --prompt-cache /tmp/qwen_cache.bin
```

---

## 🚀 Implémentation Mercure

**TODO:**
- [ ] Tester la fonctionnalité avec les modèles actuels (Qwen, Mistral, Nemotron)
- [ ] Mesurer temps de sauvegarde/recharge pour contextes 8K/16K/32K
- [ ] Intégrer API endpoint Mercury : `POST /kv-cache/save`, `POST /kv-cache/load`
- [ ] Automatiser switch modèles avec cache persistant
- [ ] Gérer la purge automatique des caches obsolètes

---

## 📚 Sources

1. **llama.cpp Issue #7698** — Documentation prompt-cache
2. **llama.cpp Issue #17107** — Slot persistence et slots management
3. **llama.cpp Tutorial #13606** — KV cache reuse avec slots

---

*Dernière mise à jour: 2026-03-21*