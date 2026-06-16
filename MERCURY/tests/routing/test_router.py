"""
Tests unitaires pour routing.router (resolve_model, étapes de la pipeline).
Lancer avec : python -m pytest tests/routing/test_router.py -v
ou : python -m unittest tests.routing.test_router -v
"""
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
            # Deuxième appel : doit venir du cache (même config)
            with patch.object(router, "_resolved_cache", {"cached-model": ("ollama", "from-cache")}):
                b2, bid2 = router.resolve_model("cached-model")
                self.assertEqual((b2, bid2), ("ollama", "from-cache"))

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
