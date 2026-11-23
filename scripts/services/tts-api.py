#!/usr/bin/env python3
"""
TTS server for Clowder AI voice output.
OpenAI-compatible endpoint: POST /v1/audio/speech

Supports multiple backends via TtsAdapter:
  - qwen3-clone (default): Qwen3-TTS Base + ref_audio voice cloning (三猫声线)
  - mlx-audio: Apple Silicon native, Kokoro-82M (legacy)
  - edge-tts: Microsoft cloud TTS (fallback, no GPU needed)

Usage:
  source ~/.cat-cafe/tts-venv/bin/activate
  python scripts/tts-api.py                                     # default: qwen3-clone (Qwen3-TTS Base)
  TTS_PROVIDER=mlx-audio python scripts/tts-api.py              # Kokoro-82M (legacy)
  TTS_PROVIDER=edge-tts python scripts/tts-api.py               # edge-tts fallback
  python scripts/tts-api.py --port 9879

Env vars:
  TTS_PROVIDER  — "qwen3-clone" (default), "mlx-audio", or "edge-tts"
  TTS_PORT      — server port (default: 9879)

Requires (qwen3-clone/mlx-audio): pip install mlx-audio "misaki[zh]"
Requires (edge-tts):               pip install edge-tts
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import gc
import hashlib
import io
import json
import logging
import os
import shutil
import signal
import stat
import sys
import tempfile
import threading
import time
import traceback
import wave
from abc import ABC, abstractmethod
from array import array
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

MAX_INPUT_CHARS = 5000
MIN_MLX_AUDIO_VERSION = (0, 4, 7)
TTS_API_CAPABILITIES = ["speech", "speech-stream-route-v1"]
MAX_REFERENCE_BYTES = 10 * 1024 * 1024

log = logging.getLogger("tts-api")

app = FastAPI(title="Clowder AI TTS Server")


class CapturedReference:
    def __init__(self, data: bytes | None, suffix: str = '.wav'):
        self.data = data
        self.suffix = suffix if suffix in {'.wav', '.mp3', '.flac', '.ogg', '.m4a'} else '.wav'
        self.sha256 = hashlib.sha256(data).hexdigest() if data is not None else None

    def headers(self) -> dict[str, str]:
        return {'X-TTS-Reference-Status': 'used' if self.data is not None else 'unavailable',
                **({'X-TTS-Reference-Sha256': self.sha256} if self.sha256 else {})}


def capture_reference(path: str | None, encoded: str | None = None, expected: str | None = None):
    if not path and encoded is None:
        return None
    try:
        if encoded is None:
            with open(path, 'rb') as source:
                data = source.read(MAX_REFERENCE_BYTES + 1)
        else:
            if len(encoded) > ((MAX_REFERENCE_BYTES + 2) // 3) * 4:
                raise HTTPException(413, detail='Reference audio exceeds 10 MiB')
            data = base64.b64decode(encoded, validate=True)
        if len(data) > MAX_REFERENCE_BYTES:
            raise HTTPException(413, detail='Reference audio exceeds 10 MiB')
        captured = CapturedReference(data if data else None, Path(path or 'reference.wav').suffix.lower())
        if not data:
            return captured
        if expected is not None and captured.sha256 != expected:
            raise HTTPException(409, detail='Reference audio digest differs from the supplied content')
        return captured
    except OSError:
        return CapturedReference(None)
    except ValueError as error:
        raise HTTPException(400, detail='Invalid reference audio content') from error


def reference_workspace() -> Path:
    root = Path(tempfile.gettempdir(), f'cat-cafe-tts-reference-v1-{os.getuid()}')
    root.mkdir(mode=0o700, exist_ok=True)
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError('Reference workspace must be private and owned by the reader')
    return root


@contextmanager
def reference_lock(path: Path, blocking: bool = True):
    import fcntl
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        yield
    finally:
        os.close(descriptor)


def reap_reference_jobs() -> dict[str, int]:
    root = reference_workspace()
    counts = {'removed': 0, 'active': 0}
    with reference_lock(root / '.registry'):
        for job in root.glob('job-*'):
            if job.is_symlink() or not job.is_dir():
                continue
            try:
                with reference_lock(job / '.lease', blocking=False):
                    shutil.rmtree(job)
                    counts['removed'] += 1
            except BlockingIOError:
                counts['active'] += 1
    return counts


@contextmanager
def reference_file(reference):
    if reference is None or reference.data is None:
        yield None
        return
    root = reference_workspace()
    with reference_lock(root / '.registry'):
        job = Path(tempfile.mkdtemp(prefix='job-', dir=root))
        lease = reference_lock(job / '.lease')
        lease.__enter__()
    try:
        target = job / f'reference{reference.suffix}'
        with os.fdopen(os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'wb') as output:
            output.write(reference.data)
        yield str(target)
    finally:
        with reference_lock(root / '.registry'):
            try:
                shutil.rmtree(job)
            finally:
                lease.__exit__(None, None, None)


def require_mlx_audio_runtime() -> None:
    """Fail closed when clone/stream fixes required by F279 are unavailable."""
    try:
        raw_version = version("mlx-audio")
        parsed = tuple(int(part) for part in raw_version.split(".")[:3])
    except (PackageNotFoundError, ValueError) as exc:
        raise RuntimeError("mlx-audio>=0.4.7 is required for Qwen clone streaming") from exc
    if parsed < MIN_MLX_AUDIO_VERSION:
        raise RuntimeError(
            f"mlx-audio>={'.'.join(map(str, MIN_MLX_AUDIO_VERSION))} is required; found {raw_version}. "
            "Reinstall the TTS service from Console settings."
        )


def _pcm16_bytes(audio) -> bytes:
    samples = audio.tolist() if hasattr(audio, "tolist") else audio
    pcm = array("h", (round(max(-1.0, min(1.0, float(sample))) * 32767) for sample in samples))
    if sys.byteorder != "little":
        pcm.byteswap()
    return pcm.tobytes()


def _wav_bytes(pcm: bytes, sample_rate: int) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm)
    return output.getvalue()


def resolve_cat_cafe_home() -> Path:
    raw = os.environ.get("CAT_CAFE_HOME")
    if raw:
        return Path(raw).expanduser()
    return Path(__file__).resolve().parents[2] / ".cat-cafe"


@app.on_event("startup")
async def _emit_ready_marker():
    """Push-based ready signal — see embed-api.py + service-logs.ts."""
    if os.name == 'posix':
        reap_reference_jobs()
    print("__CATCAFE_SIDECAR_READY__", flush=True)


app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


# ─── TTS Adapter ABC ─────────────────────────────────────────────────


class TtsAdapter(ABC):
    """Abstract TTS backend. Subclass to add new providers."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Provider identifier (e.g. 'mlx-audio', 'edge-tts')."""
        ...

    @property
    def model_name(self) -> str:
        """Model name for health/diagnostics. Override if applicable."""
        return "none"

    @abstractmethod
    async def synthesize(
        self,
        text: str,
        voice: str,
        lang_code: str,
        speed: float,
        audio_format: str,
    ) -> tuple[bytes, str]:
        """Synthesize text to audio bytes.

        Returns:
            (audio_bytes, actual_format) — actual_format may differ from
            audio_format if the backend doesn't support the requested format.
        """
        ...

    def warmup(self) -> None:
        """Pre-load model or verify connectivity. No-op by default."""


