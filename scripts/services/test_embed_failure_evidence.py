"""Failure evidence from the real endpoint, synthetic counters and a fake encoder."""

import asyncio
import importlib.util
import itertools
import json
from pathlib import Path
import sys
import types
import unittest
import weakref
from unittest.mock import patch

try:
    import numpy as np
except ModuleNotFoundError as error:
    if error.name != "numpy":
        raise
    np = None
import embed_runtime_policy
from embed_runtime_policy import MlxMemoryEnvelope
from test_embed_runtime_policy import FakeClock


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

    def get_peak_memory(self):
        return self.active


@unittest.skipIf(np is None, "Optional NumPy is not installed; endpoint failure-evidence probes were not executed")
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

    def guarded_request(self, footprint_values, *, deadline_ms=None, is_disconnected=None):
        """The real endpoint behind a real envelope, fed a scripted OS footprint."""
        api = self.api()
        api.model_loaded = True
        api.embed_dim = 4
        api._admission = api.EmbeddingAdmissionController(
            max_queue_depth=0, default_timeout_ms=3000, max_timeout_ms=3000
        )
        allocator = FakeAllocator()
        footprints = iter(footprint_values)
        guard_samples = []

        def read_footprint():
            guard_samples.append(True)
            return next(footprints)

        api._memory_envelope = MlxMemoryEnvelope(
            max_model_mem_mb=800,
            mlx=allocator,
            footprint_reader=read_footprint,
            require_footprint=True,
        )
        api._memory_envelope.capture_baseline()
        guard_samples.clear()  # the baseline read does not consult the allocator
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
            max_model_mem_mb=1600, deadline_ms=deadline_ms,
        )
        request = types.SimpleNamespace(
            is_disconnected=is_disconnected or (lambda: asyncio.sleep(0, result=False))
        )
        return types.SimpleNamespace(
            api=api, allocator=allocator, guard_samples=guard_samples, encoded=encoded,
            exited=exited, generate=generate, private=private, texts=texts, req=req,
            request=request,
        )

    def check_failure(self, phase):
        # The footprint stays over budget for the whole settle window: retained.
        head = [1000] if phase == "pre" else [1000, 1100]
        case = self.guarded_request(itertools.chain(head, itertools.repeat(1000 + 2062418040)))
        api, allocator, encoded, exited = case.api, case.allocator, case.encoded, case.exited
        private, texts, req = case.private, case.texts, case.req
        with patch.object(embed_runtime_policy, "time", FakeClock()):
            with patch.dict(sys.modules, {"mlx_embeddings.utils": types.SimpleNamespace(generate=case.generate)}):
                with self.assertLogs(api.log, level="CRITICAL") as captured:
                    with self.assertRaises(api.HTTPException) as failure:
                        asyncio.run(api.create_embeddings(req, case.request))
        self.assertEqual(failure.exception.status_code, 503)
        self.assertEqual(failure.exception.detail["code"], "memory_budget_exceeded")
        self.assertEqual(exited, [True])
        self.assertEqual(encoded, [] if phase == "pre" else [2])
        # The failure line reuses the guard's own samples: one allocator read per
        # footprint sample, nothing re-sampled for the sake of the log.
        self.assertGreater(len(case.guard_samples), 2, "retained memory is only declared after re-reading")
        self.assertEqual(allocator.reads, {"active": len(case.guard_samples), "cache": len(case.guard_samples)})
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
        self.assertEqual(context["first_observed_bytes"], 2062418040)
        self.assertEqual(context["settle_ms"], round(embed_runtime_policy.MEMORY_SETTLE_WINDOW_SECONDS * 1000))
        self.assertIn("observed=2062418040 delta=2062418040 budget=838860800", line)
        self.assertNotIn(private, line)
        self.assertNotIn(req.model, line)
        self.assertEqual(set(context), {
            "phase", "batch_size", "request_chars_total", "request_chars_max",
            "encode_chars_total", "encode_chars_max", "token_batch",
            "padded_token_width", "configured_token_limit", "mlx_active_memory_bytes",
            "mlx_cache_memory_bytes", "os_footprint_bytes", "baseline_os_footprint_bytes",
            "first_observed_bytes", "settle_ms",
        })
        self.assertLess(len(line.encode()), 1024)
        self.assertNotIn("mlx.core", sys.modules)

    def test_pre_guard_preserves_sample_without_running_encoder(self):
        self.check_failure("pre")

    def test_post_guard_preserves_sample_and_observed_token_shape(self):
        self.check_failure("post")

    OVER_BUDGET = 1000 + 950 * 1024 * 1024  # baseline 1000 + 950 MiB, budget 800 MiB

    def test_pre_overshoot_that_settles_before_the_deadline_still_serves_the_request(self):
        # baseline, pre-check first sample, pre-check re-read (25 ms), post-check
        case = self.guarded_request([1000, self.OVER_BUDGET, 1100, 1150])
        api = case.api
        with patch.object(embed_runtime_policy, "time", FakeClock()):
            with patch.dict(sys.modules, {"mlx_embeddings.utils": types.SimpleNamespace(generate=case.generate)}):
                with self.assertLogs(api.log, level="WARNING") as captured:
                    response = asyncio.run(api.create_embeddings(case.req, case.request))
        self.assertEqual(case.encoded, [2])
        self.assertEqual(case.exited, [])
        self.assertEqual(len(response.data), 2)
        self.assertEqual([record.levelname for record in captured.records], ["WARNING"])
        context = json.loads(captured.records[0].getMessage().split("context=", 1)[1])
        self.assertEqual(context["phase"], "pre")
        self.assertIsNone(context["token_batch"], "nothing was encoded before the pre-check")

    def check_unwanted_after_pre_settle(self, clock, **request_options):
        # The pre-check reads over budget at 0, 25 and 50 ms and settles at 75 ms.
        # The trailing sample is only consumed if the request is wrongly encoded.
        case = self.guarded_request(
            [1000, self.OVER_BUDGET, self.OVER_BUDGET, self.OVER_BUDGET, 1100, 1150], **request_options
        )
        api = case.api
        with patch.object(embed_runtime_policy, "time", clock):
            with patch.dict(sys.modules, {"mlx_embeddings.utils": types.SimpleNamespace(generate=case.generate)}):
                with self.assertLogs(api.log, level="WARNING") as captured:
                    with self.assertRaises(api.HTTPException) as failure:
                        asyncio.run(api.create_embeddings(case.req, case.request))
        self.assertEqual(clock.sleeps, [0.025, 0.025, 0.025])
        self.assertEqual(case.encoded, [], "no allocation for a request nobody is waiting for")
        self.assertEqual(case.exited, [], "the memory came back; the sidecar keeps serving")
        self.assertEqual([record.levelname for record in captured.records], ["WARNING"])
        self.assertEqual(api._admission.snapshot()["in_flight"], 0)
        return api, failure.exception

    def test_request_that_expired_while_the_pre_guard_settled_is_not_encoded(self):
        clock = FakeClock()
        api, failure = self.check_unwanted_after_pre_settle(
            clock, deadline_ms=int((clock.time() + 0.05) * 1000)
        )
        self.assertEqual(failure.status_code, 408)
        self.assertEqual(failure.detail["code"], "deadline_expired")
        self.assertEqual(api._admission.snapshot()["expired_count"], 1)

    def test_client_that_left_while_the_pre_guard_settled_is_not_encoded(self):
        clock = FakeClock()
        api, failure = self.check_unwanted_after_pre_settle(
            clock, is_disconnected=lambda: asyncio.sleep(0, result=clock.elapsed >= 0.05)
        )
        self.assertEqual(failure.status_code, 499)
        self.assertEqual(failure.detail["code"], "client_disconnected")
        self.assertEqual(api._admission.snapshot()["disconnected_count"], 1)

    def test_memory_that_stays_over_budget_still_exits_when_the_request_has_also_expired(self):
        # An expired request must not hide memory that stays over budget.
        clock = FakeClock()
        case = self.guarded_request(
            itertools.chain([1000], itertools.repeat(self.OVER_BUDGET)),
            deadline_ms=int((clock.time() + 0.05) * 1000),
        )
        api = case.api
        with patch.object(embed_runtime_policy, "time", clock):
            with patch.dict(sys.modules, {"mlx_embeddings.utils": types.SimpleNamespace(generate=case.generate)}):
                with self.assertLogs(api.log, level="CRITICAL"):
                    with self.assertRaises(api.HTTPException) as failure:
                        asyncio.run(api.create_embeddings(case.req, case.request))
        self.assertEqual(failure.exception.status_code, 503)
        self.assertEqual(failure.exception.detail["code"], "memory_budget_exceeded")
        self.assertEqual(case.exited, [True])
        self.assertEqual(case.encoded, [])

    def test_overshoot_the_os_reclaims_keeps_the_sidecar_serving_and_records_the_reading(self):
        # Synthetic trajectory, not a recording. The first post-check sample borrows
        # the size logged on 2026-11-14 (2062418040 bytes over baseline); that it
        # falls back on the next sample is this test's assumption. The phase and
        # request shape of the production failure were not logged.
        # baseline, pre-check, post-check first sample, post-check re-read, /health refresh
        case = self.guarded_request([1000, 1100, 1000 + 2062418040, 1200, 1200])
        api = case.api
        with patch.object(embed_runtime_policy, "time", FakeClock()):
            with patch.dict(sys.modules, {"mlx_embeddings.utils": types.SimpleNamespace(generate=case.generate)}):
                with self.assertLogs(api.log, level="WARNING") as captured:
                    response = asyncio.run(api.create_embeddings(case.req, case.request))
        self.assertEqual(case.exited, [], "a reclaimed reading must not take the sidecar down")
        self.assertEqual(case.encoded, [2])
        self.assertEqual([item["embedding"] for item in response.data], [[1.0, 0, 0, 0], [1.0, 0, 0, 0]])
        self.assertEqual([record.levelname for record in captured.records], ["WARNING"])
        line = captured.records[0].getMessage()
        self.assertIn("first_observed=2062418040 settled_observed=320 budget=838860800 settle_ms=25", line)
        context = json.loads(line.split("context=", 1)[1])
        self.assertEqual(context["phase"], "post")
        self.assertEqual(context["batch_size"], 2)
        self.assertEqual(context["padded_token_width"], 321)
        self.assertEqual(context["mlx_active_memory_bytes"], 256)
        self.assertEqual(context["mlx_cache_memory_bytes"], 64)
        self.assertEqual(context["os_footprint_bytes"], 1000 + 2062418040)
        self.assertEqual(context["baseline_os_footprint_bytes"], 1000)
        self.assertNotIn(case.private, line)
        self.assertNotIn(case.req.model, line)
        self.assertLess(len(line.encode()), 1024)
        health = asyncio.run(api.health())
        self.assertEqual(health["status"], "ok")
        self.assertEqual(health["transient_overshoot_count"], 1)
        self.assertEqual(health["transient_overshoot_max_bytes"], 2062418040)

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
