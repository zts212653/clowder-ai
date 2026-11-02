import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { AcpAgentService } from '../src/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import { AcpProcessPool } from '../src/domains/cats/services/agents/providers/acp/AcpProcessPool.js';
import type { ToolExecutionPolicy } from '../src/domains/cats/services/types.js';

const policy: ToolExecutionPolicy = {
  mode: 'plugin_native',
  pluginInstanceId: 'instance',
  contributionId: 'own-game',
  memberSession: { sessionId: 'session', generation: 1, executionId: 'event' },
};
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'kimi-scoped-member-'));
  let ordinarySpawns = 0;
  const pool = new AcpProcessPool({ maxLiveProcesses: 1 }, {}, () => {
    ordinarySpawns++;
    throw new Error('ordinary_carrier_must_not_start');
  });
  t.after(async () => {
    await pool.closeAll();
    rmSync(root, { recursive: true, force: true });
  });
  const config = {
    catId: createCatId('kimi31-pro'),
    pool,
    poolKey: { projectPath: root, providerProfile: 'kimi' },
    projectRoot: root,
    providerName: 'kimi',
    modelName: 'kimi-code/k3.1-pro',
    nativeKimi: {
      command: 'fixture-kimi',
      args: ['acp'],
      env: {},
      projectRoot: root,
      packagePath: join(root, 'package.json'),
      accountRef: 'existing-kimi',
    },
  };
  return { service: new AcpAgentService(config), ordinarySpawns: () => ordinarySpawns };
}
test('qualified Kimi ACP enables only a member-bound plugin policy', (t) => {
  const f = fixture(t);
  assert.equal(f.service.supportsToolExecutionPolicy(policy), true);
  assert.equal(f.service.supportsToolExecutionPolicy({ mode: 'read_only' }), false);
  assert.equal(
    f.service.supportsToolExecutionPolicy({
      mode: 'plugin_native',
      pluginInstanceId: 'instance',
      contributionId: 'own-game',
    }),
    false,
  );
  assert.equal(f.service.injectsL0Natively(), false, 'ordinary Kimi identity delivery stays unchanged');
});
test('missing live member launch cannot fall through to ordinary Kimi ACP', async (t) => {
  const f = fixture(t),
    messages = [];
  for await (const message of f.service.invoke('Not authorized by prose', { toolExecutionPolicy: policy }))
    messages.push(message);
  assert.equal(f.ordinarySpawns(), 0);
  assert.ok(
    messages.some((message) => message.type === 'error' && message.errorCode === 'kimi_member_execution_failed'),
  );
  assert.equal(messages.at(-1)?.type, 'done');
});
