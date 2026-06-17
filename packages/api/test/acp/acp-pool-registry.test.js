// @ts-check

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('ACP pool registry cleanup', () => {
  test('closes pools for profiles that are no longer active ACP members', async () => {
    const { closeStaleAcpPools } = await import(
      '../../dist/domains/cats/services/agents/providers/acp/acp-pool-registry.js'
    );
    const closed = [];
    const registry = new Map([
      [
        'active-acp',
        {
          async closeAll() {
            closed.push('active-acp');
          },
        },
      ],
      [
        'switched-to-cli',
        {
          async closeAll() {
            closed.push('switched-to-cli');
          },
        },
      ],
      [
        'deleted-member',
        {
          async closeAll() {
            closed.push('deleted-member');
          },
        },
      ],
    ]);

    const closedProfileIds = await closeStaleAcpPools(registry, new Set(['active-acp']), {
      reason: 'config-sync',
    });

    assert.deepEqual(closedProfileIds, ['switched-to-cli', 'deleted-member']);
    assert.deepEqual(closed, ['switched-to-cli', 'deleted-member']);
    assert.deepEqual([...registry.keys()], ['active-acp']);
  });
});
