// F102 Phase C/G: EmbeddingService — HTTP client to external GPU embedding server
// Replaces in-process ONNX (LL-034: must not run model inference in API process)
//
// The actual model runs in scripts/services/embed-api.py (independent Python process on GPU).
// This service is just an HTTP client, like MlxAudioTtsProvider / WhisperSttProvider.

import { normalizeLoopbackUrl } from '../services/loopback-url.js';
import { getServiceConfig } from '../services/service-config.js';
import { getServiceManifest, resolveServiceEndpoint } from '../services/service-manifest.js';
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

// Mirror of embed-api.py's MAX_BATCH_SIZE (scripts/services/embed-api.py).
// Server rejects batches > this with HTTP 400, so the client must split.
const EMBED_BATCH_SIZE = 64;

export class EmbeddingService implements IEmbeddingService {
  private config: EmbeddingServiceConfig;
  private ready = false;
  private modelId = '';
  private modelRev = 'http-client';
  private loader: (() => Promise<void>) | null = null; // test hook
  private lastProbeAt = 0;
  private static readonly REPROBE_COOLDOWN_MS = 30_000;

  constructor(config: EmbeddingServiceConfig) {
    this.config = config;
  }

  // Resolve the embedding endpoint per request via the service manifest +
  // persisted services.json so /install / /reconfigure-driven port changes
  // flow into the API client without an API restart (codex P1 2026-05-24,
  // outdated thread). EMBED_URL / EMBED_PORT env still win because
  // resolveServiceEndpoint reads endpointEnvVars and portFallback first.
  private resolveBaseUrl(): string {
    const service = getServiceManifest('embedding-model');
    if (!service) {
      const port = process.env.EMBED_PORT ?? '9880';
      return normalizeLoopbackUrl(process.env.EMBED_URL ?? `http://127.0.0.1:${port}`);
    }
    const resolved = resolveServiceEndpoint(service, process.env, getServiceConfig('embedding-model'));
    return normalizeLoopbackUrl(resolved ?? 'http://127.0.0.1:9880');
  }

  async load(): Promise<void> {
    if (this.loader) {
      await this.loader();
      return;
    }

    // Probe the external embed-api server via /health
    try {
      const res = await fetch(`${this.resolveBaseUrl()}/health`, {
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

  markReady(modelId?: string): void {
    this.ready = true;
    if (modelId) this.modelId = modelId;
  }

  async reprobeIfNeeded(): Promise<void> {
    if (this.ready) return;
    const now = Date.now();
    if (now - this.lastProbeAt < EmbeddingService.REPROBE_COOLDOWN_MS) return;
    this.lastProbeAt = now;
    await this.load();
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
    if (texts.length === 0) return [];

    const results: Float32Array[] = new Array(texts.length);
    for (let offset = 0; offset < texts.length; offset += EMBED_BATCH_SIZE) {
      const batch = texts.slice(offset, offset + EMBED_BATCH_SIZE);
      const vectors = await this.embedBatch(batch);
      for (let i = 0; i < vectors.length; i++) {
        results[offset + i] = vectors[i]!;
      }
    }
    return results;
  }

  private async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const timeoutMs = this.config.embedTimeoutMs;
    const res = await fetch(`${this.resolveBaseUrl()}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: texts }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Embed API error: ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`);
    }

    const body = (await res.json()) as EmbedApiResponse;
    const targetDim = this.config.embedDim;
    return body.data
      .sort((a, b) => a.index - b.index)
      .map((d) => {
        const emb = d.embedding;
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
