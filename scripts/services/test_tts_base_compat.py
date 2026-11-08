"""Regression coverage for Base models without preset speakers."""

import contextlib
import io
import os
import re
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from scripts.services.test_tts_runtime import API_PATH, load_tts_api, mlx_memory_stubs, wav_bytes


def fake_mlx(model_type, calls, *, emit_audio=True, preset_voice=True):
    model = SimpleNamespace(config=SimpleNamespace(tts_model_type=model_type, model_type=model_type))

    def load_model(_name):
        calls.append(("load", threading.get_ident(), {}))
        return model

    def generate_audio(**kwargs):
        calls.append(("generate", threading.get_ident(), kwargs))
        if not emit_audio:
            return  # The library can swallow inference errors and emit no file.
        if model_type == "base" and kwargs.get("voice") is not None:
            raise ValueError("Base models have no preset voices")
        if model_type == "kokoro" and kwargs.get("voice") != "zm_yunjian":
            raise ValueError("Kokoro requires its configured voice")
        if model_type == "breeze_tts" and preset_voice and kwargs.get("voice") != "S0":
            raise ValueError("Breeze requires its supported default speaker")
        suffix = kwargs.get("audio_format", "wav")
        Path(kwargs["output_path"], f"audio_000.{suffix}").write_bytes(
            wav_bytes([0.0, 0.25, -0.25, 0.0])
        )

    return {
        **mlx_memory_stubs(),
        "mlx_audio": types.ModuleType("mlx_audio"),
        "mlx_audio.tts": types.ModuleType("mlx_audio.tts"),
        "mlx_audio.tts.generate": SimpleNamespace(generate_audio=generate_audio),
        "mlx_audio.tts.utils": SimpleNamespace(load_model=load_model),
    }