# ─── MLX-Audio Adapter ────────────────────────────────────────────────


class MlxAudioAdapter(TtsAdapter):
    """Apple Silicon native TTS via mlx-audio (Kokoro-82M default)."""

    def __init__(self, model: str = "mlx-community/Kokoro-82M-bf16"):
        self._model = model
        self._lock = asyncio.Lock()

    @property
    def name(self) -> str:
        return "mlx-audio"

    @property
    def model_name(self) -> str:
        return self._model

    async def synthesize(
        self, text: str, voice: str, lang_code: str, speed: float, audio_format: str,
    ) -> tuple[bytes, str]:
        try:
            from mlx_audio.tts.generate import generate_audio as tts_generate
        except ImportError as exc:
            raise RuntimeError(
                "mlx_audio.tts not available — pip install mlx-audio 'misaki[zh]'"
            ) from exc

        output_dir = Path(tempfile.mkdtemp(prefix="cat-cafe-tts-"))
        try:
            async with self._lock:
                await asyncio.to_thread(
                    tts_generate,
                    text=text,
                    model=self._model,
                    voice=voice,
                    lang_code=lang_code,
                    speed=speed,
                    audio_format=audio_format,
                    output_path=str(output_dir),
                )

            audio_files = list(output_dir.glob(f"*.{audio_format}"))
            if not audio_files:
                raise RuntimeError("No audio file generated")

            return audio_files[0].read_bytes(), audio_format
        finally:
            shutil.rmtree(output_dir, ignore_errors=True)

    def warmup(self) -> None:
        from mlx_audio.tts.generate import generate_audio as tts_generate

        warmup_dir = Path(tempfile.mkdtemp(prefix="cat-cafe-tts-warmup-"))
        try:
            tts_generate(
                text="你好",
                model=self._model,
                voice="zm_yunjian",
                lang_code="z",
                output_path=str(warmup_dir),
            )
        finally:
            shutil.rmtree(warmup_dir, ignore_errors=True)


