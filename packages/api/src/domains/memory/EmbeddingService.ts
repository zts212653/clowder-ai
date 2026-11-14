// F102 Phase C/G: EmbeddingService — HTTP client to external GPU embedding server
// Replaces in-process ONNX (LL-034: must not run model inference in API process)
//
// The actual model runs in scripts/services/embed-api.py (independent Python process on GPU).
// This service is just an HTTP client, like MlxAudioTtsProvider / WhisperSttProvider.

import { normalizeLoopbackUrl } from '../services/loopback-url.js';
import { getServiceConfig } from '../services/service-config.js';
import { getServiceManifest, resolveServiceEndpoint } from '../services/service-manifest.js';
import type { EmbedConfig, EmbedModelInfo, IEmbeddingService } from './interfaces.js';

interface EmbeddingServiceConfig {
  embedModel: string;
  embedDim: number;
  embedTimeoutMs: number;
  maxModelMemMb: number;
  generationId?: EmbedConfig['generationId'];
  representationFingerprint?: string;
  embedModelRev?: string;
  embedUrl?: string;
  queryInstruction?: string;
}

interface EmbedApiResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  dim?: number;
  generation_id?: string;
  representation_fingerprint?: string;
}

interface HealthResponse {
  status: string;
  model: string;
  backend: string;
  device: string;
  dim: number;
  generation_id?: string;
  representation_fingerprint?: string;
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
  private lastHealthyBaseUrl?: string;
  private observedIdentity?: Pick<HealthResponse, 'model' | 'dim' | 'generation_id' | 'representation_fingerprint'>;
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
    if (this.config.embedUrl) return normalizeLoopbackUrl(this.config.embedUrl);
    const service = getServiceManifest('embedding-model');
    if (!service) {
      const port = process.env.EMBED_PORT ?? '9880';
      return normalizeLoopbackUrl(process.env.EMBED_URL ?? `http://127.0.0.1:${port}`);
    }
    const resolved = resolveServiceEndpoint(service, process.env, getServiceConfig('embedding-model'));
    return normalizeLoopbackUrl(resolved ?? 'http://127.0.0.1:9880');
  }

  async load(parentSignal?: AbortSignal): Promise<void> {
    if (this.loader) {
      await this.loader();
      return;
    }

    // Probe the external embed-api server via /health
    try {
      const timeoutSignal = AbortSignal.timeout(5000);
      const baseUrl = this.resolveBaseUrl();
      const res = await fetch(`${baseUrl}/health`, {
        signal: parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal,
      });
      if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
      const health = (await res.json()) as HealthResponse;
      if (health.status === 'ok') {
        this.assertIdentity(health);
        this.observedIdentity = {
          model: health.model,
          dim: health.dim,
          generation_id: health.generation_id,
          representation_fingerprint: health.representation_fingerprint,
        };
        this.lastHealthyBaseUrl = baseUrl;
        this.ready = true;
        this.modelId = health.model || this.config.embedModel;
      } else {
        this.ready = false;
      }
    } catch (error) {
      // fail-open: server not running → isReady()=false → lexical-only degradation
      this.ready = false;
      if (parentSignal?.aborted) throw parentSignal.reason ?? error;
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  markReady(modelId?: string): void {
    this.ready = true;
    if (modelId) this.modelId = modelId;
  }

  async reprobeIfNeeded(signal?: AbortSignal): Promise<void> {
    if (this.ready) return;
    const now = Date.now();
    if (now - this.lastProbeAt < EmbeddingService.REPROBE_COOLDOWN_MS) return;
    this.lastProbeAt = now;
    await this.load(signal);
  }

  getModelInfo(): EmbedModelInfo {
    return {
      modelId: this.modelId || this.config.embedModel,
      modelRev: this.config.embedModelRev ?? this.modelRev,
      dim: this.config.embedDim,
      ...(this.config.generationId ? { generationId: this.config.generationId } : {}),
      ...(this.config.representationFingerprint
        ? { representationFingerprint: this.config.representationFingerprint }
        : {}),
      ...(this.config.queryInstruction !== undefined ? { queryInstruction: this.config.queryInstruction } : {}),
    };
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    if (!this.ready) throw new Error('EmbeddingService not ready — embed-api server not available');
    if (texts.length === 0) return [];

    const results: Float32Array[] = new Array(texts.length);
    for (let offset = 0; offset < texts.length; offset += EMBED_BATCH_SIZE) {
      signal?.throwIfAborted();
      const batch = texts.slice(offset, offset + EMBED_BATCH_SIZE);
      const vectors = await this.embedBatch(batch, signal);
      for (let i = 0; i < vectors.length; i++) {
        const vector = vectors[i];
        if (!vector) throw new Error(`Embed API omitted vector ${i} from batch`);
        results[offset + i] = vector;
      }
    }
    return results;
  }

  private async embedBatch(texts: string[], parentSignal?: AbortSignal): Promise<Float32Array[]> {
    const timeoutMs = this.config.embedTimeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
    const deadlineMs = Date.now() + timeoutMs;
    const res = await fetch(`${this.resolveBaseUrl()}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input: texts,
        deadline_ms: deadlineMs,
        max_model_mem_mb: this.config.maxModelMemMb,
        ...(this.config.representationFingerprint
          ? { representation_fingerprint: this.config.representationFingerprint }
          : {}),
      }),
      signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Embed API error: ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`);
    }

    const body = (await res.json()) as EmbedApiResponse;
    try {
      this.assertIdentity(body);
    } catch (error) {
      this.ready = false;
      throw error;
    }
    const targetDim = this.config.embedDim;
    if (!Array.isArray(body.data) || body.data.length !== texts.length)
      throw new Error('Embedding response shape mismatch');
    return body.data
      .sort((a, b) => a.index - b.index)
      .map((d, index) => {
        const emb = d.embedding;
        if (d.index !== index || !Array.isArray(emb) || !emb.every(Number.isFinite))
          throw new Error('Invalid embedding response vector');
        if (this.config.representationFingerprint && emb.length !== targetDim)
          throw new Error('Embedding representation dimension mismatch');
        const arr = new Float32Array(targetDim);
        for (let i = 0; i < Math.min(emb.length, targetDim); i++) {
          const value = emb[i];
          if (value !== undefined) arr[i] = value;
        }
        return arr;
      });
  }

  private assertIdentity(body: HealthResponse | EmbedApiResponse): void {
    const observed = this.observedIdentity;
    if (
      observed &&
      (body.model !== observed.model ||
        (body.dim !== undefined && observed.dim !== undefined && body.dim !== observed.dim) ||
        (observed.representation_fingerprint &&
          body.representation_fingerprint !== observed.representation_fingerprint))
    )
      throw new Error('Embedding loaded identity changed');
    const expectedGeneration = this.config.generationId ?? 'g0';
    if (body.generation_id && body.generation_id !== expectedGeneration)
      throw new Error('Embedding generation identity mismatch');
    const expected = this.config.representationFingerprint;
    if (expectedGeneration !== 'g0' && !expected) throw new Error('Embedding representation identity is required');
    if (
      expected &&
      (body.representation_fingerprint !== expected ||
        body.model !== this.config.embedModel ||
        (body.dim !== undefined && body.dim !== this.config.embedDim))
    )
      throw new Error('Embedding representation identity mismatch');
  }

  pinLoadedEndpoint(): void {
    if (this.lastHealthyBaseUrl) this.config = { ...this.config, embedUrl: this.lastHealthyBaseUrl };
  }

  dispose(): void {
    this.ready = false;
  }

  // ── Test hooks (not part of IEmbeddingService interface) ──────────

  /** @internal test-only: mark as ready with mock */
  _setPipelineForTest(_fn: unknown): void {
    // Compat with existing tests — just mark as ready
    this.ready = true;
    this.modelId = 'test-mock';
  }

  /** @internal test-only: set mock loader */
  _setLoaderForTest(fn: () => Promise<void>): void {
    this.loader = fn;
  }
}
