# OmniVoice — Voice clone zero-shot dans brain-daemon

Modèle k2-fsa/OmniVoice (Apache 2.0). Diffusion TTS, 646 langues, ~24 kHz mono.
Voice clone à partir d'un ref audio de 5–15s. Intégré au brain-daemon (port 4321).

Chaîne complète : **NCM frontend → NCM backend → Mercury `/v1/audio/speech` → brain-daemon `/audio/speech` → OmniVoiceEngine**

## 1. Déployer le code brain-daemon

Sur la machine **brain** (Strix Halo ROCm) :

```bash
# rsync local → /opt/llamacpp-daemon (ou git pull si tu utilises ce workflow)
sudo systemctl stop brain-daemon
# … sync …
sudo systemctl start brain-daemon
curl -s http://127.0.0.1:4321/audio/health | jq
# omnivoice: { loaded: false, error: "import failed: …" }  ← attendu, modèle pas encore installé
```

## 2. Installer k2-fsa/OmniVoice

```bash
sudo /opt/llamacpp-daemon/scripts/install_omnivoice.sh
```

Le script :
- clone `https://github.com/k2-fsa/OmniVoice` dans `/opt/omnivoice-src`
- `pip install -e` dans le venv brain-daemon
- ajoute `pedalboard` + `soundfile` + `transformers>=4.45` + `torchaudio`
- crée `~/.local/share/brain-daemon/voices/`
- sanity-check l'import Python

Si l'import échoue côté ROCm (flex_attention manquant, version torch trop ancienne), upgrade torch :
```bash
/opt/llamacpp-daemon/venv/bin/pip install --upgrade torch --index-url https://download.pytorch.org/whl/rocm6.2
```

## 3. Activer dans config.yaml

```yaml
omnivoice:
  enabled: true
  device: auto       # cuda (lit ROCm), mps, cpu
  num_step: 16
  guidance_scale: 2.0
```

Restart :
```bash
sudo systemctl restart brain-daemon
journalctl -u brain-daemon -f | grep -i omnivoice
# OmniVoice loading on device=cuda
# OmniVoice loaded in 8.3s (device=cuda, dtype=fp16)
```

## 4. Test E2E (sans Mercury, daemon-only)

```bash
# (a) Health — voir omnivoice.loaded=true
curl -s http://127.0.0.1:4321/audio/health | jq .omnivoice

# (b) Créer un profil clone (ref WAV/MP3 de 5-15s clean)
curl -F name=your-name \
     -F ref_audio=@/tmp/me.wav \
     -F 'ref_text=Bonjour, ceci est un échantillon pour tester le clonage de voix.' \
     -F language=fr \
     -F master=warm \
     http://127.0.0.1:4321/audio/profiles | jq

# (c) Synthèse via le clone
curl -X POST http://127.0.0.1:4321/audio/speech \
     -H 'Content-Type: application/json' \
     -d '{
       "input": "Salut le monde, ceci est ma voix clonée.",
       "voice": "clone:your-name",
       "language": "fr"
     }' --output out.wav
file out.wav   # → RIFF (little-endian) data, WAVE audio, 16 bit, mono 24000 Hz
```

## 5. Tester de bout en bout via Mercury → NCM

NCM frontend → bouton ⚙️ Agent Settings → Voice → "Manage voice clones…" → upload + create.
Puis sélectionne le clone dans la voice dropdown (groupe `OmniVoice clones`) → Play preview.

À surveiller au passage :
- `omnivoice.loaded` doit rester true (RAM/VRAM stable).
- Latence : compter 1–2s pour la 1ʳᵉ phrase (kernels chauds), <1s ensuite.
- Sur ROCm Strix Halo si crash sur `flex_attention` → fallback torch SDPA via env var `PYTORCH_DISABLE_FLEX_ATTENTION=1` (à mettre dans le systemd unit).

## Endpoints ajoutés

Brain-daemon :
- `GET    /audio/health` — incluant `omnivoice` + `profiles_count`
- `GET    /audio/voices` — clones inclus avec `engine: omnivoice`
- `GET    /audio/masters` — liste des presets DSP
- `GET    /audio/profiles`
- `POST   /audio/profiles` (multipart : `name`, `ref_audio`, `ref_text`, `language`, `instruct`, `description`, `master`, `tags`)
- `GET    /audio/profiles/{id}`
- `PATCH  /audio/profiles/{id}`
- `DELETE /audio/profiles/{id}`
- `POST   /audio/speech` — étendu avec `master` et `language`

Mercury :
- `/api/voices` — clones intégrés via le fetch `audio/voices` du daemon
- `GET/POST/DELETE /api/voices/profiles` — proxy vers le daemon
- `/v1/audio/speech` route vers le `local` provider si `voice` commence par `clone:` ou `omnivoice:`, ou si `model == "omnivoice"`

NCM :
- `GET/POST/DELETE /api/ncm/voices/profiles` — proxy vers Mercury
- Frontend : `VoiceCloneDialog` (upload + record + create), AgentSettings affiche les clones groupés par engine + master picker conditionnel

## Troubleshooting

- **OmniVoice not loaded** → check `journalctl -u brain-daemon | grep OmniVoice` pour la cause.
- **Profile inconnu** côté `/audio/speech` → la DB `~/.local/share/brain-daemon/voices/profiles.db` n'a pas le `clone:<slug>`. `GET /audio/profiles` pour vérifier.
- **Pas de pedalboard** → mastering désactivé silencieusement, la voix sort sans DSP. `pip install pedalboard` dans le venv.
- **OOM GPU** → baisser `num_step` (12 ou 8) ou forcer `device: cpu`.
