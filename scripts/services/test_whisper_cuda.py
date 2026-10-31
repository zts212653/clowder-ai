#!/usr/bin/env python3
"""Exercise faster-whisper initialization without GPUs, downloads, or torch."""

import sys
import types
import unittest
from unittest.mock import Mock, patch

if __package__:
    from .test_whisper_worker import _load_whisper_api
else:
    from test_whisper_worker import _load_whisper_api


class FasterWhisperInitializationTest(unittest.TestCase):
    def setUp(self):
        self.api = _load_whisper_api()
        self.api.model_path = "fixture-model"

    def tearDown(self):
        self.api._shutdown_qwen_worker()

    def initialize(self, cuda_devices, constructor, torch=None):
        modules = {
            "ctranslate2": types.SimpleNamespace(
                get_cuda_device_count=Mock(return_value=cuda_devices)
            ),
            "faster_whisper": types.SimpleNamespace(WhisperModel=constructor),
            "torch": torch,
        }
        with patch.dict(sys.modules, modules):
            return self.api._try_faster_whisper()

    def test_ctranslate2_cuda_loads_without_torch(self):
        model = object()
        constructor = Mock(return_value=model)
        self.assertTrue(self.initialize(1, constructor))
        constructor.assert_called_once_with(
            "fixture-model", device="cuda", compute_type="float16"
        )
        self.assertIs(self.api._fw_model, model)
        self.assertTrue(self.api.model_loaded)

    def test_no_cuda_and_no_torch_loads_cpu(self):
        constructor = Mock(return_value=object())
        self.assertTrue(self.initialize(0, constructor))
        constructor.assert_called_once_with(
            "fixture-model", device="cpu", compute_type="int8"
        )

    def test_cuda_initialization_failure_retries_cpu(self):
        model = object()
        constructor = Mock(side_effect=[RuntimeError("CUDA unavailable"), model])
        self.assertTrue(self.initialize(1, constructor))
        self.assertEqual(
            [call.kwargs["device"] for call in constructor.call_args_list],
            ["cuda", "cpu"],
        )
        self.assertIs(self.api._fw_model, model)
        self.assertEqual(self.api._backend, "faster-whisper")

    def test_cpu_failure_does_not_report_success(self):
        constructor = Mock(side_effect=RuntimeError("model unavailable"))
        self.assertFalse(self.initialize(1, constructor))
        self.assertEqual(constructor.call_count, 2)
        self.assertFalse(self.api.model_loaded)
        self.assertIsNone(self.api._fw_model)

    def test_broken_optional_torch_import_still_loads_cpu(self):
        constructor = Mock(return_value=object())
        original_import = __import__

        def import_with_broken_torch(name, *args, **kwargs):
            if name == "torch":
                raise OSError("torch native library unavailable")
            return original_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=import_with_broken_torch):
            self.assertTrue(self.initialize(0, constructor))
        constructor.assert_called_once_with(
            "fixture-model", device="cpu", compute_type="int8"
        )

    def test_optional_torch_probe_failure_still_loads_cpu(self):
        constructor = Mock(return_value=object())
        torch = types.SimpleNamespace(
            cuda=types.SimpleNamespace(is_available=Mock(side_effect=RuntimeError("driver unavailable")))
        )
        self.assertTrue(self.initialize(0, constructor, torch))
        constructor.assert_called_once_with(
            "fixture-model", device="cpu", compute_type="int8"
        )

    def test_torch_cuda_is_used_when_ctranslate2_reports_no_device(self):
        constructor = Mock(return_value=object())
        torch = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: True))
        self.assertTrue(self.initialize(0, constructor, torch))
        self.assertEqual(constructor.call_args.kwargs["device"], "cuda")


if __name__ == "__main__":
    unittest.main()
