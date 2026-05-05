#!/usr/bin/env python3
"""
Qwen3-ASR server for Cat Cafe voice input (MLX backend, Apple Silicon native).
Drop-in replacement for whisper-api.py with same OpenAI-compatible endpoint.

Endpoint: POST /v1/audio/transcriptions
Returns: {"text": "transcribed text"}

Usage:
  source ~/.cat-cafe/asr-venv/bin/activate
  python scripts/qwen3-asr-api.py                                              # default: 8bit
  python scripts/qwen3-asr-api.py --model mlx-community/Qwen3-ASR-1.7B-4bit   # smaller
  python scripts/qwen3-asr-api.py --port 9876                                  # custom port

Requires: pip install mlx-audio fastapi uvicorn python-multipart
"""

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

MAX_FILE_BYTES = 25 * 1024 * 1024  # 25 MB

log = logging.getLogger("qwen3-asr")

app = FastAPI(title="Cat Cafe Qwen3-ASR Server")

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

# Module-level state
_model = None
_model_path: str = ""
_model_loaded: bool = False
_transcribe_lock = asyncio.Lock()


def _convert_to_wav(src_path: str) -> str:
    """Convert any audio format to 16kHz mono WAV via ffmpeg (Qwen3-ASR requires WAV)."""
    fd, wav_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
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


def _do_transcribe(audio_path: str, language: str, initial_prompt: str = "") -> str:
    """Synchronous transcription using mlx-audio (runs in thread pool)."""
    from mlx_audio.stt.generate import generate_transcription

    # Qwen3-ASR can't decode webm/opus directly — convert to WAV first
    wav_path = audio_path
    if not audio_path.endswith(".wav"):
        wav_path = _convert_to_wav(audio_path)

    # mlx-audio writes {output_path}.txt — force it into system temp dir, never CWD
    fd, output_file = tempfile.mkstemp(suffix="_asr")
    os.close(fd)
    output_path = output_file
    try:
        kwargs = dict(model=_model, audio=wav_path, output_path=output_path, verbose=False)
        if initial_prompt:
            kwargs["context"] = initial_prompt
        result = generate_transcription(**kwargs)
        return result.text.strip() if hasattr(result, "text") else str(result).strip()
    finally:
        if wav_path != audio_path:
            Path(wav_path).unlink(missing_ok=True)
        Path(output_path).unlink(missing_ok=True)
        Path(f"{output_path}.txt").unlink(missing_ok=True)


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    language: str = Form("zh"),
    initial_prompt: str = Form(""),
):
    """OpenAI-compatible transcription endpoint (drop-in for whisper-api.py)."""
    if not _model_loaded:
        raise HTTPException(503, detail="Model not loaded yet")

    content = await file.read()
    if len(content) > MAX_FILE_BYTES:
        raise HTTPException(
            413, detail=f"File too large ({len(content)} bytes, max {MAX_FILE_BYTES})"
        )
    if len(content) == 0:
        raise HTTPException(400, detail="Empty audio file")

    suffix = Path(file.filename or "audio.webm").suffix
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(content)
        tmp_path = tmp.name

    try:
        async with _transcribe_lock:
            text = await asyncio.to_thread(_do_transcribe, tmp_path, language, initial_prompt)
        log.info(
            "Transcribed %d bytes → %d chars (lang=%s)", len(content), len(text), language
        )
        return {"text": text}
    except Exception as exc:
        log.exception("Transcription failed for %d-byte upload", len(content))
        raise HTTPException(500, detail=f"Transcription error: {exc}") from exc
    finally:
        Path(tmp_path).unlink(missing_ok=True)


@app.get("/health")
async def health():
    return {
        "status": "ok" if _model_loaded else "loading",
        "model": _model_path or "none",
        "backend": "mlx-audio (Qwen3-ASR)",
    }


def main():
    global _model, _model_path, _model_loaded

    parser = argparse.ArgumentParser(description="Cat Cafe Qwen3-ASR Server (MLX)")
    parser.add_argument(
        "--model",
        default="mlx-community/Qwen3-ASR-1.7B-8bit",
        help="HuggingFace model repo (default: mlx-community/Qwen3-ASR-1.7B-8bit)",
    )
    parser.add_argument("--port", type=int, default=9876, help="Server port (default: 9876)")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s"
    )

    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    _model_path = args.model
    log.info("=== Cat Cafe Qwen3-ASR Server (MLX) ===")
    log.info("Model: %s | Port: %d", _model_path, args.port)
    log.info("Loading model (first run downloads from HuggingFace)...")

    try:
        from mlx_audio.stt.utils import load_model

        _model = load_model(_model_path)
        _model_loaded = True
    except Exception:
        log.exception("Failed to load model '%s'", _model_path)
        sys.exit(1)

    log.info("Model loaded! API: http://localhost:%d/v1/audio/transcriptions", args.port)
    uvicorn.run(app, host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