# ─── Edge-TTS Adapter ─────────────────────────────────────────────────


class EdgeTtsAdapter(TtsAdapter):
    """Microsoft Edge TTS (cloud, no GPU needed). Fallback provider."""

    # Kokoro voice → edge-tts voice mapping (best-effort)
    _VOICE_MAP: dict[str, str] = {
        "zm_yunjian": "zh-CN-YunjianNeural",
        "zm_yunxi": "zh-CN-YunxiNeural",
        "zm_yunyang": "zh-CN-YunyangNeural",
        "zm_yunze": "zh-CN-YunzeNeural",
        "zf_xiaobei": "zh-CN-XiaoxiaoNeural",
        "zf_xiaoni": "zh-CN-XiaoyiNeural",
        "zf_xiaoyi": "zh-CN-XiaoyiNeural",
        "zf_yunxia": "zh-CN-XiaoxiaoNeural",
    }

    @property
    def name(self) -> str:
        return "edge-tts"

    async def synthesize(
        self, text: str, voice: str, lang_code: str, speed: float, audio_format: str,
    ) -> tuple[bytes, str]:
        try:
            import edge_tts
        except ImportError as exc:
            raise RuntimeError("edge-tts not available — pip install edge-tts") from exc

        # edge-tts always outputs mp3 regardless of requested format
        actual_format = "mp3"
        if audio_format != "mp3":
            log.info(
                "edge-tts only supports mp3 output, ignoring requested format '%s'",
                audio_format,
            )

        # Map Kokoro voice names to edge-tts voice names
        if voice in self._VOICE_MAP:
            mapped = self._VOICE_MAP[voice]
            log.info("Mapped Kokoro voice '%s' → edge-tts '%s'", voice, mapped)
            voice = mapped
        elif voice.startswith("zm_") or voice.startswith("zf_"):
            log.warning("Unknown Kokoro voice '%s', falling back to YunxiNeural", voice)
            voice = "zh-CN-YunxiNeural"

        rate = f"{int((speed - 1) * 100):+d}%"
        comm = edge_tts.Communicate(text=text, voice=voice, rate=rate)

        audio_chunks: list[bytes] = []
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                audio_chunks.append(chunk["data"])

        if not audio_chunks:
            raise RuntimeError("edge-tts returned no audio data")

        return b"".join(audio_chunks), actual_format


# ─── SAPI Adapter (Windows offline) ─────────────────────────────────


class SapiAdapter(TtsAdapter):
    """Windows SAPI5 TTS via pyttsx3 (offline, no model download)."""

    @property
    def name(self) -> str:
        return "sapi"

    async def synthesize(
        self, text: str, voice: str, lang_code: str, speed: float, audio_format: str,
    ) -> tuple[bytes, str]:
        try:
            import pyttsx3
        except ImportError as exc:
            raise RuntimeError("pyttsx3 not available — pip install pyttsx3") from exc

        tmp = Path(tempfile.mktemp(suffix=".wav"))
        try:
            def _speak():
                engine = pyttsx3.init()
                engine.setProperty("rate", int(engine.getProperty("rate") * speed))
                engine.save_to_file(text, str(tmp))
                engine.runAndWait()

            await asyncio.to_thread(_speak)
            if not tmp.exists():
                raise RuntimeError("pyttsx3 produced no audio")
            return tmp.read_bytes(), "wav"
        finally:
            tmp.unlink(missing_ok=True)


# ─── Piper Adapter (open-source offline, cross-platform ONNX) ────────


