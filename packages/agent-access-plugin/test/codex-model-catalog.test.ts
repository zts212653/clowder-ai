import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { discoverCodexModelCatalog } from '../src/runtime/codex-model-catalog.ts';

describe('Codex model catalog discovery', () => {
  test('requests debug models through the Host launch and projects selectable metadata', async () => {
    const result = await discoverCodexModelCatalog({ cwd: '/workspace' }, async (request) => {
      assert.deepEqual(request, { args: ['debug', 'models'], cwd: '/workspace' });
      return {
        stdout: JSON.stringify({
          models: [
            {
              slug: 'gpt-test',
              display_name: 'GPT Test',
              description: 'fixture',
              visibility: 'list',
              supported_reasoning_levels: [{ effort: 'low', description: 'Fast' }],
            },
            { slug: 'hidden', visibility: 'hide' },
          ],
        }),
        code: 0,
      };
    });

    assert.equal(result.status, 'live');
    assert.deepEqual(result.models, [
      {
        value: 'gpt-test',
        label: 'GPT Test',
        description: 'fixture',
        efforts: [{ value: 'low', label: 'low', description: 'Fast' }],
      },
    ]);
  });

  test('does not turn a failed command into a live catalog', async () => {
    await assert.rejects(
      () => discoverCodexModelCatalog({}, async () => ({ stdout: '{}', code: 1 })),
      /catalog_unavailable/,
    );
  });
});
