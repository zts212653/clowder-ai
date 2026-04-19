#!/usr/bin/env python3
"""
Embedding server for Cat Cafe memory system (F102 Phase C/G).
Uses Apple Silicon GPU via MLX framework (native Metal acceleration).

POST /v1/embeddings         — generate embeddings for a batch of texts
GET  /health                — health check (status/model/backend/device)

Usage:
  source ~/.cat-cafe/embed-venv/bin/activate
  python scripts/embed-api.py                                         # default: Qwen3-Embedding-0.6B 4bit
  python scripts/embed-api.py --port 9877                             # custom port
  EMBED_DIM=512 python scripts/embed-api.py                           # MRL truncation to 512

Setup (one-time):
  python3 -m venv ~/.cat-cafe/embed-venv
  source ~/.cat-cafe/embed-venv/bin/activate
  pip install mlx mlx-embeddings fastapi uvicorn numpy

Model selection (LL-034: must use MLX GPU, not CPU ONNX):
  Default: mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ (335MB, MLX 4-bit)
  Larger:  mlx-community/Qwen3-Embedding-4B-4bit-DWQ   (~2.5GB, better quality)

Dim recommendations (CMTEB bilingual quality):
  768  — sweet spot for Chinese-English mixed content (default)
  512  — storage-sensitive floor (quality drops ~2%)
  256  — DO NOT USE for CJK (quality drops ~5%, too much semantic loss)
  1024 — maximum quality, 33% more storage than 768

Env vars:
  EMBED_PORT    — server port (default: 9877)
  EMBED_MODEL   — MLX model ID (default: mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ)
  EMBED_DIM     — output dimension after MRL truncation (default: 768)
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
import sys
import time
from typing import List

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

log = logging.getLogger("embed-api")

app = FastAPI(title="Cat Cafe Embedding Server (MLX)")

ALLOWED_ORIGINS = [
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:3002",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:3001",
    "http://127.0.0.1:3002",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

# ─── Global state ──────────────────────────────────────────────────

mlx_model = None
mlx_tokenizer = None
model_name: str = ""
embed_dim: int = 768
model_loaded: bool = False
_backend: str = "mlx-embeddings"

# Serialize GPU access (same pattern as whisper-api.py / tts-api.py)
_embed_lock = asyncio.Lock()

MAX_BATCH_SIZE = 64
MAX_TEXT_LENGTH = 8192

# Fallback: if mlx-embeddings not available, use sentence-transformers + MPS
_use_fallback = False
_st_model = None


# ─── Request/Response models ──────────────────────────────────────

class EmbedRequest(BaseModel):
    input: str | List[str] = Field(..., description="Text or list of texts to embed")
    model: str = Field(default="", description="Model identifier (ignored, uses server model)")


class EmbedResponse(BaseModel):
    object: str = "list"
    data: List[dict]
    model: str
    usage: dict


# ─── Endpoints ────────────────────────────────────────────────────

@app.post("/v1/embeddings")
async def create_embeddings(req: EmbedRequest):
    """OpenAI-compatible embedding endpoint."""
    if not model_loaded:
        raise HTTPException(503, detail="Model not loaded yet")

    texts = [req.input] if isinstance(req.input, str) else req.input
    if len(texts) == 0:
        raise HTTPException(400, detail="Empty input")
    if len(texts) > MAX_BATCH_SIZE:
        raise HTTPException(400, detail=f"Batch too large ({len(texts)}, max {MAX_BATCH_SIZE})")

    # Truncate long texts
    texts = [t[:MAX_TEXT_LENGTH] for t in texts]

    start_ms = time.time() * 1000

    async with _embed_lock:
        embeddings = await asyncio.to_thread(_encode, texts)

    elapsed_ms = time.time() * 1000 - start_ms
    log.info("Embedded %d text(s) in %.0fms (dim=%d)", len(texts), elapsed_ms, embed_dim)

    data = []
    for i, emb in enumerate(embeddings):
        data.append({
            "object": "embedding",
            "index": i,
            "embedding": emb.tolist(),
        })

    return EmbedResponse(
        data=data,
        model=model_name,
        usage={"prompt_tokens": sum(len(t) for t in texts), "total_tokens": sum(len(t) for t in texts)},
    )


@app.get("/health")
async def health():
    return {
        "status": "ok" if model_loaded else "loading",
        "model": model_name or "none",
        "backend": _backend,
        "device": "mlx" if not _use_fallback else "mps",
        "dim": embed_dim,
    }


# ─── Encoding ─────────────────────────────────────────────────────

def _encode(texts: List[str]) -> np.ndarray:
    """Encode texts to normalized embeddings with MRL truncation."""
    if _use_fallback:
        return _encode_fallback(texts)
    return _encode_mlx(texts)


def _encode_mlx(texts: List[str]) -> np.ndarray:
    """MLX-native encoding using mlx-embeddings library."""
    import mlx.core as mx
    from mlx_embeddings.utils import generate

    # mlx-embeddings generate() returns an mlx array
    output = generate(mlx_model, mlx_tokenizer, texts)

    # Convert to numpy
    if hasattr(output, 'numpy'):
        raw = np.array(output)
    else:
        raw = np.array(output.tolist())

    # MRL truncation to target dim
    truncated = raw[:, :embed_dim]
    # L2 normalize after truncation
    norms = np.linalg.norm(truncated, axis=1, keepdims=True)
    norms = np.where(norms > 0, norms, 1.0)
    return truncated / norms


def _encode_fallback(texts: List[str]) -> np.ndarray:
    """Fallback: sentence-transformers + MPS/CUDA/CPU."""
    assert _st_model is not None
    raw = _st_model.encode(texts, normalize_embeddings=False, show_progress_bar=False)
    truncated = raw[:, :embed_dim]
    norms = np.linalg.norm(truncated, axis=1, keepdims=True)
    norms = np.where(norms > 0, norms, 1.0)
    return truncated / norms


# ─── Startup ──────────────────────────────────────────────────────

def main():
    global mlx_model, mlx_tokenizer, model_name, embed_dim, model_loaded
    global _use_fallback, _st_model, _backend

    parser = argparse.ArgumentParser(description="Cat Cafe Embedding Server (MLX GPU)")
    parser.add_argument(
        "--model",
        default=os.environ.get("EMBED_MODEL", "mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ"),
        help="MLX model ID (default: mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ)",
    )
    parser.add_argument("--port", type=int, default=int(os.environ.get("EMBED_PORT", "9880")))
    parser.add_argument("--dim", type=int, default=int(os.environ.get("EMBED_DIM", "768")))
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

    def handle_sigterm(signum, frame):
        log.info("Received SIGTERM, shutting down...")
        sys.exit(0)
    signal.signal(signal.SIGTERM, handle_sigterm)

    model_name = args.model
    embed_dim = args.dim

    log.info("=== Cat Cafe Embedding Server ===")
    log.info("Model: %s | Dim: %d | Port: %d", model_name, embed_dim, args.port)

    # Try MLX-native first, fallback to sentence-transformers + MPS
    start = time.time()
    def _try_mlx() -> bool:
        """Try MLX-native load + test embedding. Returns True on success."""
        global mlx_model, mlx_tokenizer, _backend, model_loaded
        try:
            from mlx_embeddings.utils import load as mlx_load
            log.info("Loading model via mlx-embeddings (MLX GPU)...")
            mlx_model, mlx_tokenizer = mlx_load(model_name)
            # Smoke test: actually run one embedding to catch tokenizer bugs
            log.info("Running MLX smoke test...")
            _encode_mlx(["test"])
            _backend = "mlx-embeddings"
            model_loaded = True
            log.info("MLX model loaded + verified in %.1fs! Device: Apple Silicon GPU (Metal)", time.time() - start)
            return True
        except ImportError:
            log.warning("mlx-embeddings not installed")
            return False
        except Exception as e:
            log.warning("MLX load/inference failed (%s), falling back to sentence-transformers", e)
            mlx_model = None
            mlx_tokenizer = None
            return False

    def _try_sentence_transformers() -> bool:
        """Fallback: sentence-transformers + MPS/CUDA/CPU."""
        global _use_fallback, _st_model, _backend, model_loaded, model_name
        _use_fallback = True
        _backend = "sentence-transformers"
        try:
            import torch
            from sentence_transformers import SentenceTransformer
            fallback_model = model_name.replace("mlx-community/", "").replace("-4bit-DWQ", "").replace("-4bit", "")
            if "Qwen3-Embedding" in fallback_model:
                fallback_model = "Qwen/" + fallback_model
            if torch.cuda.is_available():
                device = "cuda"
            elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                device = "mps"
            else:
                device = "cpu"
            log.info("Loading model via sentence-transformers (device: %s)...", device)
            _st_model = SentenceTransformer(fallback_model, device=device)
            model_name = fallback_model  # update displayed model name
            model_loaded = True
            log.info("Fallback model loaded in %.1fs! (device: %s)", time.time() - start, device)
            return True
        except Exception:
            log.exception("Failed to load fallback model")
            return False

    if not _try_mlx():
        if not _try_sentence_transformers():
            log.error("All backends failed, exiting")
            sys.exit(1)

    log.info("API: http://localhost:%d/v1/embeddings", args.port)
    log.info("Health: http://localhost:%d/health", args.port)

    uvicorn.run(app, host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
