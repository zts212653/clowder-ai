"""Qwen3-ASR adapter. Call every function through DedicatedModelWorker."""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path


def load_model(model_path: str):
    from mlx_audio.stt.utils import load_model as mlx_load_model

    return mlx_load_model(model_path)


def _convert_to_wav(src_path: str) -> str:
    """Convert any audio format to 16kHz mono WAV via ffmpeg."""
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


def transcribe(model, tmp_path: str, initial_prompt: str | None) -> str:
    from mlx_audio.stt.generate import generate_transcription

    wav_path = tmp_path
    if not tmp_path.endswith(".wav"):
        wav_path = _convert_to_wav(tmp_path)

    fd, output_file = tempfile.mkstemp(suffix="_asr")
    os.close(fd)
    try:
        kwargs = dict(model=model, audio=wav_path, output_path=output_file, verbose=False)
        if initial_prompt:
            kwargs["context"] = initial_prompt
        result = generate_transcription(**kwargs)
        return result.text.strip() if hasattr(result, "text") else str(result).strip()
    finally:
        if wav_path != tmp_path:
            Path(wav_path).unlink(missing_ok=True)
        Path(output_file).unlink(missing_ok=True)
        Path(f"{output_file}.txt").unlink(missing_ok=True)
