from __future__ import annotations

import asyncio
import base64
import importlib.util
import sys
import tempfile
import threading
import types
import unittest
import wave
from array import array
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
API_PATH = ROOT / "scripts" / "services" / "tts-api.py"


def service_dependency_stubs():
    """Provide import-only framework stubs for dependency-light repository checks."""
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

    class Request:
        async def is_disconnected(self) -> bool:
            return False

    fastapi.FastAPI = FastAPI
    fastapi.HTTPException = HTTPException
    fastapi.Request = Request

    middleware = types.ModuleType("fastapi.middleware")
    middleware.__path__ = []
    cors = types.ModuleType("fastapi.middleware.cors")
    cors.CORSMiddleware = type("CORSMiddleware", (), {})

    responses = types.ModuleType("fastapi.responses")

    class Response:
        def __init__(self, content=b"", media_type=None, headers=None):
            self.body = content
            self.media_type = media_type
            self.headers = headers or {}

    class StreamingResponse:
        def __init__(self, body_iterator, media_type=None):
            async def iterate_sync_body():
                for part in body_iterator:
                    yield part

            self.body_iterator = body_iterator if hasattr(body_iterator, "__aiter__") else iterate_sync_body()
            self.media_type = media_type

    responses.Response = Response
    responses.StreamingResponse = StreamingResponse

    pydantic = types.ModuleType("pydantic")

    class BaseModel:
        def __init__(self, **values):
            for name in self.__class__.__annotations__:
                setattr(self, name, values.get(name, getattr(self.__class__, name, None)))

    def Field(default=..., **_kwargs):
        return None if default is ... else default

    pydantic.BaseModel = BaseModel
    pydantic.Field = Field

    uvicorn = types.ModuleType("uvicorn")
    uvicorn.run = lambda *_args, **_kwargs: None

    return {
        "fastapi": fastapi,
        "fastapi.middleware": middleware,
        "fastapi.middleware.cors": cors,
        "fastapi.responses": responses,
        "pydantic": pydantic,
        "uvicorn": uvicorn,
    }


def load_tts_api():
    with patch.dict(sys.modules, service_dependency_stubs()):
        spec = importlib.util.spec_from_file_location("cat_cafe_tts_api_test", API_PATH)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module


