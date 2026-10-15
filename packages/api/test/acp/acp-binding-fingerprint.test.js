import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAcpPoolSpawnSignature } from '../../dist/domains/cats/services/agents/providers/acp/acp-pool-signature.js';

test('pool binding signature never exposes auth or HOME values', () => {
  const signature = createAcpPoolSpawnSignature({
    command: 'synthetic',
    args: [],
    cwd: '/fixture',
    env: { TOKEN: 'SyntheticSecret', HOME: '/synthetic/account' },
    maxLiveProcesses: 1,
    idleTtlMs: 1,
  });
  assert.match(signature, /^[a-f0-9]{64}$/);
  assert.equal(signature.includes('SyntheticSecret'), false);
});
test('same path bridge replacement invalidates capability evidence and pool identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acp-binding-'));
  try {
    const file = join(dir, 'synthetic-bridge.mjs');
    const binding = { command: process.execPath, args: [file], cwd: dir, maxLiveProcesses: 1, idleTtlMs: 1 };
    await writeFile(file, '// before');
    const first = createAcpPoolSpawnSignature(binding);
    await writeFile(file, '// after');
    assert.notEqual(createAcpPoolSpawnSignature(binding), first);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
