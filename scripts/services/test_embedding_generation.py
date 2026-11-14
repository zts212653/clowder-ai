import asyncio
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

import numpy as np
from embedding_generation import read_deployment, recipe_fingerprint


class GenerationTests(unittest.TestCase):
    def api(self):
        spec = importlib.util.spec_from_file_location("embed_generation_test_api", Path(__file__).with_name("embed-api.py"))
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        return module

    def test_recipe_window_reaches_actual_encoder(self):
        api = self.api()
        recipe = read_deployment()["generations"]["g1"]["recipe"]
        api._representation_recipe = recipe
        api.embed_dim = 1024
        calls = []
        def generate(*args, **kwargs):
            calls.append(kwargs)
            return types.SimpleNamespace(text_embeds=np.array([[1.] + [0.] * 2559]))
        with patch.dict(sys.modules, {"mlx_embeddings.utils": types.SimpleNamespace(generate=generate)}):
            value = api._encode_mlx(["neutral document"])
        self.assertEqual(calls, [{"max_length": 2048}])
        self.assertEqual(value.shape, (1, 1024))

    def test_wrong_recipe_request_never_reaches_encoder(self):
        api = self.api()
        api.model_loaded = True
        api._representation_recipe = read_deployment()["generations"]["g1"]["recipe"]
        api._representation_fingerprint = recipe_fingerprint(api._representation_recipe)
        api._admission = api.EmbeddingAdmissionController(max_queue_depth=0, default_timeout_ms=3000, max_timeout_ms=3000)
        encoded = []
        api._encode = lambda texts: encoded.append(texts) or np.array([[1., 0., 0., 0.]])
        request = types.SimpleNamespace(is_disconnected=lambda: asyncio.sleep(0, result=False))
        req = api.EmbedRequest(input=["neutral document"], representation_fingerprint="b" * 64)
        with self.assertRaises(api.HTTPException) as failure:
            asyncio.run(api.create_embeddings(req, request))
        self.assertEqual(failure.exception.status_code, 409)
        self.assertEqual(encoded, [])

    def test_fingerprint_excludes_limits_and_matches_flat_canonical_json(self):
        recipe = read_deployment()["generations"]["g1"]["recipe"]
        import hashlib
        self.assertEqual(recipe_fingerprint(recipe), hashlib.sha256(json.dumps(recipe, sort_keys=True, separators=(",", ":")).encode()).hexdigest())


if __name__ == "__main__":
    unittest.main()