class PiperAdapter(TtsAdapter):
    """Piper neural TTS via piper-tts (offline, cross-platform).

    Models are downloaded by tts-install.sh / tts-install.ps1 into
    ${CAT_CAFE_HOME}/piper-models/<voice>.onnx + .onnx.json
    """

    DEFAULT_MODEL = "zh_CN-huayan-medium"
    MODELS_DIR = resolve_cat_cafe_home() / "piper-models"

    def __init__(self, model: str | None = None):
        self._model = model or self.DEFAULT_MODEL
        self._voice = None
        self._lock = asyncio.Lock()

    @property
    def name(self) -> str:
        return "piper"

    @property
    def model_name(self) -> str:
        return self._model

    def _model_paths(self) -> tuple[Path, Path]:
        # Allow either bare voice name or full filename
        base = self._model.removesuffix(".onnx")
        onnx_path = self.MODELS_DIR / f"{base}.onnx"
        config_path = self.MODELS_DIR / f"{base}.onnx.json"
        return onnx_path, config_path

    async def _ensure_loaded(self):
        if self._voice is not None:
            return
        async with self._lock:
            if self._voice is not None:
                return
            try:
                from piper import PiperVoice
            except ImportError as exc:
                raise RuntimeError(
                    "piper-tts not available — install with: pip install piper-tts"
                ) from exc

            onnx_path, config_path = self._model_paths()
            if not onnx_path.exists() or not config_path.exists():
                raise RuntimeError(
                    f"Piper model missing at {onnx_path}. Run tts-install to download."
                )
            self._voice = await asyncio.to_thread(PiperVoice.load, str(onnx_path))
            log.info("Loaded Piper voice: %s", self._model)

    async def synthesize(
        self, text: str, voice: str, lang_code: str, speed: float, audio_format: str,
    ) -> tuple[bytes, str]:
        del voice, lang_code, speed, audio_format  # Piper voice/speed driven by model
        await self._ensure_loaded()

        import io
        import wave

        def _synth() -> bytes:
            buf = io.BytesIO()
            with wave.open(buf, "wb") as wf:
                self._voice.synthesize(text, wf)
            return buf.getvalue()

        audio_bytes = await asyncio.to_thread(_synth)
        return audio_bytes, "wav"


# ─── Qwen3 Clone Adapter ────────────────────────────────────────────


