"""Failure evidence from the real endpoint, synthetic counters and a fake encoder."""

import asyncio
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
import weakref
from unittest.mock import patch

import numpy as np
from embed_runtime_policy import MlxMemoryEnvelope


def service_dependency_stubs():
    """Import the endpoint without optional server frameworks, as the TTS probes do."""
    fastapi = types.ModuleType("fastapi")
    fastapi.__path__ = []

    class FastAPI:
        def __init__(self, **_kwargs):
            pass

        @staticmethod
        def _decorator(*_args, **_kwargs):
            return lambda operation: operation

        on_event = _decorator
        post = _decorator
        get = _decorator

        def add_middleware(self, *_args, **_kwargs):
            pass

    class HTTPException(Exception):
        def __init__(self, status_code, detail):
            super().__init__(detail)
            self.status_code = status_code
            self.detail = detail

    fastapi.FastAPI = FastAPI
    fastapi.HTTPException = HTTPException
    fastapi.Request = type("Request", (), {})
    middleware = types.ModuleType("fastapi.middleware")
    middleware.__path__ = []
    cors = types.ModuleType("fastapi.middleware.cors")
    cors.CORSMiddleware = type("CORSMiddleware", (), {})
    pydantic = types.ModuleType("pydantic")

    class BaseModel:
        def __init__(self, **values):
            for name in self.__class__.__annotations__:
                setattr(self, name, values.get(name, getattr(self.__class__, name, None)))

    pydantic.BaseModel = BaseModel
    pydantic.Field = lambda default=..., **_kwargs: None if default is ... else default
    return {
        "fastapi": fastapi,
        "fastapi.middleware": middleware,
        "fastapi.middleware.cors": cors,
        "pydantic": pydantic,
        "uvicorn": types.ModuleType("uvicorn"),
    }


class FakeAllocator:
    def __init__(self):
        self.active = 100
        self.cache = 20
        self.reads = {"active": 0, "cache": 0}

    def clear_cache(self):
        pass

    def get_active_memory(self):
        self.reads["active"] += 1
        return self.active

    def get_cache_memory(self):
        self.reads["cache"] += 1
        return self.cache


