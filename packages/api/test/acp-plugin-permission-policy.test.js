import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAcpPoolSpawnSignature } from '../dist/domains/cats/services/agents/providers/acp/acp-pool-signature.js';

test('changing an explicit ACP plugin permission policy invalidates the existing process pool', () => {
  const input = { command: 'codeagent', args: ['--acp'], cwd: '/project', maxLiveProcesses: 1, idleTtlMs: 60000 };
  assert.notEqual(
    createAcpPoolSpawnSignature({ ...input, permissionPolicy: 'deny' }),
    createAcpPoolSpawnSignature({ ...input, permissionPolicy: 'auto_allow' }),
  );
});
