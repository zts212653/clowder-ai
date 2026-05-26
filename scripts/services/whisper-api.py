#!/usr/bin/env python3
"""
Whisper ASR server for Cat Cafe voice input.
Backends: mlx-whisper (macOS GPU) -> faster-whisper (CPU/CUDA).
OpenAI-compatible endpoint: POST /v1/audio/transcriptions
"""

from __future__ import annotations

import argparse
import logging
import signal
import sys
import tempfile
import threading
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

_transcribe_lock = threading.Lock()

# ─── Backend state ────────────────────────────────────────────────
_fw_model = None  # faster-whisper WhisperModel instance


def _resolve_fw_model_size(name: str) -> str:
    """Convert MLX model name to faster-whisper model size identifier."""
    if "mlx-community/whisper-" in name:
        return name.split("whisper-", 1)[1].removesuffix("-mlx")
    return name


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
        with _transcribe_lock:
            if _backend == "mlx-whisper":
                text = _transcribe_mlx(tmp_path, lang, prompt)
            else:
                text = _transcribe_fw(tmp_path, lang, prompt)
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
    log.info("=== Cat Cafe Whisper Server ===")
    log.info("Model: %s | Port: %d", model_path, args.port)

    if not _try_mlx():
        if not _try_faster_whisper():
            log.error("All backends failed (install mlx-whisper or faster-whisper)")
            sys.exit(1)

    log.info("API: http://localhost:%d/v1/audio/transcriptions", args.port)
    uvicorn.run(app, host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
