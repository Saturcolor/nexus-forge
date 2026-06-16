"""brain-daemon atlas module — extraction de control vectors via transformers.

OPT-IN: nécessite `atlas.enabled: true` dans config.yaml + dépendances installées
(transformers, torch, gguf, sklearn). Voir atlas/README.md.

Mécaniquement, ce module embarque transformers à la demande pour extraire les
hidden states intermédiaires que llama.cpp ne expose pas. Lance des "runs"
one-shot via HTTP, libère la mémoire après chaque extraction.
"""
