import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('F293 RuntimeRoutingCandidateCatalogSource', () => {
  test('derives deterministic bindings without guessing quota pools or account identity', async () => {
    const { RuntimeRoutingCandidateCatalogSource } = await import(
      '../dist/domains/routing-context/RuntimeRoutingCandidateCatalogSource.js'
    );
    const base = {
      name: 'test',
      displayName: 'Test',
      avatar: 'test',
      color: { primary: '#000', secondary: '#fff' },
      mentionPatterns: [],
      mcpSupport: false,
      roleDescription: 'test',
      personality: 'test',
    };
    const configs = {
      sol: { ...base, id: 'sol', clientId: 'openai', defaultModel: 'gpt-5.6-sol' },
      proxy: {
        ...base,
        id: 'proxy',
        clientId: 'openai',
        provider: 'openrouter',
        defaultModel: 'vendor/model',
      },
    };
    const source = new RuntimeRoutingCandidateCatalogSource({ getConfigs: () => configs });
    const first = await source.load({ ownerId: 'owner', targetCatIds: ['sol'] });
    const second = await source.load({ ownerId: 'owner' });
    assert.equal(first.catalogRevision, second.catalogRevision);
    assert.deepEqual(first.candidates, [{ v: 1, catId: 'sol', providerId: 'openai', provenQuotaPools: [] }]);
    assert.deepEqual(second.candidates, [
      { v: 1, catId: 'proxy', providerId: 'openrouter', provenQuotaPools: [] },
      { v: 1, catId: 'sol', providerId: 'openai', provenQuotaPools: [] },
    ]);
  });
});
