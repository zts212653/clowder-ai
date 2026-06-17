// @ts-check

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('ACP pool spawn signature', () => {
  test('changes when supportsMultiplexing changes', async () => {
    const { createAcpPoolSpawnSignature } = await import(
      '../../dist/domains/cats/services/agents/providers/acp/acp-pool-signature.js'
    );
    const base = {
      command: 'agent',
      args: ['--acp'],
      cwd: '/repo',
      env: { TOKEN: 'x' },
      openCodeRuntimeConfig: null,
      maxLiveProcesses: 3,
      idleTtlMs: 30_000,
      transport: 'stdio',
    };

    const singleFlight = createAcpPoolSpawnSignature({ ...base, supportsMultiplexing: false });
    const multiplexed = createAcpPoolSpawnSignature({ ...base, supportsMultiplexing: true });
    const omitted = createAcpPoolSpawnSignature(base);

    assert.notEqual(singleFlight, multiplexed);
    assert.equal(omitted, singleFlight);
  });
});
