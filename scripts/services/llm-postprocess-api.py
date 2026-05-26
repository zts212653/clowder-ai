#!/usr/bin/env python3
"""
LLM post-processing server for Cat Cafe voice input.
Backends: mlx-lm/mlx-vlm (macOS GPU) -> transformers+torch (CPU/CUDA).
Pipeline: Whisper ASR -> **LLM post-edit** -> term dictionary -> filler removal
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import re
import signal
import sys
import threading
import time

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

MAX_INPUT_CHARS = 2000

log = logging.getLogger("llm-postprocess")

app = FastAPI(title="Cat Cafe LLM Post-Process Server")

# NOTE: deliberately no __CATCAFE_SIDECAR_READY__ marker emit here.
# Unlike embed/whisper/tts which finish model load synchronously in main()
# before uvicorn.run(), this sidecar offloads model load to a background
# thread (see `_startup_load` below + threading.Thread). At the moment
# uvicorn binds the port, /health is still status=loading, so emitting
# the push marker would falsely signal readiness. Health polling (the
# watcher safety net) correctly waits for status=running anyway, and
# llm-postprocess has no embed-catch-up hook to fire so the marker
# wouldn't gain anything even if timed correctly.

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

model_ref: dict = {"model": None, "processor": None, "path": "", "loaded": False, "error": False, "backend": "unknown"}

_generate_lock = asyncio.Lock()

SYSTEM_PROMPT = (
    "你是语音转文字后处理器。你的唯一任务是修正输入文本中的语音识别错误。\n"
    "规则：\n"
    "1. 修正同音字/谐音错误（如「先先」→「宪宪」，「免因猫」→「缅因猫」）\n"
    "2. 修正明显的断句和标点问题\n"
    "3. 保留原意、原始语序和说话风格\n"
    "4. 不要添加、删除或改写任何内容\n"
    "5. 不要添加解释或注释\n"
    "6. 如果文本没有需要修正的内容，原样输出\n"
    "7. 只输出修正后的文本，不要输出任何其他内容"
)


class RefineRequest(BaseModel):
    text: str
    context: str = ""


class RefineResponse(BaseModel):
    text: str
    latency_ms: int


def _resolve_hf_model(name: str) -> str:
    """Convert MLX model name to standard HuggingFace name for transformers."""
    name = name.replace("mlx-community/", "")
    name = re.sub(r"-\d+bit(-DWQ)?$", "", name)
    if name.startswith("Qwen") and "/" not in name:
        name = "Qwen/" + name
    return name


def _build_prompt(text: str, context: str) -> list[dict]:
    user_msg = text
    if context:
        user_msg = f"[上下文: {context[:200]}]\n{text}"
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_msg},
    ]


def _generate_mlx(messages: list[dict], max_tokens: int) -> str:
    import mlx.core as mx

    backend = model_ref["backend"]
    gen_mod = __import__("mlx_lm" if backend == "mlx-lm" else "mlx_vlm")

    template_kwargs = dict(tokenize=False, add_generation_prompt=True)
    try:
        prompt = model_ref["processor"].apply_chat_template(
            messages, **template_kwargs, enable_thinking=False,
        )
    except TypeError:
        prompt = model_ref["processor"].apply_chat_template(messages, **template_kwargs)

    mx.new_thread_local_stream(mx.gpu)
    result = gen_mod.generate(
        model_ref["model"], model_ref["processor"], prompt,
        max_tokens=max_tokens, temperature=0.1,
    )
    return (result if isinstance(result, str) else result.text).strip()


def _generate_transformers(messages: list[dict], max_tokens: int) -> str:
    import torch

    tokenizer = model_ref["processor"]
    model = model_ref["model"]

    inputs = tokenizer.apply_chat_template(
        messages, tokenize=True, return_tensors="pt", add_generation_prompt=True,
    )
    if isinstance(inputs, dict):
        inputs = {k: v.to(model.device) for k, v in inputs.items()}
    else:
        inputs = inputs.to(model.device)

    with torch.no_grad():
        if isinstance(inputs, dict):
            outputs = model.generate(**inputs, max_new_tokens=max_tokens, temperature=0.1, do_sample=True)
            input_len = inputs["input_ids"].shape[1]
        else:
            outputs = model.generate(inputs, max_new_tokens=max_tokens, temperature=0.1, do_sample=True)
            input_len = inputs.shape[1]

    return tokenizer.decode(outputs[0][input_len:], skip_special_tokens=True).strip()


@app.post("/v1/text/refine", response_model=RefineResponse)
async def refine(req: RefineRequest):
    """Refine ASR output using local LLM."""
    if not model_ref["loaded"]:
        raise HTTPException(503, detail="Model not loaded yet")

    text = req.text.strip()
    if not text:
        return RefineResponse(text="", latency_ms=0)
    if len(text) > MAX_INPUT_CHARS:
        raise HTTPException(413, detail=f"Text too long ({len(text)} chars, max {MAX_INPUT_CHARS})")

    messages = _build_prompt(text, req.context)
    max_tokens = len(text) * 2 + 50
    backend = model_ref["backend"]
    gen_fn = _generate_mlx if backend in ("mlx-lm", "mlx-vlm") else _generate_transformers

    t0 = time.monotonic()
    try:
        async with _generate_lock:
            refined = await asyncio.to_thread(gen_fn, messages, max_tokens)
        latency_ms = int((time.monotonic() - t0) * 1000)

        max_output_len = max(len(text) * 2.5, 80)
        if not refined or len(refined) > max_output_len:
            log.warning("LLM output suspicious (len %d vs input %d), falling back", len(refined), len(text))
            return RefineResponse(text=text, latency_ms=latency_ms)

        log.info("Refined %d->%d chars in %dms", len(text), len(refined), latency_ms)
        return RefineResponse(text=refined, latency_ms=latency_ms)
    except Exception as exc:
        log.exception("LLM generation failed")
        raise HTTPException(500, detail=f"Generation error: {exc}") from exc


@app.get("/health")
async def health():
    return {
        "status": "ok" if model_ref["loaded"] else "loading",
        "model": model_ref["path"] or "none",
        "backend": model_ref["backend"],
    }


# ─── Model loading ───────────────────────────────────────────────

def _try_mlx(model_path: str) -> bool:
    try:
        import mlx_lm
    except ImportError:
        return False
    try:
        model, tokenizer = mlx_lm.load(model_path)
        model_ref["model"] = model
        model_ref["processor"] = tokenizer
        model_ref["backend"] = "mlx-lm"
        model_ref["loaded"] = True
        log.info("Model loaded via mlx-lm")
        return True
    except Exception:
        log.info("mlx-lm failed, trying mlx-vlm...")
    try:
        import mlx_vlm
        model, processor = mlx_vlm.load(model_path)
        model_ref["model"] = model
        model_ref["processor"] = processor
        model_ref["backend"] = "mlx-vlm"
        model_ref["loaded"] = True
        log.info("Model loaded via mlx-vlm")
        return True
    except Exception:
        log.warning("MLX backends failed for '%s'", model_path)
        return False


def _try_transformers(model_path: str) -> bool:
    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
    except ImportError:
        log.warning("transformers/torch not installed")
        return False
    try:
        hf_name = _resolve_hf_model(model_path)
        device = "cpu"
        dtype = torch.float32
        if torch.cuda.is_available():
            device = "cuda"
            dtype = torch.float16
        log.info("Loading via transformers: %s (device=%s)", hf_name, device)
        tokenizer = AutoTokenizer.from_pretrained(hf_name)
        model = AutoModelForCausalLM.from_pretrained(hf_name, torch_dtype=dtype)
        if device != "cpu":
            model = model.to(device)
        model_ref["model"] = model
        model_ref["processor"] = tokenizer
        model_ref["path"] = hf_name
        model_ref["backend"] = "transformers"
        model_ref["loaded"] = True
        log.info("Model loaded via transformers (device: %s)", device)
        return True
    except Exception:
        log.exception("transformers load failed")
        return False


def _load_model_sync(model_path: str):
    """Load model in background thread — tries MLX first, falls back to transformers."""
    log.info("Loading model (first run downloads from HuggingFace)...")
    if not _try_mlx(model_path):
        if not _try_transformers(model_path):
            log.error("All backends failed for '%s'", model_path)
            model_ref["error"] = True


@app.on_event("startup")
async def _startup_load():
    t = threading.Thread(target=_load_model_sync, args=(model_ref["path"],), daemon=True)
    t.start()


def main():
    parser = argparse.ArgumentParser(description="Cat Cafe LLM Post-Process Server")
    parser.add_argument(
        "--model",
        required=True,
        help="Model repo ID — required, no fallback default. Backend always passes via env.",
    )
    parser.add_argument("--port", type=int, default=9878)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

    def handle_sigterm(signum, frame):
        log.info("Received SIGTERM, shutting down...")
        sys.exit(0)
    signal.signal(signal.SIGTERM, handle_sigterm)

    model_ref["path"] = args.model
    log.info("=== Cat Cafe LLM Post-Process Server ===")
    log.info("Model: %s | Port: %d", args.model, args.port)

    uvicorn.run(app, host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
