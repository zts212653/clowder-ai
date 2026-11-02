import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertNoInitialPluginSetupFailure,
  initialPluginStates,
  REQUIRED_INITIAL_PLUGINS,
  waitForInitialPlugins,
} from './initial-plugins.mjs';

function running() {
  return {
    plugins: REQUIRED_INITIAL_PLUGINS.map((pluginId, index) => ({
      pluginId,
      pluginInstanceId: `pi_${index}`,
      installedVersion: '0.1.0-alpha.1',
      packageDigest: `sha512-fixture-${index}`,
      artifact: 'installed',
      intent: 'enabled',
      live: 'running',
    })),
  };
}
function clock(read) {
  let elapsed = 0;
  return {
    read,
    now: () => elapsed,
    pause: async (ms) => {
      elapsed += ms;
    },
    timeoutMs: 1000,
  };
}

function runningCollective() {
  const snapshot = running();
  snapshot.plugins = snapshot.plugins.filter((plugin) => plugin.pluginId !== 'official.collective-connector');
  snapshot.plugins.push({
    pluginId: 'official.collective-connector',
    pluginInstanceId: 'pi_collective_receipt_fixture',
    installedVersion: '0.1.0-alpha.22',
    packageDigest: 'sha512-rIbsKosJBKLYgTh2UbMZHvVM7FbhtQMIvr6A5GlzTghSpXkTSRGrJyFokolWEy6lJZxsGE11Qo5+Th9fvt7k/w==',
    artifact: 'installed',
    intent: 'enabled',
    live: 'running',
  });
  return snapshot;
}

test('healthy historical defaults cannot certify a missing Collective installation', async () => {
  const snapshot = runningCollective();
  snapshot.plugins = snapshot.plugins.filter((plugin) => plugin.pluginId !== 'official.collective-connector');
  await assert.rejects(waitForInitialPlugins(clock(async () => snapshot)), /did not become installed/);
});

test('Collective receipt preserves the actual installed instance, version and package digest', async () => {
  const snapshot = runningCollective();
  const result = await waitForInitialPlugins(clock(async () => snapshot));
  assert.deepEqual(
    result.plugins.find((plugin) => plugin.pluginId === 'official.collective-connector'),
    {
      ...snapshot.plugins.find((plugin) => plugin.pluginId === 'official.collective-connector'),
      activationFailed: false,
    },
  );
});

test('Collective activation failure rejects the otherwise healthy defaults on the first read', async () => {
  const snapshot = runningCollective();
  snapshot.plugins.find((plugin) => plugin.pluginId === 'official.collective-connector').activationFailed = true;
  let reads = 0;
  await assert.rejects(
    waitForInitialPlugins(
      clock(async () => {
        reads++;
        return snapshot;
      }),
    ),
    /activation failed/,
  );
  assert.equal(reads, 1);
});

test('requires dependency-bearing defaults to be installed, enabled and actually running', async () => {
  const input = running();
  const result = await waitForInitialPlugins(clock(async () => input));
  assert.equal(result.defaultInitialPluginsReady, true);
  assert.deepEqual(
    result.plugins.map((plugin) => plugin.pluginId),
    REQUIRED_INITIAL_PLUGINS,
  );
});

test('waits only through readonly startup observations, never enabling or repairing a plugin', async () => {
  const starting = running();
  starting.plugins[0].live = 'starting';
  const snapshots = [{ plugins: [] }, starting, running()];
  const observed = [];
  let reads = 0;
  await waitForInitialPlugins({ ...clock(async () => snapshots[reads++]), observe: (state) => observed.push(state) });
  assert.equal(reads, 3);
  assert.equal(observed.length, 3);
});

test('rejects a terminal default activation error immediately instead of accepting a healthy /health', async () => {
  const failed = running();
  failed.plugins[1].activationFailed = true;
  failed.plugins[1].live = 'crashed';
  let reads = 0;
  await assert.rejects(
    waitForInitialPlugins(
      clock(async () => {
        reads++;
        return failed;
      }),
    ),
    /activation failed/,
  );
  assert.equal(reads, 1);
});

test('missing, disabled, stopped or unidentified defaults cannot time out as a passing candidate', async () => {
  for (const field of ['absent', 'disabled', 'stopped', 'missing-instance', 'missing-version', 'missing-digest']) {
    const snapshot = running();
    if (field === 'absent') snapshot.plugins.pop();
    else if (field === 'disabled') snapshot.plugins[0].intent = 'disabled';
    else if (field === 'stopped') snapshot.plugins[0].live = 'stopped';
    else if (field === 'missing-instance') snapshot.plugins[0].pluginInstanceId = null;
    else if (field === 'missing-version') snapshot.plugins[0].installedVersion = null;
    else snapshot.plugins[0].packageDigest = null;
    await assert.rejects(waitForInitialPlugins(clock(async () => snapshot)), /did not become installed/);
  }
});

test('malformed and duplicate identities fail without a second API session or retries', async () => {
  assert.throws(() => initialPluginStates({}), /Invalid installed/);
  const duplicate = running();
  duplicate.plugins.push(duplicate.plugins[0]);
  assert.throws(() => initialPluginStates(duplicate), /Duplicate installed/);
  await assert.rejects(
    waitForInitialPlugins(
      clock(async () => {
        throw new Error('HTTP403');
      }),
    ),
    /HTTP403/,
  );
});

test('the exact frozen f798 failure signatures invalidate startup logs, ordinary diagnostic output does not', () => {
  for (const log of [
    '{"pluginId":"official.enterprise-workflow","error":{"type":"BuiltinPluginPackageMaterializationError","cause":{"code":"ENOENT"}}}',
    '{"msg":"[api] Initial plugin setup pending"}',
  ])
    assert.throws(() => assertNoInitialPluginSetupFailure(log), /setup failure/);
  assert.doesNotThrow(() =>
    assertNoInitialPluginSetupFailure('[api] started\n[api] Shutdown complete\n[api] exited: code=1 signal=null'),
  );
});

test('the actual command-line log gate rejects captured startup failures after normal App quit', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cat-cafe-startup-log-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'app-restore-212-stdout.log');
  const gate = fileURLToPath(new URL('./initial-plugins.mjs', import.meta.url));
  await writeFile(file, '[api] Shutdown complete\n[api] exited: code=1 signal=null\n');
  const run = () => spawnSync(process.execPath, [gate, '--logs', directory], { encoding: 'utf8', timeout: 5000 });
  assert.equal(run().status, 0);
  for (const error of ['BuiltinPluginPackageMaterializationError', 'Initial plugin setup pending']) {
    await writeFile(file, `[api] ${error}\n[api] Shutdown complete\n`);
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /default plugin setup failure/);
  }
});
