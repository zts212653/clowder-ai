#!/usr/bin/env python3
"""
LLM post-processing server for Cat Cafe voice input (MLX backend, Apple Silicon native).
Takes raw ASR text and returns corrected text using a local LLM.

Pipeline position:  Whisper ASR → **LLM post-edit** → term dictionary → filler removal

Usage:
  source ~/.cat-cafe/llm-venv/bin/activate
  python scripts/llm-postprocess-api.py                                          # default: Qwen3.5-35B-A3B MoE
  python scripts/llm-postprocess-api.py --model mlx-community/Qwen3.5-35B-A3B-4bit
  python scripts/llm-postprocess-api.py --port 9878                              # custom port

Requires: pip install mlx-vlm fastapi uvicorn pydantic
"""

import argparse
import asyncio
import logging
import signal
import sys
import time
import threading

import mlx.core as mx
import mlx_lm
import mlx_vlm
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

MAX_INPUT_CHARS = 2000  # Voice messages shouldn't be longer than this

log = logging.getLogger("llm-postprocess")

app = FastAPI(title="Cat Cafe LLM Post-Process Server")

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

model_ref = {"model": None, "processor": None, "path": "", "loaded": False, "error": False, "backend": "unknown"}

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
    context: str = ""  # Optional conversation context for better correction


class RefineResponse(BaseModel):
    text: str
    latency_ms: int


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

    user_msg = text
    if req.context:
        user_msg = f"[上下文: {req.context[:200]}]\n{text}"

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_msg},
    ]

    template_kwargs = dict(tokenize=False, add_generation_prompt=True)
    try:
        prompt = model_ref["processor"].apply_chat_template(
            messages, **template_kwargs, enable_thinking=False,
        )
    except TypeError:
        prompt = model_ref["processor"].apply_chat_template(messages, **template_kwargs)

    gen_fn = mlx_lm.generate if model_ref["backend"] == "mlx-lm" else mlx_vlm.generate

    def _generate_sync():
        mx.new_thread_local_stream(mx.gpu)
        return gen_fn(
            model_ref["model"],
            model_ref["processor"],
            prompt,
            max_tokens=len(text) * 2 + 50,
            temperature=0.1,
        )

    t0 = time.monotonic()
    try:
        async with _generate_lock:
            result = await asyncio.to_thread(_generate_sync)
        latency_ms = int((time.monotonic() - t0) * 1000)
        refined = (result if isinstance(result, str) else result.text).strip()

        # Safety: if LLM output is suspiciously different or empty, fall back to original
        max_output_len = max(len(text) * 2.5, 80)  # short inputs get a minimum allowance
        if not refined or len(refined) > max_output_len:
            log.warning("LLM output suspicious (len %d vs input %d), falling back", len(refined), len(text))
            return RefineResponse(text=text, latency_ms=latency_ms)

        log.info("Refined %d→%d chars in %dms", len(text), len(refined), latency_ms)
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


def _load_model_sync(model_path: str):
    """Load model in background thread — tries mlx_lm first, falls back to mlx_vlm."""
    log.info("Loading model (first run downloads from HuggingFace)...")
    try:
        model, tokenizer = mlx_lm.load(model_path)
        model_ref["model"] = model
        model_ref["processor"] = tokenizer
        model_ref["backend"] = "mlx-lm"
        model_ref["loaded"] = True
        log.info("Model loaded via mlx-lm! Endpoint ready: /v1/text/refine")
        return
    except Exception:
        log.info("mlx-lm failed, trying mlx-vlm...")
    try:
        model, processor = mlx_vlm.load(model_path)
        model_ref["model"] = model
        model_ref["processor"] = processor
        model_ref["backend"] = "mlx-vlm"
        model_ref["loaded"] = True
        log.info("Model loaded via mlx-vlm! Endpoint ready: /v1/text/refine")
    except Exception:
        log.exception("Failed to load model '%s' with both backends", model_path)
        model_ref["error"] = True


@app.on_event("startup")
async def _startup_load():
    """Start model loading in a background thread so health is immediately reachable."""
    t = threading.Thread(target=_load_model_sync, args=(model_ref["path"],), daemon=True)
    t.start()


def main():
    parser = argparse.ArgumentParser(description="Cat Cafe LLM Post-Process Server (MLX)")
    parser.add_argument(
        "--model",
        default="mlx-community/Qwen3.5-35B-A3B-4bit",
        help="HuggingFace MLX model repo (default: mlx-community/Qwen3.5-35B-A3B-4bit)",
    )
    parser.add_argument("--port", type=int, default=9878, help="Server port (default: 9878)")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

    def handle_sigterm(signum, frame):
        log.info("Received SIGTERM, shutting down...")
        sys.exit(0)
    signal.signal(signal.SIGTERM, handle_sigterm)

    model_ref["path"] = args.model
    log.info("=== Cat Cafe LLM Post-Process Server (MLX) ===")
    log.info("Model: %s | Port: %d", args.model, args.port)

    uvicorn.run(app, host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