class Qwen3CloneAdapter(TtsAdapter):
    """Qwen3-TTS Base + ref_audio zero-shot voice cloning (E-type unified scheme).

    Uses mlx-audio's generate_audio with ref_audio/ref_text/instruct params
    for voice cloning from reference audio. Supports mixed Chinese/English text.
    """

    DEFAULT_MODEL = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16"

    def __init__(self, model: str | None = None):
        self._model = model or self.DEFAULT_MODEL
        self._lock = threading.Lock()
        self._loaded_model = None
        self._mlx = None
        self._reference_cache_sha256 = None
        self._inference_executor = ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="cat-cafe-qwen-tts",
        )

    @property
    def name(self) -> str:
        return "qwen3-clone"

    @property
    def model_name(self) -> str:
        return self._model

    async def synthesize(
        self,
        text: str,
        voice: str,
        lang_code: str,
        speed: float,
        audio_format: str,
        *,
        ref_audio: str | None = None,
        ref_text: str | None = None,
        instruct: str | None = None,
        temperature: float = 0.3,
    ) -> tuple[bytes, str]:
        if isinstance(ref_audio, str):
            ref_audio = capture_reference(ref_audio)
        if ref_audio is not None and ref_audio.data is None:
            ref_text = None
            instruct = None

        return await asyncio.wrap_future(
            self._inference_executor.submit(
                self._synthesize_sync,
                text,
                lang_code,
                speed,
                audio_format,
                ref_audio,
                ref_text,
                instruct,
                temperature,
            )
        )

    def submit_inference(self, operation):
        """Queue one uninterrupted MLX operation on the model-owning thread."""
        return self._inference_executor.submit(operation)

    def _ensure_model(self):
        if self._mlx is None:
            import mlx.core as mx

            # This bounds unused allocator buffers, not active tensors or RSS.
            mx.set_cache_limit(512 * 1024**2)
            self._mlx = mx
        if self._loaded_model is None:
            from mlx_audio.tts.utils import load_model

            self._loaded_model = load_model(self._model)
        return self._loaded_model

    def _release_memory(self) -> None:
        """Run with the inference lock on its owner thread, including failures."""
        if self._mlx is None:
            return
        try:
            started = time.monotonic()
            active_before = self._mlx.get_active_memory()
            cache_before = self._mlx.get_cache_memory()
            error = sys.exc_info()[1]
            if error is not None:
                # Keep traceback locations and the original error, but release
                # completed vendor frames' tensor locals before queuing it.
                traceback.clear_frames(error.__traceback__)
            gc.collect()
            self._mlx.clear_cache()
            log.info(
                "Clone memory cleanup: active_before=%d cache_before=%d active_after=%d cache_after=%d "
                "process_peak=%d cleanup_ms=%.1f",
                active_before, cache_before, self._mlx.get_active_memory(), self._mlx.get_cache_memory(),
                self._mlx.get_peak_memory(), (time.monotonic() - started) * 1000,
            )
        except Exception:
            # Cleanup must not replace the original generation error, nor keep
            # the lock held. The request/stream's existing terminal is retained.
            log.warning("Clone memory cleanup failed", exc_info=True)

    @property
    def generation_profile(self) -> str | None:
        config = getattr(self._loaded_model, "config", None)
        if getattr(config, "model_type", None) == "breeze_tts":
            return "breeze-repetition-1.06-v1"
        return None

    def _generation_options(self) -> dict:
        # Preserve caller temperature and other models' defaults.
        return {"repetition_penalty": 1.06} if self.generation_profile else {}

    def _synthesize_sync(
        self,
        text: str,
        lang_code: str,
        speed: float,
        audio_format: str,
        ref_audio: CapturedReference | None,
        ref_text: str | None,
        instruct: str | None,
        temperature: float,
    ) -> tuple[bytes, str]:
        with reference_file(ref_audio) as reference_path:
            return self._synthesize_path_sync(text, lang_code, speed, audio_format, reference_path, ref_text, instruct, temperature,
                reference_sha256=ref_audio.sha256 if ref_audio is not None else None)

    def _prepare_reference_cache(self, model, sha256):
        # Qwen's reference-code key uses transcript/size/sum, which is not a
        # content identity. Keep same-reference reuse, invalidate on real change.
        if sha256 != self._reference_cache_sha256:
            cache = getattr(model, '_icl_cache', None)
            if isinstance(cache, dict):
                cache.clear()
            self._reference_cache_sha256 = sha256

    def _synthesize_path_sync(self, text, lang_code, speed, audio_format, ref_audio, ref_text, instruct, temperature, reference_sha256=None):
        from mlx_audio.tts.generate import generate_audio as tts_generate

        output_dir = Path(tempfile.mkdtemp(prefix="cat-cafe-tts-clone-"))
        try:
            with self._lock:
                try:
                    model = self._ensure_model()
                    self._prepare_reference_cache(model, reference_sha256)
                    kwargs: dict = {
                        "text": text,
                        "model": model,
                        "lang_code": lang_code,
                        "speed": speed,
                        "audio_format": audio_format,
                        "output_path": str(output_dir),
                        "temperature": temperature,
                        **self._generation_options(),
                    }
                    if ref_audio:
                        kwargs["ref_audio"] = ref_audio
                        if ref_text:
                            kwargs["ref_text"] = ref_text
                        if instruct:
                            kwargs["instruct"] = instruct
                    # Base models have no preset speakers. Without a reference,
                    # omit voice and use the model's reference-free generation.
                    tts_generate(**kwargs)

                    audio_files = list(output_dir.glob(f"*.{audio_format}"))
                    if not audio_files:
                        raise RuntimeError("No audio file generated")
                    return audio_files[0].read_bytes(), audio_format
                finally:
                    self._release_memory()
        finally:
            shutil.rmtree(output_dir, ignore_errors=True)

    def synthesize_stream(
        self,
        *,
        text: str,
        lang_code: str,
        ref_audio: str,
        ref_text: str,
        instruct: str | None = None,
        temperature: float = 0.3,
        streaming_interval: float = 0.5,
    ):
        captured = capture_reference(ref_audio) if isinstance(ref_audio, str) else ref_audio
        def generate_captured():
            with reference_file(captured) as path:
                if path is None:
                    raise RuntimeError('Reference audio unavailable')
                yield from self._synthesize_stream_path(text=text, lang_code=lang_code, ref_audio=path, ref_text=ref_text,
                    instruct=instruct, temperature=temperature, streaming_interval=streaming_interval,
                    reference_sha256=captured.sha256)
        return generate_captured()

    def _synthesize_stream_path(self, *, text, lang_code, ref_audio, ref_text, instruct, temperature, streaming_interval, reference_sha256=None):
        """Yield independently playable WAV chunks, then one complete cache WAV."""
        if not Path(ref_audio).exists():
            raise RuntimeError(f"Reference audio not found: {ref_audio}")

        self._lock.acquire()
        generation = None
        result = None
        model = None
        try:
            model = self._ensure_model()
            self._prepare_reference_cache(model, reference_sha256)
            pcm_chunks: list[bytes] = []
            sample_rate: int | None = None
            generation = model.generate(
                text=text,
                lang_code=lang_code,
                ref_audio=ref_audio,
                ref_text=ref_text,
                instruct=instruct,
                temperature=temperature,
                stream=True,
                streaming_interval=streaming_interval,
                verbose=False,
                **self._generation_options(),
            )
            for result in generation:
                sample_rate = int(result.sample_rate)
                pcm = _pcm16_bytes(result.audio)
                pcm_chunks.append(pcm)
                yield {
                    "type": "chunk",
                    "audio_base64": base64.b64encode(_wav_bytes(pcm, sample_rate)).decode("ascii"),
                    "duration_sec": len(pcm) / 2 / sample_rate,
                    "final": bool(getattr(result, "is_final_chunk", False)),
                }

            if not pcm_chunks or sample_rate is None:
                raise RuntimeError("Qwen clone stream produced no audio")
            complete_pcm = b"".join(pcm_chunks)
            yield {
                "type": "final",
                "audio_base64": base64.b64encode(_wav_bytes(complete_pcm, sample_rate)).decode("ascii"),
                "duration_sec": len(complete_pcm) / 2 / sample_rate,
            }
        finally:
            try:
                # Closing the inner generator releases its frame/KV arrays.
                # The last yielded result also owns audio until dereferenced.
                try:
                    if generation is not None:
                        generation.close()
                except Exception:
                    log.warning("Clone inner stream close failed", exc_info=True)
                generation = result = None
                try:
                    tokenizer = getattr(model, "audio_tokenizer", None) or getattr(model, "speech_tokenizer", None)
                    reset = getattr(getattr(tokenizer, "decoder", None), "reset_streaming_state", None)
                    if callable(reset):
                        reset()
                except Exception:
                    log.warning("Clone stream state reset failed", exc_info=True)
                self._release_memory()
            finally:
                self._lock.release()

    def warmup(self) -> None:
        self._inference_executor.submit(
            self._synthesize_sync,
            "你好",
            "zh",
            1.0,
            "wav",
            None,
            None,
            None,
            0.3,
        ).result()


