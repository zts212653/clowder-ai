// F102 Phase C/G: EmbeddingService — HTTP client to external GPU embedding server
// Replaces in-process ONNX (LL-034: must not run model inference in API process)
//
// The actual model runs in scripts/embed-api.py (independent Python process on GPU).
// This service is just an HTTP client, like MlxAudioTtsProvider / WhisperSttProvider.

import type { EmbedModelInfo, IEmbeddingService } from './interfaces.js';

interface EmbeddingServiceConfig {
  embedModel: string;
  embedDim: number;
  embedTimeoutMs: number;
  maxModelMemMb: number; // kept for interface compat, not used by HTTP client
}

interface EmbedApiResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
}

interface HealthResponse {
  status: string;
  model: string;
  backend: string;
  device: string;
  dim: number;
}

export class EmbeddingService implements IEmbeddingService {
  private config: EmbeddingServiceConfig;
  private baseUrl: string;
  private ready = false;
  private modelId = '';
  private modelRev = 'http-client';
  private loader: (() => Promise<void>) | null = null; // test hook

  constructor(config: EmbeddingServiceConfig) {
    this.config = config;
    // P1 fix (砚砚 review): derive from EMBED_PORT if EMBED_URL not set,
    // so custom sidecar port is respected without needing both env vars
    const port = process.env.EMBED_PORT ?? '9880';
    this.baseUrl = process.env.EMBED_URL ?? `http://127.0.0.1:${port}`;
  }

  async load(): Promise<void> {
    if (this.loader) {
      await this.loader();
      return;
    }

    // Probe the external embed-api server via /health
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
      const health = (await res.json()) as HealthResponse;
      if (health.status === 'ok') {
        this.ready = true;
        this.modelId = health.model || this.config.embedModel;
      }
    } catch {
      // fail-open: server not running → isReady()=false → lexical-only degradation
      this.ready = false;
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  getModelInfo(): EmbedModelInfo {
    return {
      modelId: this.modelId || this.config.embedModel,
      modelRev: this.modelRev,
      dim: this.config.embedDim,
    };
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this.ready) throw new Error('EmbeddingService not ready — embed-api server not available');

    const timeoutMs = this.config.embedTimeoutMs;
    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: texts }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`Embed API error: ${res.status} ${res.statusText}`);
    }

    const body = (await res.json()) as EmbedApiResponse;

    // Convert number[] to Float32Array with MRL dim check
    const targetDim = this.config.embedDim;
    return body.data
      .sort((a, b) => a.index - b.index)
      .map((d) => {
        const emb = d.embedding;
        // Server already does MRL truncation + L2 normalization,
        // but guard against dim mismatch
        const arr = new Float32Array(targetDim);
        for (let i = 0; i < Math.min(emb.length, targetDim); i++) {
          arr[i] = emb[i]!;
        }
        return arr;
      });
  }

  dispose(): void {
    this.ready = false;
  }

  // ── Test hooks (not part of IEmbeddingService interface) ──────────

  /** @internal test-only: mark as ready with mock */
  _setPipelineForTest(fn: unknown): void {
    // Compat with existing tests — just mark as ready
    this.ready = true;
    this.modelId = 'test-mock';
  }

  /** @internal test-only: set mock loader */
  _setLoaderForTest(fn: () => Promise<void>): void {
    this.loader = fn;
  }
}
