#!/usr/bin/env python3
"""
TTS server for Cat Cafe voice output.
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
import logging
import os
import shutil
import signal
import sys
import tempfile
from abc import ABC, abstractmethod
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

MAX_INPUT_CHARS = 5000

log = logging.getLogger("tts-api")

app = FastAPI(title="Cat Cafe TTS Server")

ALLOWED_ORIGINS = [
    "http://localhost:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:3001",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
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
        except Exception:
            pass  # Warmup may fail, model is still loaded
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


# ─── Qwen3 Clone Adapter ────────────────────────────────────────────


class Qwen3CloneAdapter(TtsAdapter):
    """Qwen3-TTS Base + ref_audio zero-shot voice cloning (E-type unified scheme).

    Uses mlx-audio's generate_audio with ref_audio/ref_text/instruct params
    for voice cloning from reference audio. Supports mixed Chinese/English text.
    """

    DEFAULT_MODEL = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16"

    def __init__(self, model: str | None = None):
        self._model = model or self.DEFAULT_MODEL
        self._lock = asyncio.Lock()

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
        try:
            from mlx_audio.tts.generate import generate_audio as tts_generate
        except ImportError as exc:
            raise RuntimeError(
                "mlx_audio.tts not available — pip install mlx-audio 'misaki[zh]'"
            ) from exc

        if ref_audio and not Path(ref_audio).exists():
            raise RuntimeError(f"Reference audio not found: {ref_audio}")

        output_dir = Path(tempfile.mkdtemp(prefix="cat-cafe-tts-clone-"))
        try:
            kwargs: dict = {
                "text": text,
                "model": self._model,
                "lang_code": lang_code,
                "speed": speed,
                "audio_format": audio_format,
                "output_path": str(output_dir),
                "temperature": temperature,
            }
            # Clone mode: ref_audio + ref_text (voice param not used)
            if ref_audio:
                kwargs["ref_audio"] = ref_audio
                if ref_text:
                    kwargs["ref_text"] = ref_text
                if instruct:
                    kwargs["instruct"] = instruct
            else:
                # Fallback: use voice param like Kokoro adapter
                kwargs["voice"] = voice

            async with self._lock:
                await asyncio.to_thread(tts_generate, **kwargs)

            audio_files = list(output_dir.glob(f"*.{audio_format}"))
            if not audio_files:
                raise RuntimeError("No audio file generated")

            return audio_files[0].read_bytes(), audio_format
        finally:
            shutil.rmtree(output_dir, ignore_errors=True)

    def warmup(self) -> None:
        from mlx_audio.tts.generate import generate_audio as tts_generate

        warmup_dir = Path(tempfile.mkdtemp(prefix="cat-cafe-tts-clone-warmup-"))
        try:
            tts_generate(
                text="你好",
                model=self._model,
                voice="zm_yunjian",
                lang_code="z",
                output_path=str(warmup_dir),
            )
        except Exception:
            pass  # Warmup may fail, model is still loaded
        finally:
            shutil.rmtree(warmup_dir, ignore_errors=True)


# ─── Factory ──────────────────────────────────────────────────────────


def create_adapter(provider: str, model: str) -> TtsAdapter:
    """Create TTS adapter based on provider name."""
    if provider == "qwen3-clone":
        return Qwen3CloneAdapter(model=model if model != Qwen3CloneAdapter.DEFAULT_MODEL else None)
    if provider == "mlx-audio":
        return MlxAudioAdapter(model=model)
    if provider == "edge-tts":
        return EdgeTtsAdapter()
    raise ValueError(
        f"Unknown TTS provider: '{provider}'. Supported: qwen3-clone, mlx-audio, edge-tts"
    )


# ─── Global state ─────────────────────────────────────────────────────

adapter: TtsAdapter | None = None
adapter_ready: bool = False


# ─── API endpoints ────────────────────────────────────────────────────


class SpeechRequest(BaseModel):
    input: str = Field(..., min_length=1, max_length=MAX_INPUT_CHARS)
    voice: str = Field(default="zm_yunjian")
    model: str = Field(default="mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16")
    response_format: str = Field(default="wav")
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    lang_code: str = Field(default="z")
    # F066: Qwen3-TTS Base clone mode fields
    ref_audio: str | None = Field(default=None)
    ref_text: str | None = Field(default=None)
    instruct: str | None = Field(default=None)
    temperature: float = Field(default=0.3, ge=0.0, le=2.0)


@app.post("/v1/audio/speech")
async def synthesize_endpoint(req: SpeechRequest):
    """OpenAI-compatible TTS endpoint."""
    if not adapter_ready or adapter is None:
        raise HTTPException(503, detail="TTS adapter not ready yet")

    try:
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
            synth_kwargs["ref_audio"] = req.ref_audio
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
            },
        )
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Synthesis failed for %d-char input", len(req.input))
        raise HTTPException(500, detail=f"Synthesis error: {exc}") from exc


@app.get("/health")
async def health():
    return {
        "status": "ok" if adapter_ready else "loading",
        "model": adapter.model_name if adapter else "none",
        "backend": adapter.name if adapter else "none",
    }


# ─── Main ─────────────────────────────────────────────────────────────


def main():
    global adapter, adapter_ready

    parser = argparse.ArgumentParser(description="Cat Cafe TTS Server")
    parser.add_argument(
        "--model",
        default="mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16",
        help="HuggingFace model repo (default: mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16)",
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

    log.info("=== Cat Cafe TTS Server ===")
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
