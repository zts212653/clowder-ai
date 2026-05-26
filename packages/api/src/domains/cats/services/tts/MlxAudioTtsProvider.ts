/**
 * F34: MLX-Audio TTS Provider
 *
 * Implements ITtsProvider by calling the local Python TTS server
 * (scripts/tts-api.py) via HTTP. The Python server wraps mlx-audio
 * and serves an OpenAI-compatible /v1/audio/speech endpoint.
 */

import type { ITtsProvider, TtsSynthesizeRequest, TtsSynthesizeResult } from '@cat-cafe/shared';
import { normalizeLoopbackUrl } from '../../../services/loopback-url.js';
import { getServiceConfig } from '../../../services/service-config.js';
import { getServiceManifest, resolveServiceEndpoint } from '../../../services/service-manifest.js';

export interface MlxAudioTtsProviderOptions {
  /** Base URL of the Python TTS server (default: http://localhost:9879) */
  readonly baseUrl?: string;
  /** Model to request (default: mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16) */
  readonly model?: string;
  /** Request timeout in ms (default: 30000) */
  readonly timeoutMs?: number;
}

/**
 * Calculate dynamic synthesis timeout from text length.
 *
 * Empirical: Qwen3-TTS Base ~19 tokens/s clone-mode (observed 2026-04-27);
 * each Chinese char ≈ 3 audio tokens. Clone-mode warmup absorbs refAudio
 * loading + model swap (~60 s); non-clone just needs a small network buffer
 * (~5 s) since the model stays warm.
 *
 * Two-axis guard:
 * - **floor**: caller's `baseTimeoutMs` is always honored — even above the
 *   hard cap — so callers tuning for slow / cold-start hosts get exactly
 *   what they asked for. There is no separate "clone floor"; the 60 s clone
 *   warmup that's already added to the dynamic estimate provides the minimum.
 * - **dynamic**: generation_time + warmup, scales linearly with text length.
 *   Bounded above by `TTS_TIMEOUT_HARD_CAP_MS` (600 s, 10 min) to prevent a
 *   runaway estimate compounding with VoiceBlockSynthesizer's retry into
 *   >20 min lockup when caller relies on default timeoutMs.
 *
 * Result = `max(min(dynamic, hard_cap), caller_baseTimeoutMs)`.
 *
 * @internal Exported for tests; do not depend on this from other modules.
 */
export const TTS_TIMEOUT_HARD_CAP_MS = 600_000;
const TTS_TOKENS_PER_CHAR = 3;
const TTS_CLONE_TPS = 15;
const TTS_NON_CLONE_TPS = 25;
const TTS_CLONE_WARMUP_MS = 60_000;
const TTS_NON_CLONE_WARMUP_MS = 5_000;

export function calculateTimeout(text: string, hasCloneParams: boolean, baseTimeoutMs: number): number {
  const tokensPerSec = hasCloneParams ? TTS_CLONE_TPS : TTS_NON_CLONE_TPS;
  const warmupMs = hasCloneParams ? TTS_CLONE_WARMUP_MS : TTS_NON_CLONE_WARMUP_MS;
  const tokensEst = text.length * TTS_TOKENS_PER_CHAR;
  const dynamicMs = Math.ceil((tokensEst / tokensPerSec) * 1000) + warmupMs;
  const cappedDynamicMs = Math.min(dynamicMs, TTS_TIMEOUT_HARD_CAP_MS);
  return Math.max(cappedDynamicMs, baseTimeoutMs);
}

function resolveTtsBaseUrl(): string {
  const service = getServiceManifest('mlx-tts');
  if (!service) return process.env.TTS_URL ?? 'http://127.0.0.1:9879';
  return resolveServiceEndpoint(service, process.env, getServiceConfig('mlx-tts')) ?? 'http://127.0.0.1:9879';
}

export class MlxAudioTtsProvider implements ITtsProvider {
  readonly id = 'mlx-audio';
  readonly model: string;
  // When the caller passes an explicit baseUrl (mostly tests, also legacy
  // hard-coded env wiring), freeze it. When omitted, leave undefined so
  // synthesize() resolves the URL from the service manifest + persisted
  // config on every request — that way /reconfigure-driven port changes
  // take effect on the next call without restarting the API process
  // (codex P1 2026-05-26).
  private readonly baseUrlOverride: string | undefined;
  private readonly timeoutMs: number;

  constructor(options?: MlxAudioTtsProviderOptions) {
    this.baseUrlOverride = options?.baseUrl ? normalizeLoopbackUrl(options.baseUrl) : undefined;
    this.model = options?.model ?? 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16';
    this.timeoutMs = options?.timeoutMs ?? 30_000;
  }

  private resolveBaseUrl(): string {
    return this.baseUrlOverride ?? normalizeLoopbackUrl(resolveTtsBaseUrl());
  }

  async synthesize(request: TtsSynthesizeRequest): Promise<TtsSynthesizeResult> {
    const url = `${this.resolveBaseUrl()}/v1/audio/speech`;

    // F066: Build request body with optional clone params for Qwen3-TTS Base
    const body = JSON.stringify({
      input: request.text,
      voice: request.voice,
      model: this.model,
      response_format: request.format ?? 'wav',
      speed: request.speed ?? 1.0,
      lang_code: request.langCode ?? 'z',
      ...(request.refAudio ? { ref_audio: request.refAudio } : {}),
      ...(request.refText ? { ref_text: request.refText } : {}),
      ...(request.instruct ? { instruct: request.instruct } : {}),
      ...(request.temperature != null ? { temperature: request.temperature } : {}),
    });

    // Dynamic timeout: prevents premature abort while server is still generating.
    // Long voice messages (~400 chars) routinely exceeded the old 120 s clone-mode
    // hard cap; calculateTimeout scales with text length.
    const hasCloneParams = !!(request.refAudio || request.instruct);
    const effectiveTimeout = calculateTimeout(request.text, hasCloneParams, this.timeoutMs);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => 'unknown');
        throw new Error(`TTS server returned ${response.status}: ${detail}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const audio = new Uint8Array(arrayBuffer);

      // Respect actual format from server (edge-tts may return mp3 when wav was requested)
      // Whitelist to prevent path traversal via malicious header values
      const serverFormat = response.headers.get('x-audio-format');
      const ALLOWED_FORMATS = new Set(['wav', 'mp3']);
      const actualFormat = serverFormat && ALLOWED_FORMATS.has(serverFormat) ? serverFormat : (request.format ?? 'wav');

      return {
        audio,
        format: actualFormat,
        metadata: {
          provider: this.id,
          model: this.model,
          voice: request.voice,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
