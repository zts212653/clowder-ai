"""Clone adapter resource lifetime checks without a GPU or model download."""
import asyncio
import gc
import json
import sys
import tempfile
import threading
import types
import unittest
import weakref
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from scripts.services.test_tts_runtime import FakeRequest, load_tts_api, wav_bytes


class Audio:
    def tolist(self):
        return [0.1, -0.1]


class MemoryFixture:
    def __init__(self, test):
        self.test = test
        self.calls = []
        self.outputs = []
        self.fail_cleanup = False
        self.fail_generation = False
        self.cache = 0
        self.resume_stream = None
        self.core = SimpleNamespace(
            set_cache_limit=self.limit, clear_cache=self.clear,
            get_active_memory=lambda: 7_000_000_000,
            get_cache_memory=lambda: self.cache,
            get_peak_memory=lambda: 9_000_000_000,
        )
        self.model = SimpleNamespace(config=SimpleNamespace(model_type='breeze_tts'), generate=self.generate)

    def limit(self, amount):
        self.calls.append(('limit', threading.get_ident(), amount))

    def clear(self):
        gc.collect()
        self.test.assertTrue(all(ref() is None for ref in self.outputs), 'MLX outputs must be released before cache clear')
        self.calls.append(('clear', threading.get_ident(), self.cache))
        if self.fail_cleanup:
            raise RuntimeError('cleanup failed')
        self.cache = 0

    def load(self, _name):
        self.calls.append(('load', threading.get_ident(), None))
        self.test.assertTrue(self.calls and self.calls[0][0] == 'limit', 'configure cache before loading the model')
        return self.model

    def static(self, *, output_path, **kwargs):
        self.calls.append(('static', threading.get_ident(), kwargs))
        self.cache = 4_000_000_000
        if self.fail_generation:
            raise RuntimeError('original generation failure')
        Path(output_path, 'sample.wav').write_bytes(wav_bytes([0.1, -0.1]))

    def generate(self, **kwargs):
        self.calls.append(('stream', threading.get_ident(), kwargs))
        audio = Audio()
        self.outputs.append(weakref.ref(audio))
        self.cache = 4_000_000_000
        try:
            yield SimpleNamespace(audio=audio, sample_rate=24000)
            if self.resume_stream is not None:
                if not self.resume_stream.wait(timeout=2):
                    raise RuntimeError('test stream resume timed out')
                yield SimpleNamespace(audio=audio, sample_rate=24000)
            if self.fail_generation:
                raise RuntimeError('original generation failure')
        finally:
            self.calls.append(('closed', threading.get_ident(), None))

    def modules(self):
        return {
            'mlx': types.ModuleType('mlx'), 'mlx.core': self.core,
            'mlx_audio': types.ModuleType('mlx_audio'), 'mlx_audio.tts': types.ModuleType('mlx_audio.tts'),
            'mlx_audio.tts.utils': SimpleNamespace(load_model=self.load),
            'mlx_audio.tts.generate': SimpleNamespace(generate_audio=self.static),
        }