class BaseCompatibilityTest(unittest.IsolatedAsyncioTestCase):
    async def test_explicit_model_mismatch_is_rejected_before_synthesis(self):
        api = load_tts_api()
        previous = api.adapter, api.adapter_ready
        adapter = api.Qwen3CloneAdapter(model="mlx-community/Breeze-TTS-2-mlx")
        try:
            api.adapter, api.adapter_ready = adapter, True
            calls = []
            with patch.dict(sys.modules, fake_mlx("base", calls)):
                for streaming in (False, True):
                    with self.subTest(streaming=streaming), self.assertRaises(api.HTTPException) as failure:
                        req = api.SpeechRequest(input="模型已经切换", model="mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16")
                        if streaming:
                            await api.synthesize_stream_endpoint(object(), req)
                        else:
                            await api.synthesize_endpoint(req)
                    self.assertEqual(failure.exception.status_code, 409)
                self.assertEqual(calls, [])
                response = await api.synthesize_endpoint(api.SpeechRequest(input="通用客户端", model="tts-1"))
                self.assertTrue(response.body.startswith(b"RIFF"))
        finally:
            api.adapter, api.adapter_ready = previous
            adapter._inference_executor.shutdown()

    async def test_default_and_missing_reference_requests_omit_preset_voice(self):
        api = load_tts_api()
        calls = []
        with tempfile.TemporaryDirectory() as directory, patch.dict(sys.modules, fake_mlx("base", calls)):
            adapter = api.Qwen3CloneAdapter(model="fixture/base")
            try:
                for reference in (None, str(Path(directory, "missing.wav"))):
                    with self.subTest(reference=reference):
                        audio, fmt = await adapter.synthesize(
                            text="你好", voice="zm_yunjian", lang_code="zh",
                            speed=1, audio_format="wav", ref_audio=reference,
                        )
                        self.assertTrue(audio.startswith(b"RIFF"))
                        self.assertEqual(fmt, "wav")
                self.assertEqual(len([c for c in calls if c[0] == "generate"]), 2)
            finally:
                adapter._inference_executor.shutdown()

    async def test_breeze_repetition_control_applies_to_static_and_stream_only(self):
        for model_type in ("breeze_tts", "base"):
            with self.subTest(model_type=model_type), tempfile.TemporaryDirectory() as directory:
                api = load_tts_api()
                calls = []
                modules = fake_mlx(model_type, calls)
                def generate_audio(**kwargs):
                    calls.append(("generate", threading.get_ident(), kwargs))
                    Path(kwargs["output_path"], "audio_000.wav").write_bytes(wav_bytes([0.0, 0.25]))
                modules["mlx_audio.tts.generate"] = SimpleNamespace(generate_audio=generate_audio)
                model = modules["mlx_audio.tts.utils"].load_model("fixture")
                def generate(**kwargs):
                    calls.append(("stream", threading.get_ident(), kwargs))
                    yield SimpleNamespace(audio=[0.0, 0.25], sample_rate=24000)
                model.generate = generate
                adapter = api.Qwen3CloneAdapter(model="fixture/model")
                adapter._loaded_model = model
                reference = Path(directory, "ref.wav")
                reference.write_bytes(wav_bytes([0.0, 0.25]))
                try:
                    with patch.dict(sys.modules, modules):
                        await adapter.synthesize(text="完整短句", voice="unused", lang_code="zh",
                            speed=1, audio_format="wav", temperature=0.3)
                        list(adapter.synthesize_stream(text="完整短句", lang_code="zh",
                            ref_audio=str(reference), ref_text="参考", temperature=0.3))
                    options = [c[2] for c in calls if c[0] in ("generate", "stream")]
                    self.assertEqual(len(options), 2)
                    for kwargs in options:
                        self.assertEqual(kwargs["temperature"], 0.3)
                        if model_type == "breeze_tts":
                            self.assertEqual(kwargs.get("repetition_penalty"), 1.06)
                        else:
                            self.assertNotIn("repetition_penalty", kwargs)
                finally:
                    adapter._inference_executor.shutdown()

    async def test_generation_policy_health_request_fence_and_response_acknowledgement(self):
        policy = "breeze-repetition-1.06-v1"
        for model_type in ("breeze_tts", "base"):
            with self.subTest(model_type=model_type), tempfile.TemporaryDirectory() as directory:
                api = load_tts_api()
                calls = []
                modules = fake_mlx(model_type, calls, preset_voice=False)
                model = modules["mlx_audio.tts.utils"].load_model("fixture")
                def generate(**kwargs):
                    calls.append(("stream", threading.get_ident(), kwargs))
                    yield SimpleNamespace(audio=[0.0, 0.25], sample_rate=24000)
                model.generate = generate
                adapter = api.Qwen3CloneAdapter(model="fixture/model")
                adapter._loaded_model = model
                previous = api.adapter, api.adapter_ready
                reference = Path(directory, "ref.wav")
                reference.write_bytes(wav_bytes([0.0, 0.25]))
                expected = policy if model_type == "breeze_tts" else None
                try:
                    api.adapter, api.adapter_ready = adapter, True
                    self.assertEqual((await api.health()).get("generation_profile"), expected)
                    with patch.dict(sys.modules, modules):
                        for streaming in (False, True):
                            invalid = api.SpeechRequest(input="保持策略一致。", generation_profile="different-policy")
                            with self.assertRaises(api.HTTPException) as failure:
                                if streaming:
                                    await api.synthesize_stream_endpoint(object(), invalid)
                                else:
                                    await api.synthesize_endpoint(invalid)
                            self.assertEqual(failure.exception.status_code, 409)
                        self.assertEqual([c for c in calls if c[0] in ("generate", "stream")], [])
                        for requested in (None, expected or ""):
                            req = api.SpeechRequest(input="保持策略一致。", generation_profile=requested,
                                ref_audio=str(reference), ref_text="参考。")
                            static = await api.synthesize_endpoint(req)
                            self.assertEqual(static.headers.get("X-TTS-Generation-Profile"), expected)
                            stream = await api.synthesize_stream_endpoint(api.Request(), req)
                            self.assertEqual(stream.headers.get("X-TTS-Generation-Profile"), expected)
                            async for _event in stream.body_iterator:
                                pass
                finally:
                    api.adapter, api.adapter_ready = previous
                    adapter._inference_executor.shutdown()

    async def test_warmup_checks_real_synthesis_on_the_model_thread(self):
        api = load_tts_api()
        calls = []
        with patch.dict(sys.modules, fake_mlx("base", calls)):
            adapter = api.Qwen3CloneAdapter(model="fixture/base")
            try:
                adapter.warmup()
            finally:
                adapter._inference_executor.shutdown()
        self.assertEqual([c[0] for c in calls], ["load", "generate"])
        self.assertEqual(calls[0][1], calls[1][1])
        self.assertNotEqual(calls[0][1], threading.get_ident())

    async def test_deep_health_uses_real_synthesis_without_reference(self):
        api = load_tts_api()
        calls = []
        previous = api.adapter, api.adapter_ready
        with patch.dict(sys.modules, fake_mlx("base", calls)):
            adapter = api.Qwen3CloneAdapter(model="fixture/base")
            try:
                api.adapter, api.adapter_ready = adapter, True
                result = await api.health_deep()
                self.assertEqual(result["status"], "ok")
                generated = [c for c in calls if c[0] == "generate"]
                self.assertEqual(len(generated), 1)
                self.assertEqual(generated[0][2]["text"], "你好")
                self.assertEqual(generated[0][2]["lang_code"], "zh")
            finally:
                api.adapter, api.adapter_ready = previous
                adapter._inference_executor.shutdown()


class InstallWarmupTest(unittest.TestCase):
    def run_hook(self, model_type, *, emit_audio=True):
        source = API_PATH.with_name("tts-install.sh").read_text()
        script = re.search(r"<<'PY'[^\n]*\n(.*?)\nPY", source, re.S).group(1)
        calls = []
        with tempfile.TemporaryDirectory() as directory:
            argv = ["-", f"fixture/{model_type}", "zm_yunjian", directory]
            with patch.object(sys, "argv", argv), patch.dict(os.environ), patch.dict(
                sys.modules, fake_mlx(model_type, calls, emit_audio=emit_audio)
            ), contextlib.redirect_stdout(io.StringIO()):
                exec(compile(script, "tts-install.sh:warmup", "exec"), {})
            return calls

    def test_models_use_their_own_voice_capabilities(self):
        for model_type in ("base", "kokoro", "breeze_tts"):
            with self.subTest(model_type=model_type):
                calls = self.run_hook(model_type)
                self.assertEqual(len([c for c in calls if c[0] == "generate"]), 1)

    def test_missing_output_is_an_install_failure(self):
        with self.assertRaises(RuntimeError):
            self.run_hook("base", emit_audio=False)


if __name__ == "__main__":
    unittest.main()
