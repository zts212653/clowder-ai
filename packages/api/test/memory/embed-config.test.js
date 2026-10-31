import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('resolveEmbedConfig', () => {
  it('returns defaults when no embed config provided', async () => {
    const { resolveEmbedConfig } = await import('../../dist/domains/memory/interfaces.js');
    const config = resolveEmbedConfig(undefined);
    assert.equal(config.embedMode, 'off');
    // Sentinel fallback — overwritten as soon as the sidecar /health probe
    // reports the actual model. See interfaces.ts comment + IndexBuilder.
    assert.equal(config.embedModel, 'unknown');
    assert.equal(config.embedDim, 768);
    assert.equal(config.maxModelMemMb, 800);
    assert.equal(config.embedTimeoutMs, 3000);
  });

  it('overrides individual fields', async () => {
    const { resolveEmbedConfig } = await import('../../dist/domains/memory/interfaces.js');
    const config = resolveEmbedConfig({ embedMode: 'shadow', embedDim: 128 });
    assert.equal(config.embedMode, 'shadow');
    assert.equal(config.embedDim, 128);
    assert.equal(config.embedModel, 'unknown'); // untouched default sentinel
  });

  it('accepts embedMode=on', async () => {
    const { resolveEmbedConfig } = await import('../../dist/domains/memory/interfaces.js');
    const config = resolveEmbedConfig({ embedMode: 'on' });
    assert.equal(config.embedMode, 'on');
  });

  it('rejects invalid embedMode', async () => {
    const { resolveEmbedConfig } = await import('../../dist/domains/memory/interfaces.js');
    assert.throws(() => resolveEmbedConfig({ embedMode: 'turbo' }), /invalid embedMode/i);
  });

  it('accepts any string embedModel (whitelist removed — sidecar /health is the runtime authority)', async () => {
    const { resolveEmbedConfig } = await import('../../dist/domains/memory/interfaces.js');
    for (const id of [
      'BAAI/bge-small-zh-v1.5',
      'jinaai/jina-embeddings-v2-base-zh',
      'intfloat/multilingual-e5-large',
      'mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ',
      'gpt-9000', // even bogus ids pass — recommendation-matrix.yaml curates the user-facing list
    ]) {
      const config = resolveEmbedConfig({ embedModel: id });
      assert.equal(config.embedModel, id);
    }
  });
});

describe('IEmbeddingService symbol', () => {
  it('exports IEmbeddingServiceSymbol', async () => {
    const mod = await import('../../dist/domains/memory/interfaces.js');
    assert.ok(mod.IEmbeddingServiceSymbol, 'IEmbeddingService guard');
  });
});
