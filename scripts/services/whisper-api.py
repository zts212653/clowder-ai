#!/usr/bin/env python3
"""Unified mlx-audio, mlx-whisper, and faster-whisper ASR server (#863)."""

from __future__ import annotations

import argparse
import asyncio
import logging
import math
import os
import signal
import struct
import sys
import tempfile
import wave
from pathlib import Path

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from dedicated_model_worker import DedicatedModelWorker
from qwen_asr_backend import load_model as load_qwen_model
from qwen_asr_backend import transcribe as transcribe_qwen

MAX_FILE_BYTES = 25 * 1024 * 1024  # 25 MB (matches OpenAI limit)

log = logging.getLogger("whisper-api")

app = FastAPI(title="Clowder AI Whisper Server")


@app.on_event("startup")
async def _emit_ready_marker():
    """Push-based ready signal — see embed-api.py + service-logs.ts."""
    print("__CATCAFE_SIDECAR_READY__", flush=True)


@app.on_event("shutdown")
async def _close_qwen_worker_on_app_shutdown():
    _shutdown_qwen_worker()


app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

model_path: str = ""
model_loaded: bool = False
_backend: str = "unknown"

# Admission lock bounds the queue; Qwen's worker additionally owns its MLX thread.
_transcribe_lock = asyncio.Lock()

_fw_model = None   # faster-whisper WhisperModel instance
_qwen_model = None  # mlx-audio loaded Qwen3-ASR model
_qwen_worker: DedicatedModelWorker | None = None


def _ensure_qwen_worker() -> DedicatedModelWorker:
    global _qwen_worker
    if _qwen_worker is None or _qwen_worker.closed:
        _qwen_worker = DedicatedModelWorker("cat-cafe-qwen-asr")
    return _qwen_worker


def _shutdown_qwen_worker():
    global _qwen_worker
    worker = _qwen_worker
    _qwen_worker = None
    if worker is not None:
        worker.shutdown()


async def _run_backend_operation(operation, *args):
    if _backend == "mlx-audio":
        if _qwen_worker is None or _qwen_worker.closed:
            raise RuntimeError("Qwen ASR worker is not available")
        return await _qwen_worker.run(operation, *args)
    return await asyncio.to_thread(operation, *args)


def _is_qwen3_model(name: str) -> bool:
    return "Qwen3-ASR" in name


def _is_mlx_whisper_model(name: str) -> bool:
    return name.startswith("mlx-community/whisper-")


def _transcribe_qwen3(tmp_path: str, language: str | None, initial_prompt: str | None) -> str:
    return transcribe_qwen(_qwen_model, tmp_path, initial_prompt)


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


def _transcribe_selected(tmp_path: str, language: str | None, initial_prompt: str | None) -> str:
    if _backend == "mlx-audio":
        return _transcribe_qwen3(tmp_path, language, initial_prompt)
    if _backend == "mlx-whisper":
        return _transcribe_mlx(tmp_path, language, initial_prompt)
    if _backend == "faster-whisper":
        return _transcribe_fw(tmp_path, language, initial_prompt)
    raise RuntimeError(f"ASR backend is not ready: {_backend}")


def _run_deep_health_probe() -> str:
    """Run one real inference against a deterministic one-second WAV."""
    fd, probe_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        sample_rate = 16000
        frames = b"".join(
            struct.pack("<h", int(800 * math.sin(2 * math.pi * 440 * index / sample_rate)))
            for index in range(sample_rate)
        )
        with wave.open(probe_path, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(sample_rate)
            wav_file.writeframes(frames)
        return _transcribe_selected(probe_path, "zh", "Clowder AI ASR lifecycle health probe")
    finally:
        Path(probe_path).unlink(missing_ok=True)


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
            text = await _run_backend_operation(_transcribe_selected, tmp_path, lang, prompt)
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


@app.get("/health/deep")
async def deep_health():
    if not model_loaded:
        return JSONResponse(
            status_code=503,
            content={"status": "loading", "model": model_path or "none", "backend": _backend},
        )
    try:
        async with _transcribe_lock:
            text = await _run_backend_operation(_run_deep_health_probe)
        return {"status": "ok", "model": model_path, "backend": _backend, "probe_text_chars": len(text)}
    except Exception as exc:
        log.exception("ASR deep-health inference failed")
        return JSONResponse(
            status_code=503,
            content={
                "status": "degraded",
                "model": model_path or "none",
                "backend": _backend,
                "error": str(exc)[:500],
            },
        )


def _load_qwen3_model():
    return load_qwen_model(model_path)


def _try_qwen3() -> bool:
    """Load Qwen3-ASR model via mlx-audio. Only called when model is Qwen3-ASR."""
    global model_loaded, _backend, _qwen_model
    model_loaded = False
    _backend = "unknown"
    _qwen_model = None
    worker = _ensure_qwen_worker()
    try:
        log.info("Loading Qwen3-ASR model via mlx-audio: %s", model_path)
        _qwen_model = worker.run_sync(_load_qwen3_model)
        _backend = "mlx-audio"
        model_loaded = True
        log.info("Model loaded via mlx-audio (Qwen3-ASR, Apple Silicon)")
        return True
    except ImportError:
        log.warning("mlx-audio not installed")
        _shutdown_qwen_worker()
        return False
    except Exception:
        log.exception("mlx-audio load failed for %s", model_path)
        _shutdown_qwen_worker()
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
        log.warning("MLX whisper failed for %s: %s", model_path, e)
        return False


def _try_faster_whisper() -> bool:
    global model_loaded, _backend, _fw_model
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        log.warning("faster-whisper not installed")
        return False
    try:
        fw_name = model_path
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
        _backend = "faster-whisper"
        model_loaded = True
        log.info("Model loaded via faster-whisper (device: %s)", device)
        return True
    except Exception:
        log.exception("faster-whisper load failed")
        return False


def main():
    global model_path

    parser = argparse.ArgumentParser(description="Clowder AI Whisper Server")
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
        _shutdown_qwen_worker()
        sys.exit(0)
    signal.signal(signal.SIGTERM, handle_sigterm)

    model_path = args.model
    log.info("=== Clowder AI ASR Server ===")
    log.info("Model: %s | Port: %d", model_path, args.port)

    if _is_qwen3_model(model_path):
        if not _try_qwen3():
            log.error("Qwen3-ASR backend failed (install mlx-audio)")
            sys.exit(1)
    elif _is_mlx_whisper_model(model_path):
        if not _try_mlx():
            log.error("MLX Whisper backend failed for configured model %s", model_path)
            sys.exit(1)
    elif not _try_faster_whisper():
        log.error("faster-whisper backend failed for configured model %s", model_path)
        sys.exit(1)

    log.info("API: http://localhost:%d/v1/audio/transcriptions", args.port)
    try:
        uvicorn.run(app, host="127.0.0.1", port=args.port)
    finally:
        _shutdown_qwen_worker()


if __name__ == "__main__":
    main()