# ─── Factory ──────────────────────────────────────────────────────────


def create_adapter(provider: str, model: str) -> TtsAdapter:
    """Create TTS adapter based on provider name."""
    if provider == "qwen3-clone":
        # When TTS_MODEL equals the provider name (e.g. TTS_MODEL=qwen3-clone),
        # it's not a valid HF model path — fall through to adapter's built-in default.
        effective = model if (model and model != provider and model != Qwen3CloneAdapter.DEFAULT_MODEL) else None
        return Qwen3CloneAdapter(model=effective)
    if provider == "mlx-audio":
        return MlxAudioAdapter(model=model)
    if provider == "edge-tts":
        return EdgeTtsAdapter()
    if provider == "sapi":
        return SapiAdapter()
    if provider == "piper":
        return PiperAdapter(model=model if (model and model != provider) else None)
    raise ValueError(
        f"Unknown TTS provider: '{provider}'. Supported: qwen3-clone, mlx-audio, edge-tts, sapi, piper"
    )


# ─── Global state ─────────────────────────────────────────────────────

adapter: TtsAdapter | None = None
adapter_ready: bool = False


# ─── API endpoints ────────────────────────────────────────────────────


class SpeechRequest(BaseModel):
    input: str = Field(..., min_length=1, max_length=MAX_INPUT_CHARS)
    voice: str = Field(default="zm_yunjian")
    model: str | None = Field(default=None)
    response_format: str = Field(default="wav")
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    lang_code: str = Field(default="z")
    # F066: Qwen3-TTS Base clone mode fields
    ref_audio: str | None = Field(default=None)
    ref_audio_base64: str | None = Field(default=None, max_length=((MAX_REFERENCE_BYTES + 2) // 3) * 4)
    ref_audio_sha256: str | None = Field(default=None, min_length=64, max_length=64)
    ref_text: str | None = Field(default=None)
    instruct: str | None = Field(default=None)
    temperature: float = Field(default=0.3, ge=0.0, le=2.0)
    generation_profile: str | None = Field(default=None, max_length=64)


def verify_requested_model(model: str | None, generation_profile: str | None = None) -> None:
    """Fence a configured client snapshot if the listener changes before its request."""
    if generation_profile is not None and generation_profile != (getattr(adapter, "generation_profile", None) or ""):
        raise HTTPException(409, detail="TTS generation profile changed; prepare synthesis again")
    aliases = {
        "qwen3-clone": Qwen3CloneAdapter.DEFAULT_MODEL,
        "mlx-audio": "mlx-community/Kokoro-82M-bf16",
        "piper": "zh_CN-huayan-medium",
    }
    # Generic OpenAI tokens (e.g. tts-1) still mean the configured service.
    if not model:
        return
    concrete_model = ("/" in model or model in aliases or model in {"edge-tts", "sapi"}
                      or model.startswith(("zh_CN-", "en_US-", "en_GB-")))
    if not concrete_model:
        return
    actual = adapter.model_name if adapter.model_name != "none" else adapter.name
    if aliases.get(model, model) != actual:
        raise HTTPException(409, detail="Requested TTS model differs from the running service; restart the selected service")


@app.post("/v1/audio/speech")
async def synthesize_endpoint(req: SpeechRequest):
    """OpenAI-compatible TTS endpoint."""
    if not adapter_ready or adapter is None:
        raise HTTPException(503, detail="TTS adapter not ready yet")
    verify_requested_model(req.model, req.generation_profile)

    try:
        reference = capture_reference(req.ref_audio, req.ref_audio_base64, req.ref_audio_sha256) if isinstance(adapter, Qwen3CloneAdapter) else None
        if reference is not None and (not req.ref_text or not req.ref_text.strip()):
            reference = CapturedReference(None)
        # Build base kwargs for all adapters
        synth_kwargs: dict = {
            "text": req.input,
            "voice": req.voice,
            "lang_code": req.lang_code,
            "speed": req.speed,
            "audio_format": req.response_format,
        }
        # Pass clone params if adapter supports them (Qwen3CloneAdapter)
        if isinstance(adapter, Qwen3CloneAdapter):
            synth_kwargs["ref_audio"] = reference
            synth_kwargs["ref_text"] = req.ref_text
            synth_kwargs["instruct"] = req.instruct
            synth_kwargs["temperature"] = req.temperature

        audio_bytes, actual_format = await adapter.synthesize(**synth_kwargs)

        log.info(
            "Synthesized %d chars → %d bytes (provider=%s, voice=%s, format=%s)",
            len(req.input),
            len(audio_bytes),
            adapter.name,
            req.voice,
            actual_format,
        )

        return Response(
            content=audio_bytes,
            media_type=f"audio/{actual_format}",
            headers={
                "Content-Disposition": f'inline; filename="speech.{actual_format}"',
                "X-Audio-Format": actual_format,
                **({"X-TTS-Generation-Profile": adapter.generation_profile} if getattr(adapter, "generation_profile", None) else {}),
                **(reference.headers() if reference is not None else {}),
            },
        )
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Synthesis failed for %d-char input", len(req.input))
        raise HTTPException(500, detail=f"Synthesis error: {exc}") from exc


@app.post("/v1/audio/speech/stream")
async def synthesize_stream_endpoint(request: Request, req: SpeechRequest):
    """Stream native Qwen clone chunks as NDJSON and finish with one cacheable WAV."""
    if not adapter_ready or adapter is None:
        raise HTTPException(503, detail="TTS adapter not ready yet")
    verify_requested_model(req.model, req.generation_profile)
    if not isinstance(adapter, Qwen3CloneAdapter):
        raise HTTPException(409, detail="Native clone streaming requires the qwen3-clone provider")
    if not req.ref_audio or not req.ref_text or not req.ref_text.strip():
        raise HTTPException(400, detail="ref_audio and ref_text are required for clone streaming")

    reference = capture_reference(req.ref_audio, req.ref_audio_base64, req.ref_audio_sha256)
    if reference is None or reference.data is None:
        raise HTTPException(422, detail='Reference audio unavailable')

    stream = adapter.synthesize_stream(
        text=req.input,
        lang_code=req.lang_code,
        ref_audio=reference,
        ref_text=req.ref_text,
        instruct=req.instruct,
        temperature=req.temperature,
    )

    stream_finished = object()
    event_queue: asyncio.Queue[object] = asyncio.Queue()
    stop_requested = threading.Event()
    event_loop = asyncio.get_running_loop()

    def produce_events():
        try:
            for event in stream:
                if stop_requested.is_set():
                    break
                event_loop.call_soon_threadsafe(event_queue.put_nowait, event)
        except Exception as exc:
            event_loop.call_soon_threadsafe(event_queue.put_nowait, exc)
        finally:
            stream.close()
            event_loop.call_soon_threadsafe(event_queue.put_nowait, stream_finished)

    async def generate_events():
        producer = asyncio.wrap_future(adapter.submit_inference(produce_events))
        try:
            while not await request.is_disconnected():
                event = await event_queue.get()
                if event is stream_finished:
                    break
                if isinstance(event, Exception):
                    raise event
                if await request.is_disconnected():
                    break
                yield json.dumps(event, separators=(",", ":")) + "\n"
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.exception("Native clone stream failed for %d-char input", len(req.input))
            if not await request.is_disconnected():
                yield json.dumps({"type": "error", "error": str(exc)}, separators=(",", ":")) + "\n"
        finally:
            stop_requested.set()
            try:
                await asyncio.shield(producer)
            except BaseException:
                pass

    return StreamingResponse(
        generate_events(), media_type="application/x-ndjson",
        headers={**({"X-TTS-Generation-Profile": adapter.generation_profile} if adapter.generation_profile else {}), **reference.headers()},
    )


@app.get("/health")
async def health():
    return {
        "status": "ok" if adapter_ready else "loading",
        "model": adapter.model_name if adapter else "none",
        "backend": adapter.name if adapter else "none",
        **({"generation_profile": adapter.generation_profile} if getattr(adapter, "generation_profile", None) else {}),
        "capabilities": TTS_API_CAPABILITIES + (["reference-audio-content-v1"] if isinstance(adapter, Qwen3CloneAdapter) and os.name == 'posix' else []),
    }


@app.get("/health/deep")
async def health_deep():
    """Deep health check: verifies actual synthesis capability.

    Used by lifecycle reconciler to detect zombie processes -- HTTP alive
    but inference pipeline broken (e.g. Broken pipe after prolonged uptime).
    Synthesizes a short phrase to verify the full pipeline works.
    """
    if not adapter_ready or not adapter:
        raise HTTPException(503, detail="adapter not ready")
    # Reference-capable MLX models already warm up with this Chinese phrase.
    # A lone English 'a' can make Breeze continue generating until the probe times out.
    clone_adapter = isinstance(adapter, Qwen3CloneAdapter)
    try:
        _audio_bytes, _fmt = await asyncio.wait_for(
            adapter.synthesize(
                text="你好" if clone_adapter else "a",
                voice="zm_yunjian",
                lang_code="zh" if clone_adapter else "en",
                speed=1.0,
                audio_format="wav",
            ),
            timeout=15.0,
        )
        return {
            "status": "ok",
            "probe": "synthesis",
            "model": adapter.model_name,
            "backend": adapter.name,
            **({"generation_profile": adapter.generation_profile} if getattr(adapter, "generation_profile", None) else {}),
            "capabilities": TTS_API_CAPABILITIES + (["reference-audio-content-v1"] if isinstance(adapter, Qwen3CloneAdapter) and os.name == 'posix' else []),
        }
    except Exception as exc:
        log.warning("Deep health probe failed: %s", exc)
        raise HTTPException(503, detail=f"synthesis probe failed: {exc}") from exc


# ─── Main ─────────────────────────────────────────────────────────────


def main():
    global adapter, adapter_ready

    parser = argparse.ArgumentParser(description="Clowder AI TTS Server")
    parser.add_argument(
        "--model",
        required=True,
        help="Model repo ID — required, no fallback default. Backend always passes via env.",
    )
    parser.add_argument(
        "--port", type=int, default=9879, help="Server port (default: 9879)"
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    def handle_sigterm(signum, frame):
        log.info("Received SIGTERM, shutting down...")
        sys.exit(0)

    signal.signal(signal.SIGTERM, handle_sigterm)

    provider = os.environ.get("TTS_PROVIDER", "qwen3-clone").strip().lower()

    if provider in {"qwen3-clone", "mlx-audio"}:
        require_mlx_audio_runtime()

    log.info("=== Clowder AI TTS Server ===")
    log.info("Provider: %s | Port: %d", provider, args.port)

    try:
        adapter = create_adapter(provider, model=args.model)
        log.info("Adapter: %s (model: %s)", adapter.name, adapter.model_name)
        log.info("Running warmup...")
        adapter.warmup()
        adapter_ready = True
    except Exception:
        log.exception("Failed to initialize TTS adapter '%s'", provider)
        sys.exit(1)

    log.info("Ready! API: http://localhost:%d/v1/audio/speech", args.port)
    uvicorn.run(app, host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
