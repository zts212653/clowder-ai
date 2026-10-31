// @ts-check

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('ACP pool spawn signature', () => {
  test('never reuses a volume-admitted pool for an unclassified startup', async () => {
    const { createAcpPoolSpawnSignature } = await import(
      '../../dist/domains/cats/services/agents/providers/acp/acp-pool-signature.js'
    );
    const base = {
      command: 'node',
      args: [],
      cwd: '/bootstrap',
      maxLiveProcesses: 3,
      idleTtlMs: 30000,
      transport: 'stdio',
    };
    assert.notEqual(
      createAcpPoolSpawnSignature(base),
      createAcpPoolSpawnSignature({ ...base, bootstrapIsolation: 'builtin-pi' }),
    );
  });
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

  test('changes when the derived member context policy changes', async () => {
    const { createAcpPoolSpawnSignature } = await import(
      '../../dist/domains/cats/services/agents/providers/acp/acp-pool-signature.js'
    );
    const base = {
      command: 'agent',
      args: ['--acp'],
      cwd: '/repo',
      maxLiveProcesses: 3,
      idleTtlMs: 30_000,
      transport: 'stdio',
    };
    const first = createAcpPoolSpawnSignature({
      ...base,
      contextPolicy: { windowTokens: 200_000 },
    });
    const second = createAcpPoolSpawnSignature({
      ...base,
      contextPolicy: { windowTokens: 128_000 },
    });
    assert.notEqual(first, second);
  });
});