class CloneMemoryTest(unittest.IsolatedAsyncioTestCase):
    async def test_static_resources_are_bounded_and_released_on_the_model_thread(self):
        api = load_tts_api()
        fixture = MemoryFixture(self)
        adapter = api.Qwen3CloneAdapter(model='fixture/custom')
        try:
            with patch.dict(sys.modules, fixture.modules()):
                for _ in range(2):
                    data, fmt = await adapter.synthesize('短句', 'unused', 'zh', 1, 'wav')
                    self.assertTrue(data.startswith(b'RIFF'))
                    self.assertEqual(fmt, 'wav')
                    self.assertEqual(fixture.cache, 0)
                await asyncio.to_thread(adapter.warmup)
                self.assertEqual(fixture.cache, 0, 'warmup shares the same cleanup path')
            self.assertEqual(len([c for c in fixture.calls if c[0] == 'limit']), 1)
            self.assertEqual(fixture.calls[0][2], 512 * 1024**2)
            self.assertEqual(len([c for c in fixture.calls if c[0] == 'load']), 1)
            self.assertEqual(len({c[1] for c in fixture.calls}), 1)
            self.assertIs(adapter._loaded_model, fixture.model, 'resident model stays loaded')
        finally:
            adapter._inference_executor.shutdown()

    async def test_cleanup_failure_preserves_static_generation_error_and_next_request(self):
        api = load_tts_api()
        fixture = MemoryFixture(self)
        adapter = api.Qwen3CloneAdapter(model='fixture/custom')
        try:
            with patch.dict(sys.modules, fixture.modules()):
                fixture.fail_generation = fixture.fail_cleanup = True
                with self.assertRaisesRegex(RuntimeError, 'original generation failure'):
                    await adapter.synthesize('失败', 'unused', 'zh', 1, 'wav')
                self.assertTrue(any(c[0] == 'clear' for c in fixture.calls))
                fixture.fail_generation = fixture.fail_cleanup = False
                self.assertTrue((await adapter.synthesize('恢复', 'unused', 'zh', 1, 'wav'))[0].startswith(b'RIFF'))
        finally:
            adapter._inference_executor.shutdown()

    async def test_stream_completion_error_and_close_release_outputs_before_cleanup(self):
        for exit_kind in ('complete', 'error', 'close'):
            with self.subTest(exit_kind=exit_kind), tempfile.TemporaryDirectory() as directory:
                api = load_tts_api()
                fixture = MemoryFixture(self)
                adapter = api.Qwen3CloneAdapter(model='fixture/custom')
                reference = Path(directory, 'ref.wav')
                reference.write_bytes(wav_bytes([0.1, -0.1]))
                try:
                    with patch.dict(sys.modules, fixture.modules()):
                        def run():
                            stream = adapter.synthesize_stream(text='短句', lang_code='zh', ref_audio=str(reference), ref_text='参考')
                            self.assertEqual(next(stream)['type'], 'chunk')
                            fixture.fail_generation = exit_kind == 'error'
                            fixture.fail_cleanup = exit_kind != 'complete'
                            if exit_kind == 'close':
                                stream.close()
                            elif exit_kind == 'error':
                                with self.assertRaisesRegex(RuntimeError, 'original generation failure'):
                                    list(stream)
                            else:
                                self.assertEqual(list(stream)[-1]['type'], 'final')
                        await asyncio.wrap_future(adapter.submit_inference(run))
                        self.assertTrue(any(c[0] == 'closed' for c in fixture.calls))
                        self.assertTrue(any(c[0] == 'clear' for c in fixture.calls))
                        self.assertTrue(adapter._lock.acquire(blocking=False), 'cleanup must always release the model lock')
                        adapter._lock.release()
                        fixture.fail_cleanup = fixture.fail_generation = False
                        self.assertTrue((await adapter.synthesize('恢复', 'unused', 'zh', 1, 'wav'))[0].startswith(b'RIFF'))
                    self.assertEqual(len({c[1] for c in fixture.calls}), 1)
                finally:
                    adapter._inference_executor.shutdown()

    async def test_client_disconnect_cleans_on_producer_thread_and_next_request_works(self):
        api = load_tts_api()
        fixture = MemoryFixture(self)
        fixture.resume_stream = threading.Event()
        adapter = api.Qwen3CloneAdapter(model='fixture/custom')
        request = FakeRequest()
        previous = api.adapter, api.adapter_ready
        try:
            with tempfile.TemporaryDirectory() as directory, patch.dict(sys.modules, fixture.modules()):
                reference = Path(directory, 'ref.wav')
                reference.write_bytes(wav_bytes([0.1, -0.1]))
                api.adapter, api.adapter_ready = adapter, True
                # Real readiness has already completed warmup before stream admission.
                await asyncio.wrap_future(adapter.submit_inference(adapter._ensure_model))
                response = await api.synthesize_stream_endpoint(request, api.SpeechRequest(
                    input='断开后恢复。', ref_audio=str(reference), ref_text='参考',
                ))
                iterator = response.body_iterator.__aiter__()
                self.assertIn('"type":"chunk"', await anext(iterator))
                request.disconnected = True
                fixture.resume_stream.set()
                with self.assertRaises(StopAsyncIteration):
                    await anext(iterator)
                self.assertEqual(fixture.cache, 0)
                self.assertTrue(any(c[0] == 'closed' for c in fixture.calls))
                self.assertTrue((await adapter.synthesize('恢复', 'unused', 'zh', 1, 'wav'))[0].startswith(b'RIFF'))
                self.assertEqual(len({c[1] for c in fixture.calls}), 1)
        finally:
            fixture.resume_stream.set()
            api.adapter, api.adapter_ready = previous
            adapter._inference_executor.shutdown()

    async def test_real_stream_endpoint_keeps_original_error_terminal_when_cleanup_fails(self):
        api = load_tts_api()
        fixture = MemoryFixture(self)
        adapter = api.Qwen3CloneAdapter(model='fixture/custom')
        previous = api.adapter, api.adapter_ready
        try:
            with tempfile.TemporaryDirectory() as directory, patch.dict(sys.modules, fixture.modules()):
                reference = Path(directory, 'ref.wav')
                reference.write_bytes(wav_bytes([0.1, -0.1]))
                api.adapter, api.adapter_ready = adapter, True
                await asyncio.wrap_future(adapter.submit_inference(adapter._ensure_model))
                fixture.fail_generation = fixture.fail_cleanup = True
                response = await api.synthesize_stream_endpoint(FakeRequest(), api.SpeechRequest(
                    input='失败后恢复。', ref_audio=str(reference), ref_text='参考',
                ))
                events = [json.loads(line) async for line in response.body_iterator]
                self.assertEqual(events[-1], {'type': 'error', 'error': 'original generation failure'})
                self.assertFalse(any(event['type'] == 'final' for event in events))
                fixture.fail_generation = fixture.fail_cleanup = False
                self.assertTrue((await adapter.synthesize('恢复', 'unused', 'zh', 1, 'wav'))[0].startswith(b'RIFF'))
        finally:
            api.adapter, api.adapter_ready = previous
            adapter._inference_executor.shutdown()


if __name__ == '__main__':
    unittest.main()
