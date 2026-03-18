// F102 Phase C: EmbeddingService — ONNX local inference with MRL truncation
// AC-C2 (Qwen3 ONNX), AC-C4 (fail-open), AC-C5 (resource guards)

import type { EmbedModelInfo, IEmbeddingService } from './interfaces.js';

const MODEL_IDS: Record<string, string> = {
  'qwen3-embedding-0.6b': 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
  'multilingual-e5-small': 'Xenova/multilingual-e5-small',
};

interface EmbeddingServiceConfig {
  embedModel: string;
  embedDim: number;
  embedTimeoutMs: number;
  maxModelMemMb: number;
}

type PipelineFn = (texts: string[], opts: Record<string, unknown>) => Promise<{ data: Float32Array; dims: number[] }>;

export class EmbeddingService implements IEmbeddingService {
  private pipeline: PipelineFn | null = null;
  private config: EmbeddingServiceConfig;
  private modelRev = 'unknown';
  private loadPromise: Promise<void> | null = null; // P3: singleflight
  private loader: (() => Promise<void>) | null = null; // test hook

  constructor(config: EmbeddingServiceConfig) {
    this.config = config;
  }

  async load(): Promise<void> {
    // P3 singleflight: concurrent load() calls share the same promise
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = this._doLoad();
    try {
      await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  private async _doLoad(): Promise<void> {
    if (this.loader) {
      await this.loader();
      return;
    }

    // AC-C5: memory guard
    const memUsageMb = process.memoryUsage().rss / 1024 / 1024;
    if (memUsageMb > this.config.maxModelMemMb) {
      throw new Error(
        `Memory guard: RSS ${Math.round(memUsageMb)}MB exceeds max ${this.config.maxModelMemMb}MB — skipping model load`,
      );
    }

    const { pipeline: createPipeline } = await import('@huggingface/transformers');
    const hfModelId = MODEL_IDS[this.config.embedModel];
    if (!hfModelId) throw new Error(`Unknown model: ${this.config.embedModel}`);
    this.pipeline = (await createPipeline('feature-extraction', hfModelId, {
      dtype: 'q8',
    })) as unknown as PipelineFn;
  }

  isReady(): boolean {
    return this.pipeline !== null;
  }

  getModelInfo(): EmbedModelInfo {
    return {
      modelId: this.config.embedModel,
      modelRev: this.modelRev,
      dim: this.config.embedDim,
    };
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this.pipeline) throw new Error('EmbeddingService not ready — call load() first');

    // AC-C5: timeout guard
    const timeoutMs = this.config.embedTimeoutMs;
    const output = await Promise.race([
      this.pipeline(texts, { pooling: 'mean', normalize: false }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Embed timeout: ${timeoutMs}ms exceeded`)), timeoutMs),
      ),
    ]);

    const fullDim = output.dims[1];
    const targetDim = this.config.embedDim;
    const results: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) {
      const offset = i * fullDim;
      const slice = output.data.slice(offset, offset + targetDim);
      // MRL: truncate to targetDim, then L2 normalize
      let norm = 0;
      for (let j = 0; j < slice.length; j++) norm += slice[j] * slice[j];
      norm = Math.sqrt(norm);
      const normalized = new Float32Array(targetDim);
      if (norm > 0) {
        for (let j = 0; j < targetDim; j++) normalized[j] = slice[j] / norm;
      }
      results.push(normalized);
    }
    return results;
  }

  dispose(): void {
    this.pipeline = null;
  }

  // ── Test hooks (not part of IEmbeddingService interface) ──────────

  /** @internal test-only: set mock pipeline */
  _setPipelineForTest(fn: PipelineFn | string): void {
    if (typeof fn === 'string') {
      // sentinel value — mark as "loaded" with a dummy
      this.pipeline = (async () => ({ data: new Float32Array(0), dims: [0, 0] })) as PipelineFn;
    } else {
      this.pipeline = fn;
    }
  }

  /** @internal test-only: set mock loader for singleflight test */
  _setLoaderForTest(fn: () => Promise<void>): void {
    this.loader = fn;
  }
}
