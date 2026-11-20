#!/usr/bin/env python3
"""Regression tests for Qwen3-ASR MLX thread ownership."""

from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import os
import py_compile
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
import warnings
from pathlib import Path
from unittest.mock import AsyncMock, patch

SERVICES_DIR = Path(__file__).resolve().parent
ASR_SOURCE_FILES = ("dedicated_model_worker.py", "qwen_asr_backend.py", "whisper-api.py")
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
    fastapi.Request = type("Request", (), {})
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


def _load_whisper_api(source=SERVICES_DIR / "whisper-api.py"):
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
            source,
        )
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module


class AsrSourceIdentityTest(unittest.TestCase):
    @staticmethod
    def checkout_digest(root):
        digest = hashlib.sha256()
        for name in ASR_SOURCE_FILES:
            digest.update(name.encode() + b"\0" + (root / name).read_bytes() + b"\0")
        return digest.hexdigest()

    def test_running_adapter_and_worker_match_health_with_stale_timestamp_bytecode(self):
        def seed_old_bytecode(path, current, previous):
            self.assertEqual(len(current), len(previous))
            self.assertNotEqual(current, previous)
            timestamp = int(time.time())
            path.write_bytes(previous)
            os.utime(path, (timestamp, timestamp))
            py_compile.compile(str(path), doraise=True, invalidation_mode=py_compile.PycInvalidationMode.TIMESTAMP)
            path.write_bytes(current)
            os.utime(path, (timestamp, timestamp))

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            worker, adapter, api_source = ((SERVICES_DIR / name).read_bytes() for name in ASR_SOURCE_FILES)
            (root / "whisper-api.py").write_bytes(api_source)
            with (
                patch.object(sys, "path", [directory, *sys.path]),
                patch.object(sys, "pycache_prefix", None),
                patch.object(sys, "dont_write_bytecode", True),
                patch.dict(sys.modules),
            ):
                seed_old_bytecode(
                    root / "dedicated_model_worker.py",
                    worker,
                    worker.replace(b"self._closed = False", b"self._closed = True "),
                )
                seed_old_bytecode(
                    root / "qwen_asr_backend.py",
                    adapter,
                    adapter.replace(b'kwargs["system_prompt"]', b'kwargs["context"]      '),
                )
                for name in ("dedicated_model_worker", "qwen_asr_backend"):
                    sys.modules.pop(name, None)

                api = _load_whisper_api(root / "whisper-api.py")
                generator = types.ModuleType("mlx_audio.stt.generate")

                def generate_transcription(**kwargs):
                    self.assertNotIn("context", kwargs)
                    return types.SimpleNamespace(text=kwargs.get("system_prompt", ""))

                generator.generate_transcription = generate_transcription
                with patch.dict(sys.modules, {"mlx_audio.stt.generate": generator}):
                    self.assertEqual(api.transcribe_qwen(None, str(root / "speech.wav"), "宪宪"), "宪宪")
                try:
                    self.assertFalse(api._ensure_qwen_worker().closed)
                finally:
                    api._shutdown_qwen_worker()

            self.assertEqual(asyncio.run(api.health())["asr_source_sha256"], self.checkout_digest(root))

    def test_entrypoint_update_during_direct_startup_cannot_report_new_fingerprint(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ASR_SOURCE_FILES:
                (root / name).write_bytes((SERVICES_DIR / name).read_bytes())
            entry = root / "whisper-api.py"
            original = entry.read_bytes()
            updated = original.replace(b"MAX_FILE_BYTES = ", b"MAX_FILE_BYTES = 1 + ", 1)
            self.assertNotEqual(original, updated)
            (root / "whisper-api.next").write_bytes(updated)
            (root / "uvicorn.py").write_text(
                """import asyncio
import json
import sys
import types
from pathlib import Path
from scripts.services.test_whisper_worker import _service_dependency_stubs

dependencies = _service_dependency_stubs()
dependencies.pop("uvicorn")
sys.modules.update(dependencies)
utils = types.ModuleType("mlx_audio.stt.utils")
utils.load_model = lambda _name: object()
sys.modules[utils.__name__] = utils

# Python has already compiled the entrypoint by the time it imports uvicorn.
pending = Path(__file__).with_name("whisper-api.next")
if pending.exists():
    pending.replace(pending.with_name("whisper-api.py"))

def run(_app, **_kwargs):
    entry = sys.modules["__main__"]
    print(json.dumps({"limit": entry.MAX_FILE_BYTES, "health": asyncio.run(entry.health())}))
""",
                encoding="utf-8",
            )

            def boot():
                result = subprocess.run(
                    [sys.executable, "-B", str(entry), "--model", "fixture/Qwen3-ASR", "--port", "0"],
                    cwd=root,
                    env={**os.environ, "PYTHONPATH": str(SERVICES_DIR.parent.parent)},
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                return json.loads(result.stdout), result.stderr

            raced, logs = boot()
            stable, _ = boot()
            self.assertEqual(raced["limit"] + 1, stable["limit"])
            self.assertIsNone(raced["health"]["asr_source_sha256"])
            self.assertIn("entrypoint changed during startup", logs)
            self.assertEqual(stable["health"]["asr_source_sha256"], self.checkout_digest(root))


class QwenWorkerOwnershipTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.api = _load_whisper_api()

    def tearDown(self):
        self.api._shutdown_qwen_worker()

    def test_qwen_forwards_user_hint_as_the_models_system_prompt(self):
        hint = "猫名宪宪。按音频区分宪宪和线线，没听到的话不要补。"
        model = object()
        generator = types.ModuleType("mlx_audio.stt.generate")

        def generate_transcription(*, system_prompt=None, **kwargs):
            self.assertIs(kwargs["model"], model)
            self.assertEqual(system_prompt, hint)
            return types.SimpleNamespace(text=" 宪宪，检查 pull request。 ")

        generator.generate_transcription = generate_transcription
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(sys.modules, {"mlx_audio.stt.generate": generator}):
                self.api._qwen_model = model
                text = self.api._transcribe_qwen3(str(Path(directory) / "speech.wav"), "zh", hint)

        self.assertEqual(text, "宪宪，检查 pull request。")

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
                self.api.transcribe(AsyncMock(is_disconnected=AsyncMock(return_value=False)), Upload(), "zh", ""),
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

    async def test_disconnected_queued_preview_does_not_run_before_final(self):
        self.api.model_loaded = True
        preview_read = asyncio.Event()
        disconnected = False

        async def is_disconnected():
            return disconnected

        class Upload:
            filename = "capture.wav"

            def __init__(self, content):
                self.content = content

            async def read(self):
                if self.content == b"preview":
                    preview_read.set()
                return self.content

        ran = []

        async def infer(_operation, path, *_args):
            text = Path(path).read_bytes().decode()
            ran.append(text)
            return text

        with patch.object(self.api, "_run_backend_operation", infer):
            async with self.api._transcribe_lock:
                preview = asyncio.create_task(
                    self.api.transcribe(types.SimpleNamespace(is_disconnected=is_disconnected), Upload(b"preview"))
                )
                await preview_read.wait()
                disconnected = True
                final = asyncio.create_task(
                    self.api.transcribe(AsyncMock(is_disconnected=AsyncMock(return_value=False)), Upload(b"final"))
                )
            preview_result, final_result = await asyncio.gather(preview, final)

        self.assertEqual(ran, ["final"])
        self.assertEqual(preview_result.status_code, 499)
        self.assertEqual(final_result, {"text": "final"})

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
