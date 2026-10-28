import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { test } from 'node:test';
import { readCapabilitiesConfig } from '../dist/config/capabilities/capability-orchestrator.js';
import { restoreDeclaredSkillPolicy } from '../dist/domains/plugin/declared/declared-static-resources.js';
import { fixture } from './helpers/alpha-plugin-runtime-fixture.js';

async function verifyReadOnlyLifecycle(t, deployment, withRuntimeRoot = true) {
  const f = await fixture(t, deployment, withRuntimeRoot);
  await f.mutate(true);
  await f.unchanged();
  const launch = await f.runtime.supervisor.resolveNativeMcpLaunch({
    mode: 'plugin_native',
    pluginInstanceId: f.installed.pluginInstanceId,
    contributionId: 'native',
  });
  assert.ok(
    launch.workingDirectory.startsWith(f.projectRoot),
    'isolated deployment retains its verified native launch',
  );
  await access(launch.args[0]);
  await f.runtime.supervisor.configRefresh(f.installed.pluginInstanceId);
  await f.unchanged();
  await f.mutate(false);
  await f.unchanged();
  await f.mutate(true);
  await f.unchanged();
  const current = (await f.composition.manager.get(f.pluginId)).plugin;
  await f.composition.manager.uninstall(f.pluginId, { expectedRevision: current.lifecycleRevision });
  await f.unchanged();
}

test('Alpha activation, refresh, disable and uninstall leave shared capabilities and skill mounts untouched', async (t) => {
  await verifyReadOnlyLifecycle(t, 'alpha');
});

test('an unlabelled linked worktree cannot publish or remove another Host capabilities', async (t) => {
  await verifyReadOnlyLifecycle(t, undefined);
});

test('a runtime-labelled linked worktree without its root cannot publish or remove another Host capabilities', async (t) => {
  await verifyReadOnlyLifecycle(t, 'runtime', false);
});

test('a persistent runtime still publishes its own managed MCP descriptor', async (t) => {
  const f = await fixture(t, 'runtime');
  await f.mutate(true);
  assert.equal(await f.runtime.supervisor.resolveMemberMcpView(), undefined);
  const config = await readCapabilitiesConfig(f.capabilityProjectRoot);
  const mcp = config.capabilities.find((entry) => entry.id === `plugin:${f.pluginId}:native`);
  assert.ok(mcp.mcpServer.workingDir.startsWith(f.projectRoot));
  assert.deepEqual(mcp.blockedCats, ['blocked-cat']);
  assert.equal(f.writes(), 1);
  assert.equal(config.capabilities.find((entry) => entry.id === 'unrelated').enabled, false);
});

test('failed Alpha activation cannot restore policy over the persistent owner configuration', async (t) => {
  const f = await fixture(t, 'alpha');
  await restoreDeclaredSkillPolicy(
    f.pluginId,
    {
      projectRoot: f.capabilityProjectRoot,
      persistCapabilities: false,
    },
    [{ id: 'guide', type: 'skill', pluginId: f.pluginId, source: 'plugin', enabled: false }],
  );
  await f.unchanged();
});
