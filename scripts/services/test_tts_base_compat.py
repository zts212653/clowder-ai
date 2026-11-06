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

from scripts.services.test_tts_runtime import API_PATH, load_tts_api, wav_bytes


def fake_mlx(model_type, calls, *, emit_audio=True):
    model = SimpleNamespace(config=SimpleNamespace(tts_model_type=model_type))

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
        suffix = kwargs.get("audio_format", "wav")
        Path(kwargs["output_path"], f"audio_000.{suffix}").write_bytes(
            wav_bytes([0.0, 0.25, -0.25, 0.0])
        )

    return {
        "mlx_audio": types.ModuleType("mlx_audio"),
        "mlx_audio.tts": types.ModuleType("mlx_audio.tts"),
        "mlx_audio.tts.generate": SimpleNamespace(generate_audio=generate_audio),
        "mlx_audio.tts.utils": SimpleNamespace(load_model=load_model),
    }


class BaseCompatibilityTest(unittest.IsolatedAsyncioTestCase):
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
                self.assertEqual(len([c for c in calls if c[0] == "generate"]), 1)
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

    def test_base_and_kokoro_use_their_own_voice_capabilities(self):
        for model_type in ("base", "kokoro"):
            with self.subTest(model_type=model_type):
                calls = self.run_hook(model_type)
                self.assertEqual(len([c for c in calls if c[0] == "generate"]), 1)

    def test_missing_output_is_an_install_failure(self):
        with self.assertRaises(RuntimeError):
            self.run_hook("base", emit_audio=False)


if __name__ == "__main__":
    unittest.main()
