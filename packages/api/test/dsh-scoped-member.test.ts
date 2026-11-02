import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { inspectDshNativeLaunch } from '../src/config/native-accounts/dsh-installation.js';
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
  const root = mkdtempSync(join(tmpdir(), 'dsh-scoped-member-'));
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
    catId: createCatId('deepseek-flash'),
    pool,
    poolKey: { projectPath: root, providerProfile: 'dsh' },
    projectRoot: root,
    providerName: 'acp',
    modelName: '["deepseek-official","deepseek-flash"]',
    nativeDsh: {
      command: 'fixture-dsh',
      args: ['--profile', 'acp'],
      env: {},
      projectRoot: root,
      packagePath: join(root, 'package.json'),
      profile: 'acp',
    },
  };
  return { service: new AcpAgentService(config), ordinarySpawns: () => ordinarySpawns };
}
test('the qualified DSH carrier supports only a member-bound plugin policy', (t) => {
  const f = fixture(t);
  assert.equal(f.service.supportsToolExecutionPolicy(policy), true);
  assert.equal(
    f.service.supportsToolExecutionPolicy({
      mode: 'plugin_native',
      pluginInstanceId: 'instance',
      contributionId: 'own-game',
    }),
    false,
  );
  assert.equal(f.service.supportsToolExecutionPolicy({ mode: 'read_only' }), false);
  assert.equal(f.service.injectsL0Natively(), false, 'ordinary DSH identity delivery remains unchanged');
});
test('a member policy without the live Host launch cannot enter the ordinary ACP process pool', async (t) => {
  const f = fixture(t),
    messages = [];
  for await (const message of f.service.invoke('Not authorized by prose', { toolExecutionPolicy: policy }))
    messages.push(message);
  assert.equal(f.ordinarySpawns(), 0);
  assert.ok(
    messages.some((message) => message.type === 'error' && message.errorCode === 'dsh_member_execution_failed'),
  );
  assert.equal(messages.at(-1)?.type, 'done');
});

test('native recognition requires the qualified installed program and unchanged explicit profile arguments', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-installation-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'program'),
    entry = join(directory, 'lib/bin.js'),
    command = join(root, 'dsh');
  mkdirSync(join(directory, 'lib'), { recursive: true });
  writeFileSync(entry, '#!/usr/bin/env node\nprocess.exit(1);\n');
  chmodSync(entry, 0o700);
  symlinkSync(entry, command);
  const manifest = join(directory, 'package.json');
  writeFileSync(manifest, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.2' }));
  const input = { command, args: ['--profile', 'acp'], env: { DSH_HOME: join(root, 'native') }, projectRoot: root };
  const inspected = inspectDshNativeLaunch(input);
  assert.ok(inspected);
  assert.equal(inspected.packagePath, manifest);
  assert.equal(inspectDshNativeLaunch({ ...input, args: [...input.args, '--patch', 'untrusted.yml'] }), null);
  writeFileSync(manifest, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.3.0' }));
  assert.equal(inspectDshNativeLaunch(input), null, 'an unqualified update is not enabled by its old CLI name');
});
