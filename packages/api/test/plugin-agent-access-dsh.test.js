import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgentAccessDshConnectionTest } from '../dist/domains/plugin/agent-access-dsh.js';

test('closing the worker during launch admission prevents spawning the DSH process', async () => {
  const ref = {
    instance: {
      pluginInstanceId: 'isolated-agent-access',
      activationState: 'enabled',
      runtimeState: 'healthy',
      packageDigest: 'fixture-digest',
      lifecycleRevision: 1,
    },
  };
  const checking = Promise.withResolvers();
  const checked = Promise.withResolvers();
  let first = true;
  let pendingLaunch;
  let launches = 0;
  const run = createAgentAccessDshConnectionTest(
    {
      readCurrentAuthority() {
        if (first) {
          first = false;
          return Promise.resolve(ref);
        }
        checking.resolve();
        return checked.promise;
      },
    },
    {
      async invoke(_instance, _action, request) {
        pendingLaunch = request.launch().catch((error) => error);
        await checking.promise;
        throw new Error('fixture worker closed');
      },
    },
  );
  await assert.rejects(
    run(
      {
        command: 'isolated-fixture',
        args: [],
        cwd: process.cwd(),
        spawnFn() {
          launches += 1;
          throw new Error('unexpected late spawn');
        },
      },
      process.cwd(),
      {},
    ),
    /fixture worker closed/,
  );
  checked.resolve(ref);
  assert.match((await pendingLaunch).message, /dsh_setup_unavailable/);
  assert.equal(launches, 0);
});
