#!/usr/bin/env python3
"""Regression tests for Qwen3-ASR MLX thread ownership."""

from __future__ import annotations

import asyncio
import importlib.util
import sys
import threading
import time
import types
import unittest
import warnings
from pathlib import Path
from unittest.mock import AsyncMock, patch

SERVICES_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SERVICES_DIR))


def _service_dependency_stubs():
    """Provide import-only web-framework stubs for dependency-light CI."""
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

    class UploadFile:
        filename: str | None = None

        async def read(self):
            return b""

    fastapi.FastAPI = FastAPI
    fastapi.File = lambda default=..., **_kwargs: default
    fastapi.Form = lambda default=None, **_kwargs: default
    fastapi.HTTPException = HTTPException
    fastapi.UploadFile = UploadFile

    middleware = types.ModuleType("fastapi.middleware")
    middleware.__path__ = []
    cors = types.ModuleType("fastapi.middleware.cors")
    cors.CORSMiddleware = type("CORSMiddleware", (), {})

    responses = types.ModuleType("fastapi.responses")

    class JSONResponse(dict):
        def __init__(self, status_code, content):
            super().__init__(content)
            self.status_code = status_code

    responses.JSONResponse = JSONResponse

    uvicorn = types.ModuleType("uvicorn")
    uvicorn.run = lambda *_args, **_kwargs: None

    return {
        "fastapi": fastapi,
        "fastapi.middleware": middleware,
        "fastapi.middleware.cors": cors,
        "fastapi.responses": responses,
        "uvicorn": uvicorn,
    }


def _load_whisper_api():
    """Load the service module without requiring runtime web dependencies."""
    multipart = types.ModuleType("multipart")
    multipart.__version__ = "0.0.20"
    multipart_parser = types.ModuleType("multipart.multipart")
    multipart_parser.parse_options_header = lambda value: (value, {})
    dependency_stubs = _service_dependency_stubs()
    dependency_stubs.update(
        {
            "multipart": multipart,
            "multipart.multipart": multipart_parser,
        },
    )
    with (
        patch.dict(sys.modules, dependency_stubs),
        warnings.catch_warnings(),
    ):
        warnings.simplefilter("ignore", DeprecationWarning)
        spec = importlib.util.spec_from_file_location(
            "whisper_api_worker_test",
            SERVICES_DIR / "whisper-api.py",
        )
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module


class QwenWorkerOwnershipTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.api = _load_whisper_api()

    def tearDown(self):
        self.api._shutdown_qwen_worker()

    async def test_qwen_load_first_and_consecutive_inference_share_one_worker(self):
        owner_thread = None
        inference_threads: list[int] = []

        def load_model(model_name):
            nonlocal owner_thread
            self.assertEqual(model_name, "mlx-community/Qwen3-ASR-1.7B-8bit")
            owner_thread = threading.get_ident()
            return object()

        def infer(model, label, _initial_prompt):
            self.assertIs(model, self.api._qwen_model)
            inference_threads.append(threading.get_ident())
            return label

        mlx_audio = types.ModuleType("mlx_audio")
        mlx_audio_stt = types.ModuleType("mlx_audio.stt")
        mlx_audio_utils = types.ModuleType("mlx_audio.stt.utils")
        mlx_audio_utils.load_model = load_model
        self.api.model_path = "mlx-community/Qwen3-ASR-1.7B-8bit"

        with patch.dict(
            sys.modules,
            {
                "mlx_audio": mlx_audio,
                "mlx_audio.stt": mlx_audio_stt,
                "mlx_audio.stt.utils": mlx_audio_utils,
            },
        ):
            self.assertTrue(self.api._try_qwen3())
            with patch.object(self.api, "transcribe_qwen", infer):
                first = await self.api._run_backend_operation(
                    self.api._transcribe_selected,
                    "first",
                    None,
                    None,
                )
                second = await self.api._run_backend_operation(
                    self.api._transcribe_selected,
                    "second",
                    None,
                    None,
                )

        self.assertEqual((first, second), ("first", "second"))
        self.assertIsNotNone(owner_thread)
        self.assertNotEqual(owner_thread, threading.get_ident())
        self.assertEqual(inference_threads, [owner_thread, owner_thread])

    async def test_qwen_deep_health_and_transcribe_operations_are_serialized(self):
        self.api._backend = "mlx-audio"
        self.api.model_loaded = True
        self.api.model_path = "mlx-community/Qwen3-ASR-1.7B-8bit"
        self.api._ensure_qwen_worker()
        active = 0
        max_active = 0
        operation_order: list[str] = []
        state_lock = threading.Lock()

        def operation(label):
            nonlocal active, max_active
            with state_lock:
                active += 1
                max_active = max(max_active, active)
                operation_order.append(f"{label}:start")
            time.sleep(0.02)
            with state_lock:
                operation_order.append(f"{label}:end")
                active -= 1
            return label

        class Upload:
            filename = "capture.wav"

            async def read(self):
                return b"audio"

        with (
            patch.object(
                self.api,
                "_run_deep_health_probe",
                lambda: operation("deep-health"),
            ),
            patch.object(
                self.api,
                "_transcribe_selected",
                lambda *_args: operation("transcribe"),
            ),
        ):
            deep_result, transcribe_result = await asyncio.gather(
                self.api.deep_health(),
                self.api.transcribe(Upload(), "zh", ""),
            )

        self.assertEqual(deep_result["status"], "ok")
        self.assertEqual(transcribe_result, {"text": "transcribe"})
        self.assertEqual(max_active, 1)
        self.assertEqual(
            operation_order,
            [
                "deep-health:start",
                "deep-health:end",
                "transcribe:start",
                "transcribe:end",
            ],
        )

    async def test_qwen_load_failure_closes_worker_for_clean_retry(self):
        def load_model(_model_name):
            raise RuntimeError("load failed")

        mlx_audio = types.ModuleType("mlx_audio")
        mlx_audio_stt = types.ModuleType("mlx_audio.stt")
        mlx_audio_utils = types.ModuleType("mlx_audio.stt.utils")
        mlx_audio_utils.load_model = load_model
        self.api.model_path = "mlx-community/Qwen3-ASR-1.7B-8bit"
        self.api.model_loaded = True
        self.api._backend = "mlx-audio"
        self.api._qwen_model = object()

        with (
            patch.dict(
                sys.modules,
                {
                    "mlx_audio": mlx_audio,
                    "mlx_audio.stt": mlx_audio_stt,
                    "mlx_audio.stt.utils": mlx_audio_utils,
                },
            ),
            patch.object(self.api.log, "exception"),
        ):
            self.assertFalse(self.api._try_qwen3())

        self.assertIsNone(self.api._qwen_worker)
        self.assertIsNone(self.api._qwen_model)
        self.assertFalse(self.api.model_loaded)
        self.assertEqual(self.api._backend, "unknown")

    async def test_whisper_backend_keeps_default_to_thread_dispatch(self):
        self.api._backend = "mlx-whisper"
        to_thread = AsyncMock(return_value="whisper-result")

        with patch.object(self.api.asyncio, "to_thread", to_thread):
            result = await self.api._run_backend_operation(str.upper, "whisper")

        self.assertEqual(result, "whisper-result")
        to_thread.assert_awaited_once_with(str.upper, "whisper")

    async def test_shutdown_is_idempotent_and_rejects_new_qwen_work(self):
        self.api._backend = "mlx-audio"
        worker = self.api._ensure_qwen_worker()

        self.api._shutdown_qwen_worker()
        self.api._shutdown_qwen_worker()

        self.assertTrue(worker.closed)
        with self.assertRaisesRegex(RuntimeError, "shut down"):
            await worker.run(str.upper, "late")
        with self.assertRaisesRegex(RuntimeError, "not available"):
            await self.api._run_backend_operation(str.upper, "late")


if __name__ == "__main__":
    unittest.main()
