#!/usr/bin/env python3
"""
Embedding server for Cat Cafe memory system.

Backends: MLX (macOS GPU) → fastembed/ONNX (CPU/CUDA) → sentence-transformers.
Env vars: EMBED_PORT, EMBED_MODEL (MLX), EMBED_ONNX_MODEL (fastembed), EMBED_DIM.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import platform
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


@app.on_event("startup")
async def _emit_ready_marker():
    """Print a marker line so the TS parent process can fire 'started' the
    moment uvicorn finishes binding the port — push-based fast path that
    replaces a 5s polling delay. Matches the marker constant in
    packages/api/src/domains/services/service-logs.ts (wireUpSidecarReadyListener).
    Falls back to uvicorn's own 'Uvicorn running on http' line if this hook
    doesn't run for any reason.
    """
    print("__CATCAFE_SIDECAR_READY__", flush=True)


app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
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
_started_at: float = time.time()
_request_count: int = 0
_last_embed_ms: float | None = None

# Serialize GPU access (same pattern as whisper-api.py / tts-api.py)
_embed_lock = asyncio.Lock()

MAX_BATCH_SIZE = 64
MAX_TEXT_LENGTH = 8192

# Lightweight fallback: fastembed (ONNX Runtime, no torch needed)
_use_fastembed = False
_fe_model = None
_onnx_device = "cpu"

# Heavy fallback: sentence-transformers + MPS/CUDA/CPU (needs torch)
_use_fallback = False
_st_model = None
_fallback_device: str = ""


def _env_truthy(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _is_apple_silicon() -> bool:
    return platform.system() == "Darwin" and platform.machine() == "arm64"


def _allow_sentence_transformers_fallback() -> bool:
    if "EMBED_ALLOW_ST_FALLBACK" in os.environ:
        return _env_truthy("EMBED_ALLOW_ST_FALLBACK")
    return not _is_apple_silicon()


def _process_max_rss_bytes() -> int:
    """Return process max RSS in bytes (macOS reports bytes, Linux reports KiB).
    Returns 0 on Windows where the resource module is unavailable."""
    try:
        import resource

        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        if sys.platform == "darwin":
            return int(rss)
        return int(rss * 1024)
    except ImportError:
        return 0


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
    global _request_count, _last_embed_ms
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
    _request_count += 1
    _last_embed_ms = elapsed_ms
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
        "device": f"onnx-{_onnx_device}" if _use_fastembed else ("mlx" if not _use_fallback else (_fallback_device or "unknown")),
        "dim": embed_dim,
        "request_count": _request_count,
        "last_request_ms": round(_last_embed_ms, 2) if _last_embed_ms is not None else None,
        "max_rss_bytes": _process_max_rss_bytes(),
        "uptime_seconds": round(time.time() - _started_at, 1),
        "fallback_allowed": _allow_sentence_transformers_fallback(),
    }


# ─── Encoding ─────────────────────────────────────────────────────

def _encode(texts: List[str]) -> np.ndarray:
    """Encode texts to normalized embeddings with MRL truncation."""
    if _use_fastembed:
        return _encode_fastembed(texts)
    if _use_fallback:
        return _encode_fallback(texts)
    return _encode_mlx(texts)


def _encode_mlx(texts: List[str]) -> np.ndarray:
    """MLX-native encoding using mlx-embeddings library."""
    import mlx.core as mx
    from mlx_embeddings.utils import generate

    # mlx-embeddings generate() may return an mlx array, or a BaseModelOutput
    # wrapper containing text_embeds / last_hidden_state (#586).
    output = generate(mlx_model, mlx_tokenizer, texts)

    # Unwrap BaseModelOutput if present (check value, not just attribute)
    if hasattr(output, 'text_embeds') and output.text_embeds is not None:
        output = output.text_embeds
    elif hasattr(output, 'last_hidden_state') and output.last_hidden_state is not None:
        output = output.last_hidden_state

    # Convert to numpy
    if hasattr(output, 'numpy'):
        raw = np.array(output)
    elif hasattr(output, 'tolist'):
        raw = np.array(output.tolist())
    else:
        raw = np.array(output)

    # Pool 3D last_hidden_state (batch × seq × hidden) → 2D (batch × hidden)
    if raw.ndim == 3:
        raw = raw.mean(axis=1)

    # MRL truncation to target dim
    truncated = raw[:, :embed_dim]
    # L2 normalize after truncation
    norms = np.linalg.norm(truncated, axis=1, keepdims=True)
    norms = np.where(norms > 0, norms, 1.0)
    return truncated / norms


def _encode_fastembed(texts: List[str]) -> np.ndarray:
    """Lightweight ONNX Runtime encoding via fastembed."""
    raw = np.array(list(_fe_model.embed(texts)))
    truncated = raw[:, :embed_dim]
    norms = np.linalg.norm(truncated, axis=1, keepdims=True)
    norms = np.where(norms > 0, norms, 1.0)
    return truncated / norms


def _encode_fallback(texts: List[str]) -> np.ndarray:
    """Heavy fallback: sentence-transformers + MPS/CUDA/CPU."""
    assert _st_model is not None
    raw = _st_model.encode(texts, normalize_embeddings=False, show_progress_bar=False)
    truncated = raw[:, :embed_dim]
    norms = np.linalg.norm(truncated, axis=1, keepdims=True)
    norms = np.where(norms > 0, norms, 1.0)
    return truncated / norms


# ─── Startup ──────────────────────────────────────────────────────

def main():
    global mlx_model, mlx_tokenizer, model_name, embed_dim, model_loaded
    global _use_fallback, _st_model, _backend, _fallback_device

    parser = argparse.ArgumentParser(description="Cat Cafe Embedding Server (MLX GPU)")
    parser.add_argument(
        "--model",
        required=True,
        help="Model repo ID — required, no fallback default. The backend spawn caller "
        "(routes/services.ts resolveSelectedModel) must always pass this; we rejected "
        "the previous mlx-community default because it picked the wrong model on "
        "non-mac platforms when EMBED_MODEL was unset.",
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

    # Try MLX-native first, then fastembed. On Apple Silicon, do not silently
    # fall back to sentence-transformers: its MPS path can exhaust unified memory.
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

    def _try_fastembed() -> bool:
        """Lightweight ONNX backend via fastembed (no torch needed)."""
        global _use_fastembed, _fe_model, _onnx_device, _backend, model_loaded, model_name, embed_dim
        try:
            from fastembed import TextEmbedding
        except ImportError:
            log.warning("fastembed not installed")
            return False
        # fastembed has a hardcoded whitelist (verified via fastembed 0.8
        # TextEmbedding.list_supported_models()). jinaai/jina-embeddings-v2-base-zh
        # is in the catalog (768 dim, bilingual zh+en, ~640MB).
        # If the configured model is MLX (mac) or another non-whitelisted name,
        # fall back to jina-zh.
        fe_name = (
            model_name
            if not model_name.startswith("mlx-community/")
            else "jinaai/jina-embeddings-v2-base-zh"
        )
        providers = None
        device_label = "CPU"
        try:
            import onnxruntime as ort
            avail = ort.get_available_providers()
            if "CUDAExecutionProvider" in avail:
                providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
                device_label = "CUDA GPU"
                _onnx_device = "gpu"
        except ImportError:
            pass
        try:
            log.info("Loading via fastembed (ONNX %s): %s ...", device_label, fe_name)
            fe_kwargs: dict = {"model_name": fe_name}
            if providers:
                fe_kwargs["providers"] = providers
            _fe_model = TextEmbedding(**fe_kwargs)
            test_out = np.array(list(_fe_model.embed(["test"])))
            native_dim = test_out.shape[1]
            if native_dim < embed_dim:
                embed_dim = native_dim
                log.info("Adjusted embed_dim to model native: %d", native_dim)
            _use_fastembed = True
            _backend = "fastembed-onnx"
            model_name = fe_name
            model_loaded = True
            log.info("fastembed loaded in %.1fs (dim=%d, ONNX %s)", time.time() - start, embed_dim, device_label)
            return True
        except Exception as e:
            log.warning("fastembed failed (%s), trying next backend", e)
            return False

    def _try_sentence_transformers() -> bool:
        """Heavy fallback: sentence-transformers + MPS/CUDA/CPU (needs torch)."""
        global _use_fallback, _st_model, _backend, model_loaded, model_name, _fallback_device
        _use_fallback = True
        _backend = "sentence-transformers"
        try:
            import torch
            from sentence_transformers import SentenceTransformer
        except ImportError:
            log.error("Fallback deps missing: pip install sentence-transformers torch")
            return False
        try:
            fallback_model = model_name.replace("mlx-community/", "").replace("-4bit-DWQ", "").replace("-4bit", "")
            if "Qwen3-Embedding" in fallback_model:
                fallback_model = "Qwen/" + fallback_model
            explicit_device = os.environ.get("EMBED_ST_DEVICE", "").strip()
            if explicit_device:
                device = explicit_device
            elif torch.cuda.is_available():
                device = "cuda"
            elif not _is_apple_silicon() and hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                device = "mps"
            else:
                device = "cpu"
            log.info("Loading model via sentence-transformers (device: %s)...", device)
            # Override attn_implementation: some HF models (e.g. older
            # jinaai/jina-embeddings-v2-*) have `attn_implementation="torch"`
            # baked into their config.json — newer transformers (>=4.46)
            # rejects that string and only accepts eager/sdpa/flash_*. Pass
            # 'eager' explicitly so SentenceTransformer forwards it to
            # from_pretrained() and shadows the broken config value.
            _st_model = SentenceTransformer(
                fallback_model,
                device=device,
                model_kwargs={"attn_implementation": "eager"},
            )
            _fallback_device = device
            model_name = fallback_model
            model_loaded = True
            log.info("Fallback model loaded in %.1fs! (device: %s)", time.time() - start, device)
            return True
        except Exception:
            log.exception("Failed to load fallback model")
            return False

    if not _try_mlx():
        if not _try_fastembed():
            if not _allow_sentence_transformers_fallback():
                log.error(
                    "SentenceTransformer fallback disabled on Apple Silicon; "
                    "fix MLX dependencies or set EMBED_ALLOW_ST_FALLBACK=1 to opt in"
                )
                sys.exit(1)
            if not _try_sentence_transformers():
                log.error("All backends failed, exiting")
                sys.exit(1)

    log.info("API: http://localhost:%d/v1/embeddings", args.port)
    log.info("Health: http://localhost:%d/health", args.port)

    uvicorn.run(app, host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
