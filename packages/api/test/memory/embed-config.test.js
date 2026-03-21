import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('resolveEmbedConfig', () => {
  it('returns defaults when no embed config provided', async () => {
    const { resolveEmbedConfig } = await import('../../dist/domains/memory/interfaces.js');
    const config = resolveEmbedConfig(undefined);
    assert.equal(config.embedMode, 'off');
    assert.equal(config.embedModel, 'qwen3-embedding-0.6b');
    assert.equal(config.embedDim, 768);
    assert.equal(config.maxModelMemMb, 800);
    assert.equal(config.embedTimeoutMs, 3000);
  });

  it('overrides individual fields', async () => {
    const { resolveEmbedConfig } = await import('../../dist/domains/memory/interfaces.js');
    const config = resolveEmbedConfig({ embedMode: 'shadow', embedDim: 128 });
    assert.equal(config.embedMode, 'shadow');
    assert.equal(config.embedDim, 128);
    assert.equal(config.embedModel, 'qwen3-embedding-0.6b'); // untouched default
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

  it('rejects invalid embedModel', async () => {
    const { resolveEmbedConfig } = await import('../../dist/domains/memory/interfaces.js');
    assert.throws(() => resolveEmbedConfig({ embedModel: 'gpt-9000' }), /invalid embedModel/i);
  });

  it('accepts multilingual-e5-small as fallback model', async () => {
    const { resolveEmbedConfig } = await import('../../dist/domains/memory/interfaces.js');
    const config = resolveEmbedConfig({ embedModel: 'multilingual-e5-small' });
    assert.equal(config.embedModel, 'multilingual-e5-small');
  });
});

describe('IEmbeddingService symbol', () => {
  it('exports IEmbeddingServiceSymbol', async () => {
    const mod = await import('../../dist/domains/memory/interfaces.js');
    assert.ok(mod.IEmbeddingServiceSymbol, 'IEmbeddingService guard');
  });
});
