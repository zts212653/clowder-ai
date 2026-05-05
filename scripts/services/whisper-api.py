#!/usr/bin/env python3
"""
Whisper ASR server for Cat Cafe voice input (MLX backend, Apple Silicon native).
OpenAI-compatible endpoint: POST /v1/audio/transcriptions

Usage:
  source ~/.cat-cafe/whisper-venv/bin/activate
  python scripts/whisper-api.py                                          # default: large-v3-turbo
  python scripts/whisper-api.py --model mlx-community/whisper-small      # smaller model
  python scripts/whisper-api.py --port 9876                              # custom port

Requires: pip install mlx-whisper fastapi uvicorn
"""

import argparse
import asyncio
import logging
import signal
import sys
import tempfile
from pathlib import Path

import mlx_whisper
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

MAX_FILE_BYTES = 25 * 1024 * 1024  # 25 MB (matches OpenAI limit)

log = logging.getLogger("whisper-api")

app = FastAPI(title="Cat Cafe Whisper Server")

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

model_path: str = ""
model_loaded: bool = False

# Serialize GPU access — mlx doesn't handle concurrent transcriptions well
_transcribe_lock = asyncio.Lock()


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

    try:
        async with _transcribe_lock:
            result = await asyncio.to_thread(
                mlx_whisper.transcribe,
                tmp_path,
                path_or_hf_repo=model_path,
                language=language if language else None,
                initial_prompt=initial_prompt if initial_prompt else None,
                no_speech_threshold=0.6,
            )
        text = result.get("text", "").strip()
        log.info("Transcribed %d bytes → %d chars (lang=%s)", len(content), len(text), language)
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
        "backend": "mlx-whisper",
    }


def main():
    global model_path, model_loaded

    parser = argparse.ArgumentParser(description="Cat Cafe Whisper Server (MLX)")
    parser.add_argument(
        "--model",
        default="mlx-community/whisper-large-v3-turbo",
        help="HuggingFace model repo (default: mlx-community/whisper-large-v3-turbo)",
    )
    parser.add_argument("--port", type=int, default=9876, help="Server port (default: 9876)")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

    def handle_sigterm(signum, frame):
        log.info("Received SIGTERM, shutting down...")
        sys.exit(0)
    signal.signal(signal.SIGTERM, handle_sigterm)

    model_path = args.model
    log.info("=== Cat Cafe Whisper Server (MLX) ===")
    log.info("Model: %s | Port: %d", model_path, args.port)
    log.info("Loading model (first run downloads from HuggingFace)...")

    try:
        # Warmup: run a tiny transcription to force model download + compile
        warmup_file = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        warmup_file.write(b"\x00" * 1000)
        warmup_file.close()
        try:
            mlx_whisper.transcribe(warmup_file.name, path_or_hf_repo=model_path)
        except Exception:
            pass  # Warmup may fail on dummy data, that's ok — model is loaded
        finally:
            Path(warmup_file.name).unlink(missing_ok=True)
        model_loaded = True
    except Exception:
        log.exception("Failed to load model '%s'", model_path)
        sys.exit(1)

    log.info("Model loaded! API: http://localhost:%d/v1/audio/transcriptions", args.port)
    uvicorn.run(app, host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
