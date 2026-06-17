"""
Tests unitaires pour routing.router (resolve_model, étapes de la pipeline).
Lancer avec : python -m pytest tests/routing/test_router.py -v
ou : python -m unittest tests.routing.test_router -v
"""
import time
import unittest
from unittest.mock import patch

from routing import router


class TestRouter(unittest.TestCase):
    def setUp(self):
        router.apply_db_overrides()

    def test_resolve_model_empty_raises(self):
        with self.assertRaises(ValueError):
            router.resolve_model("")
        with self.assertRaises(ValueError):
            router.resolve_model("   ")

    def test_resolve_from_mapping(self):
        """model_mapping (config) est utilisé quand le modèle est une clé du mapping."""
        base = dict(router.get_config())
        base["model_mapping"] = {
            "my/custom-model": {"backend": "ollama", "backend_model_id": "llama3.2"},
            "openrouter/foo": {"backend": "openrouter", "backend_model_id": "openai/gpt-4o"},
        }
        base["ollama_enabled"] = True
        base["openrouter_enabled"] = True
        base["openrouter_api_key"] = "sk-test"
        with patch.object(router, "_config", base):
            with patch.object(router, "_resolved_cache", {}):
                backend, backend_id = router.resolve_model("my/custom-model")
                self.assertEqual(backend, "ollama")
                self.assertEqual(backend_id, "llama3.2")

                backend2, backend_id2 = router.resolve_model("openrouter/foo")
                self.assertEqual(backend2, "openrouter")
                self.assertEqual(backend_id2, "openai/gpt-4o")

    def test_resolve_cached(self):
        """Le cache mémoire est utilisé après la première résolution (via mapping)."""
        cfg = router.get_config()
        cfg = dict(cfg)
        cfg["model_mapping"] = {"cached-model": {"backend": "ollama", "backend_model_id": "cached-id"}}
        cfg["ollama_enabled"] = True
        with patch.object(router, "_config", cfg):
            with patch.object(router, "_resolved_cache", {}):
                b, bid = router.resolve_model("cached-model")
                self.assertEqual((b, bid), ("ollama", "cached-id"))
            # Deuxième appel : doit venir du cache (même config). L'entrée du cache est un
            # 3-tuple (backend, backend_model_id, timestamp monotonic) — cf. _cache_put/_cache_get.
            with patch.object(router, "_resolved_cache", {"cached-model": ("ollama", "from-cache", time.monotonic())}):
                b2, bid2 = router.resolve_model("cached-model")
                self.assertEqual((b2, bid2), ("ollama", "from-cache"))

    def test_openrouter_fallback_force(self):
        """openrouter_fallback_force court-circuite tout vers le modèle de fallback OpenRouter."""
        cfg = dict(router.get_config())
        cfg.update({
            "openrouter_fallback_force": True,
            "openrouter_enabled": True,
            "openrouter_api_key": "sk-test",
            "openrouter_fallback_model": "openai/gpt-4o",
        })
        with patch.object(router, "_config", cfg), patch.object(router, "_resolved_cache", {}):
            backend, backend_id = router.resolve_model("n-importe-quel-modele")
            self.assertEqual((backend, backend_id), ("openrouter", "openai/gpt-4o"))

    def test_resolve_from_routes_regex(self):
        """model_routes (regex) : un pattern qui matche route vers le backend déclaré."""
        cfg = dict(router.get_config())
        cfg.update({
            "openrouter_enabled": True,
            "openrouter_api_key": "sk-test",
            "openrouter_fallback_force": False,
            "model_mapping": {},
            "model_routes": [{"pattern": r"^gpt-.*", "backend": "openrouter"}],
        })
        with patch.object(router, "_config", cfg), patch.object(router, "_resolved_cache", {}):
            backend, backend_id = router.resolve_model("gpt-4o-mini")
            self.assertEqual(backend, "openrouter")
            self.assertEqual(backend_id, "gpt-4o-mini")

    def test_ordered_cloud_fallback_last_resort(self):
        """Dernier recours : un modèle inconnu (sans préfixe backend) tombe sur la chaîne cloud ordonnée."""
        cfg = dict(router.get_config())
        cfg.update({
            "openrouter_enabled": True,
            "openrouter_api_key": "sk-test",
            "openrouter_fallback_model": "openai/gpt-4o-mini",
            "openrouter_fallback_force": False,
            "fallback_providers_order": ["openrouter"],
            "model_mapping": {},
            "model_routes": [],
        })
        with patch.object(router, "_config", cfg), patch.object(router, "_resolved_cache", {}):
            backend, backend_id = router.resolve_model("modele-totalement-inconnu-xyz")
            self.assertEqual((backend, backend_id), ("openrouter", "openai/gpt-4o-mini"))

    def test_raises_when_no_backend_resolves(self):
        """Aucun backend activé + aucun fallback cloud → ValueError explicite (pas de silence)."""
        cfg = dict(router.get_config())
        cfg.update({
            "openrouter_enabled": False,
            "anthropic_enabled": False,
            "openrouter_fallback_force": False,
            "model_mapping": {},
            "model_routes": [],
            "fallback_providers_order": [],
        })
        with patch.object(router, "_config", cfg), patch.object(router, "_resolved_cache", {}):
            with self.assertRaises(ValueError):
                router.resolve_model("aucun-backend-pour-ce-modele")

    def test_backend_model_id_from_pattern(self):
        """Préfixes retirés et : → - pour LM Studio."""
        self.assertEqual(
            router._backend_model_id_from_pattern("ollama", "ollama/llama3.2"), "llama3.2"
        )
        self.assertEqual(
            router._backend_model_id_from_pattern("lm_studio", "lm_studio/qwen3.5-9b"),
            "qwen3.5-9b",
        )
        self.assertEqual(
            router._backend_model_id_from_pattern("lm_studio", "qwen/qwen3.5:9b"),
            "qwen/qwen3.5-9b",
        )
        self.assertEqual(
            router._backend_model_id_from_pattern("llamacpp", "llamacpp/foo"), "foo"
        )
        self.assertEqual(
            router._backend_model_id_from_pattern("openrouter", "openrouter/openai/gpt-4o"),
            "openai/gpt-4o",
        )


if __name__ == "__main__":
    unittest.main()