class FailureEvidenceTests(unittest.TestCase):
    def api(self):
        spec = importlib.util.spec_from_file_location(
            "embed_failure_fixture", Path(__file__).with_name("embed-api.py")
        )
        api = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = api
        self.addCleanup(lambda: sys.modules.pop(spec.name, None))
        with patch.dict(sys.modules, service_dependency_stubs()):
            spec.loader.exec_module(api)
        return api

    def check_failure(self, phase):
        api = self.api()
        api.model_loaded = True
        api.embed_dim = 4
        api._admission = api.EmbeddingAdmissionController(
            max_queue_depth=0, default_timeout_ms=3000, max_timeout_ms=3000
        )
        allocator = FakeAllocator()
        footprint_values = [1000, 1000 + 2062418040]
        if phase == "post":
            footprint_values.insert(1, 1100)
        footprints = iter(footprint_values)
        api._memory_envelope = MlxMemoryEnvelope(
            max_model_mem_mb=800,
            mlx=allocator,
            footprint_reader=lambda: next(footprints),
            require_footprint=True,
        )
        api._memory_envelope.capture_baseline()
        encoded = []
        exited = []
        api._schedule_resource_exit = lambda: exited.append(True)

        def generate(_model, _tokenizer, texts, **_kwargs):
            encoded.append(len(texts))
            allocator.active = 256
            allocator.cache = 64
            return types.SimpleNamespace(
                text_embeds=np.array([[1.0, 0, 0, 0] for _ in texts]),
                last_hidden_state=types.SimpleNamespace(shape=(len(texts), 321, 4)),
            )

        private = "private-input-must-not-be-logged"
        texts = [private + "x" * 9000, "small"]
        req = api.EmbedRequest(
            input=texts, model="credential-sentinel-must-not-be-logged",
            max_model_mem_mb=1600,
        )
        request = types.SimpleNamespace(
            is_disconnected=lambda: asyncio.sleep(0, result=False)
        )
        with patch.dict(sys.modules, {"mlx_embeddings.utils": types.SimpleNamespace(generate=generate)}):
            with self.assertLogs(api.log, level="CRITICAL") as captured:
                with self.assertRaises(api.HTTPException) as failure:
                    asyncio.run(api.create_embeddings(req, request))
        self.assertEqual(failure.exception.status_code, 503)
        self.assertEqual(failure.exception.detail["code"], "memory_budget_exceeded")
        self.assertEqual(exited, [True])
        self.assertEqual(encoded, [] if phase == "pre" else [2])
        self.assertEqual(allocator.reads, {"active": 1 if phase == "pre" else 2, "cache": 1 if phase == "pre" else 2})
        self.assertEqual(len(captured.records), 1)
        line = captured.records[0].getMessage()
        self.assertIn("context=", line, "the fatal guard must retain the failed sample and request phase")
        context = json.loads(line.split("context=", 1)[1].split("; exiting sidecar", 1)[0])
        self.assertEqual(context["phase"], phase)
        self.assertEqual(context["batch_size"], 2)
        self.assertEqual(context["request_chars_total"], sum(map(len, texts)))
        self.assertEqual(context["encode_chars_total"], 8192 + 5)
        self.assertEqual(context["request_chars_max"], len(texts[0]))
        self.assertEqual(context["encode_chars_max"], 8192)
        self.assertEqual(context["token_batch"], None if phase == "pre" else 2)
        self.assertEqual(context["padded_token_width"], None if phase == "pre" else 321)
        self.assertIsNone(context["configured_token_limit"])
        self.assertEqual(context["mlx_active_memory_bytes"], 100 if phase == "pre" else 256)
        self.assertEqual(context["mlx_cache_memory_bytes"], 20 if phase == "pre" else 64)
        self.assertEqual(context["os_footprint_bytes"], 1000 + 2062418040)
        self.assertEqual(context["baseline_os_footprint_bytes"], 1000)
        self.assertIn("observed=2062418040 delta=2062418040 budget=838860800", line)
        self.assertNotIn(private, line)
        self.assertNotIn(req.model, line)
        self.assertEqual(set(context), {
            "phase", "batch_size", "request_chars_total", "request_chars_max",
            "encode_chars_total", "encode_chars_max", "token_batch",
            "padded_token_width", "configured_token_limit", "mlx_active_memory_bytes",
            "mlx_cache_memory_bytes", "os_footprint_bytes", "baseline_os_footprint_bytes",
        })
        self.assertLess(len(line.encode()), 1024)
        self.assertNotIn("mlx.core", sys.modules)

    def test_pre_guard_preserves_sample_without_running_encoder(self):
        self.check_failure("pre")

    def test_post_guard_preserves_sample_and_observed_token_shape(self):
        self.check_failure("post")

    def test_shape_capture_does_not_keep_hidden_tensors_alive_during_conversion(self):
        api = self.api()
        hidden_refs = []

        class Hidden:
            shape = (1, 123, 4)

        class Pooled:
            def tolist(inner):
                self.assertIsNone(hidden_refs[0](), "diagnostic metadata must not retain the hidden tensor")
                return [[1.0, 0, 0, 0]]

        def generate(*_args, **_kwargs):
            hidden = Hidden()
            hidden_refs.append(weakref.ref(hidden))
            return types.SimpleNamespace(text_embeds=Pooled(), last_hidden_state=hidden)

        shape = {}
        with patch.dict(sys.modules, {"mlx_embeddings.utils": types.SimpleNamespace(generate=generate)}):
            value = api._encode_mlx(["synthetic"], shape)
        self.assertEqual(value.shape, (1, 4))
        self.assertEqual(shape, {"token_batch": 1, "padded_token_width": 123})

    def test_success_without_a_token_shape_keeps_the_response_and_emits_no_guard_record(self):
        api = self.api()
        api.model_loaded = True
        api.embed_dim = 4
        api._admission = api.EmbeddingAdmissionController(
            max_queue_depth=0, default_timeout_ms=3000, max_timeout_ms=3000
        )
        calls = []

        def generate(*_args, **_kwargs):
            calls.append(True)
            return types.SimpleNamespace(text_embeds=np.array([[1.0, 0, 0, 0]]))

        request = types.SimpleNamespace(is_disconnected=lambda: asyncio.sleep(0, result=False))
        with patch.dict(sys.modules, {"mlx_embeddings.utils": types.SimpleNamespace(generate=generate)}):
            with patch.object(api.log, "critical") as critical:
                response = asyncio.run(api.create_embeddings(api.EmbedRequest(input="synthetic"), request))
        self.assertEqual(calls, [True])
        self.assertEqual(response.data[0]["embedding"], [1.0, 0, 0, 0])
        critical.assert_not_called()


if __name__ == "__main__":
    unittest.main()
