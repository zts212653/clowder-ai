#!/usr/bin/env python3
"""
Unified ASR server for Cat Cafe voice input (#863).
Backends (selected by model name):
  - mlx-audio    (Qwen3-ASR models, Apple Silicon)
  - mlx-whisper  (Whisper models, Apple Silicon)
  - faster-whisper (Whisper models, CPU/CUDA fallback)

OpenAI-compatible endpoint: POST /v1/audio/transcriptions
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
import subprocess
import sys
import tempfile
from pathlib import Path

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

MAX_FILE_BYTES = 25 * 1024 * 1024  # 25 MB (matches OpenAI limit)

log = logging.getLogger("whisper-api")

app = FastAPI(title="Cat Cafe Whisper Server")


@app.on_event("startup")
async def _emit_ready_marker():
    """Push-based ready signal — see embed-api.py + service-logs.ts."""
    print("__CATCAFE_SIDECAR_READY__", flush=True)


app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

model_path: str = ""
model_loaded: bool = False
_backend: str = "unknown"

_transcribe_lock = asyncio.Lock()

# ─── Backend state ────────────────────────────────────────────────
_fw_model = None   # faster-whisper WhisperModel instance
_qwen_model = None  # mlx-audio loaded Qwen3-ASR model


def _is_qwen3_model(name: str) -> bool:
    """True when the model name indicates a Qwen3-ASR variant."""
    return "Qwen3-ASR" in name


def _resolve_fw_model_size(name: str) -> str:
    """Convert MLX model name to faster-whisper model size identifier."""
    if "mlx-community/whisper-" in name:
        return name.split("whisper-", 1)[1].removesuffix("-mlx")
    return name


# ─── Qwen3-ASR (mlx-audio) ───────────────────────────────────────

def _convert_to_wav(src_path: str) -> str:
    """Convert any audio format to 16kHz mono WAV via ffmpeg (Qwen3-ASR requires WAV)."""
    fd, wav_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        result = subprocess.run(
            ["ffmpeg", "-y", "-i", src_path, "-ar", "16000", "-ac", "1", wav_path],
            capture_output=True,
            timeout=30,
        )
        if result.returncode != 0:
            stderr = result.stderr.decode("utf-8", errors="replace")[-500:]
            raise RuntimeError(f"ffmpeg conversion failed (exit {result.returncode}): {stderr}")
        if not Path(wav_path).exists() or Path(wav_path).stat().st_size == 0:
            raise RuntimeError(f"ffmpeg produced empty or missing output: {wav_path}")
        return wav_path
    except BaseException:
        Path(wav_path).unlink(missing_ok=True)
        raise


def _transcribe_qwen3(tmp_path: str, language: str | None, initial_prompt: str | None) -> str:
    from mlx_audio.stt.generate import generate_transcription

    wav_path = tmp_path
    if not tmp_path.endswith(".wav"):
        wav_path = _convert_to_wav(tmp_path)

    fd, output_file = tempfile.mkstemp(suffix="_asr")
    os.close(fd)
    try:
        kwargs = dict(model=_qwen_model, audio=wav_path, output_path=output_file, verbose=False)
        if initial_prompt:
            kwargs["context"] = initial_prompt
        result = generate_transcription(**kwargs)
        return result.text.strip() if hasattr(result, "text") else str(result).strip()
    finally:
        if wav_path != tmp_path:
            Path(wav_path).unlink(missing_ok=True)
        Path(output_file).unlink(missing_ok=True)
        Path(f"{output_file}.txt").unlink(missing_ok=True)


# ─── Whisper (mlx-whisper / faster-whisper) ───────────────────────

def _transcribe_mlx(tmp_path: str, language: str | None, initial_prompt: str | None) -> str:
    import mlx_whisper
    result = mlx_whisper.transcribe(
        tmp_path,
        path_or_hf_repo=model_path,
        language=language,
        initial_prompt=initial_prompt,
        no_speech_threshold=0.6,
    )
    return result.get("text", "").strip()


def _transcribe_fw(tmp_path: str, language: str | None, initial_prompt: str | None) -> str:
    segments, _ = _fw_model.transcribe(
        tmp_path,
        language=language,
        initial_prompt=initial_prompt,
        no_speech_threshold=0.6,
    )
    return " ".join(seg.text for seg in segments).strip()


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    language: str = Form("zh"),
    initial_prompt: str = Form(""),
):
    """OpenAI-compatible transcription endpoint."""
    if not model_loaded:
        raise HTTPException(503, detail="Model not loaded yet")

    content = await file.read()
    if len(content) > MAX_FILE_BYTES:
        raise HTTPException(413, detail=f"File too large ({len(content)} bytes, max {MAX_FILE_BYTES})")
    if len(content) == 0:
        raise HTTPException(400, detail="Empty audio file")

    suffix = Path(file.filename or "audio.webm").suffix
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(content)
        tmp_path = tmp.name

    lang = language if language else None
    prompt = initial_prompt if initial_prompt else None

    try:
        async with _transcribe_lock:
            if _backend == "mlx-audio":
                text = await asyncio.to_thread(_transcribe_qwen3, tmp_path, lang, prompt)
            elif _backend == "mlx-whisper":
                text = await asyncio.to_thread(_transcribe_mlx, tmp_path, lang, prompt)
            else:
                text = await asyncio.to_thread(_transcribe_fw, tmp_path, lang, prompt)
        log.info("Transcribed %d bytes -> %d chars (lang=%s)", len(content), len(text), language)
        return {"text": text}
    except Exception as exc:
        log.exception("Transcription failed for %d-byte upload", len(content))
        raise HTTPException(500, detail=f"Transcription error: {exc}") from exc
    finally:
        Path(tmp_path).unlink(missing_ok=True)


@app.get("/health")
async def health():
    return {
        "status": "ok" if model_loaded else "loading",
        "model": model_path or "none",
        "backend": _backend,
    }


# ─── Startup ─────────────────────────────────────────────────────

def _try_qwen3() -> bool:
    """Load Qwen3-ASR model via mlx-audio. Only called when model is Qwen3-ASR."""
    global model_loaded, _backend, _qwen_model
    try:
        from mlx_audio.stt.utils import load_model
    except ImportError:
        log.warning("mlx-audio not installed")
        return False
    try:
        log.info("Loading Qwen3-ASR model via mlx-audio: %s", model_path)
        _qwen_model = load_model(model_path)
        _backend = "mlx-audio"
        model_loaded = True
        log.info("Model loaded via mlx-audio (Qwen3-ASR, Apple Silicon)")
        return True
    except Exception:
        log.exception("mlx-audio load failed for %s", model_path)
        return False


def _try_mlx() -> bool:
    global model_loaded, _backend
    try:
        import mlx_whisper
    except ImportError:
        return False
    try:
        warmup_file = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        warmup_file.write(b"\x00" * 1000)
        warmup_file.close()
        try:
            mlx_whisper.transcribe(warmup_file.name, path_or_hf_repo=model_path)
        except Exception:
            pass
        finally:
            Path(warmup_file.name).unlink(missing_ok=True)
        _backend = "mlx-whisper"
        model_loaded = True
        log.info("Model loaded via mlx-whisper (Apple Silicon GPU)")
        return True
    except Exception as e:
        log.warning("MLX whisper failed (%s), trying faster-whisper", e)
        return False


def _try_faster_whisper() -> bool:
    global model_loaded, _backend, _fw_model, model_path
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        log.warning("faster-whisper not installed")
        return False
    try:
        fw_name = _resolve_fw_model_size(model_path)
        device = "cpu"
        compute_type = "int8"
        try:
            import torch
            if torch.cuda.is_available():
                device = "cuda"
                compute_type = "float16"
        except ImportError:
            pass
        log.info("Loading faster-whisper: model=%s device=%s", fw_name, device)
        _fw_model = WhisperModel(fw_name, device=device, compute_type=compute_type)
        model_path = fw_name
        _backend = "faster-whisper"
        model_loaded = True
        log.info("Model loaded via faster-whisper (device: %s)", device)
        return True
    except Exception:
        log.exception("faster-whisper load failed")
        return False


def main():
    global model_path

    parser = argparse.ArgumentParser(description="Cat Cafe Whisper Server")
    parser.add_argument(
        "--model",
        required=True,
        help="Model repo ID — required, no fallback default. Backend always passes via env.",
    )
    parser.add_argument("--port", type=int, default=9876)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

    def handle_sigterm(signum, frame):
        log.info("Received SIGTERM, shutting down...")
        sys.exit(0)
    signal.signal(signal.SIGTERM, handle_sigterm)

    model_path = args.model
    log.info("=== Cat Cafe ASR Server ===")
    log.info("Model: %s | Port: %d", model_path, args.port)

    if _is_qwen3_model(model_path):
        if not _try_qwen3():
            log.error("Qwen3-ASR backend failed (install mlx-audio)")
            sys.exit(1)
    elif not _try_mlx():
        if not _try_faster_whisper():
            log.error("All backends failed (install mlx-whisper or faster-whisper)")
            sys.exit(1)

    log.info("API: http://localhost:%d/v1/audio/transcriptions", args.port)
    uvicorn.run(app, host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