def wav_bytes(samples: list[float], sample_rate: int = 24_000) -> bytes:
    with tempfile.SpooledTemporaryFile() as output:
        with wave.open(output, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(sample_rate)
            pcm = array("h", (round(max(-1, min(1, sample)) * 32767) for sample in samples))
            wav_file.writeframes(pcm.tobytes())
        output.seek(0)
        return output.read()


class FakeCloneModel:
    sample_rate = 24_000

    def __init__(self) -> None:
        self.generate_calls: list[dict] = []

    def generate(self, **kwargs):
        self.generate_calls.append(kwargs)
        yield SimpleNamespace(
            audio=[0.0, 0.25, -0.25, 0.0],
            samples=4,
            sample_rate=self.sample_rate,
            is_final_chunk=True,
        )


class FakeRequest:
    def __init__(self) -> None:
        self.disconnected = False

    async def is_disconnected(self) -> bool:
        return self.disconnected


class QwenCloneRuntimeTest(unittest.IsolatedAsyncioTestCase):
    async def test_health_advertises_the_stream_route_contract(self) -> None:
        api = load_tts_api()

        health = await api.health()

        self.assertIn("speech-stream-route-v1", health["capabilities"])

    async def test_reuses_one_loaded_model_across_synthesis_requests(self) -> None:
        api = load_tts_api()
        model = FakeCloneModel()
        load_calls: list[str] = []
        generate_models: list[object] = []

        def load_model(model_name: str):
            load_calls.append(model_name)
            return model

        def generate_audio(*, model: object, output_path: str, audio_format: str, **_kwargs) -> None:
            generate_models.append(model)
            Path(output_path, f"audio_000.{audio_format}").write_bytes(wav_bytes([0.0] * 8))

        modules = {
            "mlx_audio": types.ModuleType("mlx_audio"),
            "mlx_audio.tts": types.ModuleType("mlx_audio.tts"),
            "mlx_audio.tts.generate": types.SimpleNamespace(generate_audio=generate_audio),
            "mlx_audio.tts.utils": types.SimpleNamespace(load_model=load_model),
        }
        adapter = api.Qwen3CloneAdapter(model="fixture/qwen")

        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(sys.modules, modules):
            reference_path = Path(temp_dir, "reference.wav")
            reference_path.write_bytes(wav_bytes([0.0] * 8))
            for text in ("第一句", "第二句"):
                audio, actual_format = await adapter.synthesize(
                    text=text,
                    voice="unused",
                    lang_code="zh",
                    speed=1.0,
                    audio_format="wav",
                    ref_audio=str(reference_path),
                    ref_text="参考文本",
                )
                self.assertTrue(audio.startswith(b"RIFF"))
                self.assertEqual(actual_format, "wav")

        self.assertEqual(load_calls, ["fixture/qwen"])
        self.assertEqual(generate_models, [model, model])

    async def test_streams_clone_chunks_and_a_complete_wav(self) -> None:
        api = load_tts_api()
        model = FakeCloneModel()
        modules = {
            "mlx_audio": types.ModuleType("mlx_audio"),
            "mlx_audio.tts": types.ModuleType("mlx_audio.tts"),
            "mlx_audio.tts.utils": types.SimpleNamespace(load_model=lambda _name: model),
        }
        adapter = api.Qwen3CloneAdapter(model="fixture/qwen")

        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(sys.modules, modules):
            reference_path = Path(temp_dir, "reference.wav")
            reference_path.write_bytes(wav_bytes([0.0] * 8))
            events = await asyncio.to_thread(
                lambda: list(
                    adapter.synthesize_stream(
                        text="需要流式播放的句子",
                        lang_code="zh",
                        ref_audio=str(reference_path),
                        ref_text="参考文本",
                        temperature=0.3,
                        streaming_interval=0.5,
                    )
                )
            )

        self.assertEqual([event["type"] for event in events], ["chunk", "final"])
        for event in events:
            self.assertTrue(base64.b64decode(event["audio_base64"]).startswith(b"RIFF"))
        self.assertEqual(len(model.generate_calls), 1)
        self.assertEqual(model.generate_calls[0]["text"], "需要流式播放的句子")
        self.assertEqual(model.generate_calls[0]["lang_code"], "zh")
        self.assertEqual(model.generate_calls[0]["ref_text"], "参考文本")
        self.assertEqual(model.generate_calls[0]["temperature"], 0.3)
        self.assertEqual(model.generate_calls[0]["stream"], True)
        self.assertEqual(model.generate_calls[0]["streaming_interval"], 0.5)
        self.assertEqual(model.generate_calls[0]["verbose"], False)
        self.assertTrue(model.generate_calls[0]["ref_audio"].endswith("reference.wav"))

    async def test_exposes_native_clone_stream_as_ndjson(self) -> None:
        api = load_tts_api()
        model = FakeCloneModel()
        modules = {
            "mlx_audio": types.ModuleType("mlx_audio"),
            "mlx_audio.tts": types.ModuleType("mlx_audio.tts"),
            "mlx_audio.tts.utils": types.SimpleNamespace(load_model=lambda _name: model),
        }
        previous_adapter = api.adapter
        previous_ready = api.adapter_ready
        try:
            with tempfile.TemporaryDirectory() as temp_dir, patch.dict(sys.modules, modules):
                reference_path = Path(temp_dir, "reference.wav")
                reference_path.write_bytes(wav_bytes([0.0] * 8))
                api.adapter = api.Qwen3CloneAdapter(model="fixture/qwen")
                api.adapter_ready = True
                response = await api.synthesize_stream_endpoint(
                    FakeRequest(),
                    api.SpeechRequest(
                        input="端点流式听读。",
                        lang_code="zh",
                        ref_audio=str(reference_path),
                        ref_text="参考文本",
                    )
                )
                body = b""
                async for part in response.body_iterator:
                    body += part if isinstance(part, bytes) else part.encode()
        finally:
            api.adapter = previous_adapter
            api.adapter_ready = previous_ready

        events = [__import__("json").loads(line) for line in body.decode().splitlines()]
        self.assertEqual(response.media_type, "application/x-ndjson")
        self.assertEqual([event["type"] for event in events], ["chunk", "final"])

    async def test_keeps_warmup_and_native_stream_on_one_mlx_thread(self) -> None:
        api = load_tts_api()

        class ThreadBoundCloneModel(FakeCloneModel):
            owner_thread: int | None = None

            def generate(self, **kwargs):
                if threading.get_ident() != self.owner_thread:
                    raise RuntimeError("MLX stream resumed on a different thread")
                yield from super().generate(**kwargs)

        model = ThreadBoundCloneModel()

        def load_model(_model_name: str):
            model.owner_thread = threading.get_ident()
            return model

        def generate_audio(*, output_path: str, audio_format: str, **_kwargs) -> None:
            Path(output_path, f"audio_000.{audio_format}").write_bytes(wav_bytes([0.0] * 8))

        modules = {
            "mlx_audio": types.ModuleType("mlx_audio"),
            "mlx_audio.tts": types.ModuleType("mlx_audio.tts"),
            "mlx_audio.tts.generate": types.SimpleNamespace(generate_audio=generate_audio),
            "mlx_audio.tts.utils": types.SimpleNamespace(load_model=load_model),
        }
        previous_adapter = api.adapter
        previous_ready = api.adapter_ready
        try:
            with tempfile.TemporaryDirectory() as temp_dir, patch.dict(sys.modules, modules):
                reference_path = Path(temp_dir, "reference.wav")
                reference_path.write_bytes(wav_bytes([0.0] * 8))
                api.adapter = api.Qwen3CloneAdapter(model="fixture/qwen")
                api.adapter.warmup()
                api.adapter_ready = True
                response = await api.synthesize_stream_endpoint(
                    FakeRequest(),
                    api.SpeechRequest(
                        input="线程亲和必须稳定。",
                        lang_code="zh",
                        ref_audio=str(reference_path),
                        ref_text="参考文本",
                    ),
                )
                events = []
                async for part in response.body_iterator:
                    events.append(__import__("json").loads(part))
        finally:
            api.adapter = previous_adapter
            api.adapter_ready = previous_ready

        self.assertEqual([event["type"] for event in events], ["chunk", "final"])

    async def test_keeps_every_native_stream_yield_on_the_same_worker_thread(self) -> None:
        api = load_tts_api()
        model = FakeCloneModel()
        modules = {
            "mlx_audio": types.ModuleType("mlx_audio"),
            "mlx_audio.tts": types.ModuleType("mlx_audio.tts"),
            "mlx_audio.tts.utils": types.SimpleNamespace(load_model=lambda _name: model),
        }
        previous_adapter = api.adapter
        previous_ready = api.adapter_ready
        try:
            with tempfile.TemporaryDirectory() as temp_dir, patch.dict(sys.modules, modules):
                reference_path = Path(temp_dir, "reference.wav")
                reference_path.write_bytes(wav_bytes([0.0] * 8))
                api.adapter = api.Qwen3CloneAdapter(model="fixture/qwen")
                api.adapter_ready = True
                worker_threads: list[int] = []

                def thread_bound_stream(**_kwargs):
                    owner = threading.get_ident()
                    worker_threads.append(owner)
                    for event_type in ("chunk", "final"):
                        if threading.get_ident() != owner:
                            raise RuntimeError("stream generator changed worker threads")
                        yield {
                            "type": event_type,
                            "audio_base64": base64.b64encode(wav_bytes([0.0] * 8)).decode("ascii"),
                            **({"duration_sec": 0.1, "final": True} if event_type == "chunk" else {}),
                        }

                api.adapter.synthesize_stream = thread_bound_stream
                response = await api.synthesize_stream_endpoint(
                    FakeRequest(),
                    api.SpeechRequest(
                        input="同一生成器不能换线程。",
                        lang_code="zh",
                        ref_audio=str(reference_path),
                        ref_text="参考文本",
                    ),
                )
                events = []
                async for part in response.body_iterator:
                    events.append(__import__("json").loads(part))
        finally:
            api.adapter = previous_adapter
            api.adapter_ready = previous_ready

        self.assertEqual([event["type"] for event in events], ["chunk", "final"])
        self.assertEqual(len(set(worker_threads)), 1)

    async def test_disconnect_closes_clone_stream_and_releases_model_lock(self) -> None:
        api = load_tts_api()
        model = FakeCloneModel()
        modules = {
            "mlx_audio": types.ModuleType("mlx_audio"),
            "mlx_audio.tts": types.ModuleType("mlx_audio.tts"),
            "mlx_audio.tts.utils": types.SimpleNamespace(load_model=lambda _name: model),
        }
        previous_adapter = api.adapter
        previous_ready = api.adapter_ready
        request = FakeRequest()
        try:
            with tempfile.TemporaryDirectory() as temp_dir, patch.dict(sys.modules, modules):
                reference_path = Path(temp_dir, "reference.wav")
                reference_path.write_bytes(wav_bytes([0.0] * 8))
                adapter = api.Qwen3CloneAdapter(model="fixture/qwen")
                api.adapter = adapter
                api.adapter_ready = True
                response = await api.synthesize_stream_endpoint(
                    request,
                    api.SpeechRequest(
                        input="断连后必须释放模型锁。",
                        lang_code="zh",
                        ref_audio=str(reference_path),
                        ref_text="参考文本",
                    ),
                )
                iterator = response.body_iterator.__aiter__()
                first = await anext(iterator)
                self.assertEqual(__import__("json").loads(first)["type"], "chunk")
                request.disconnected = True
                with self.assertRaises(StopAsyncIteration):
                    await anext(iterator)
                self.assertTrue(adapter._lock.acquire(blocking=False), "disconnect must release the model lock")
                adapter._lock.release()
        finally:
            api.adapter = previous_adapter
            api.adapter_ready = previous_ready

    async def test_stream_failure_emits_a_structured_error_line(self) -> None:
        api = load_tts_api()

        class FailingCloneModel:
            def generate(self, **_kwargs):
                raise RuntimeError("model stream exploded")
                yield  # pragma: no cover - keeps this a generator

        model = FailingCloneModel()
        modules = {
            "mlx_audio": types.ModuleType("mlx_audio"),
            "mlx_audio.tts": types.ModuleType("mlx_audio.tts"),
            "mlx_audio.tts.utils": types.SimpleNamespace(load_model=lambda _name: model),
        }
        previous_adapter = api.adapter
        previous_ready = api.adapter_ready
        try:
            with tempfile.TemporaryDirectory() as temp_dir, patch.dict(sys.modules, modules):
                reference_path = Path(temp_dir, "reference.wav")
                reference_path.write_bytes(wav_bytes([0.0] * 8))
                api.adapter = api.Qwen3CloneAdapter(model="fixture/qwen")
                api.adapter_ready = True
                response = await api.synthesize_stream_endpoint(
                    FakeRequest(),
                    api.SpeechRequest(
                        input="错误也必须有终态。",
                        lang_code="zh",
                        ref_audio=str(reference_path),
                        ref_text="参考文本",
                    ),
                )
                events = []
                with self.assertLogs("tts-api", level="ERROR") as captured_logs:
                    async for part in response.body_iterator:
                        events.append(__import__("json").loads(part))
        finally:
            api.adapter = previous_adapter
            api.adapter_ready = previous_ready

        self.assertEqual(events, [{"type": "error", "error": "model stream exploded"}])
        self.assertTrue(any("Native clone stream failed" in line for line in captured_logs.output))


if __name__ == "__main__":
    unittest.main()
