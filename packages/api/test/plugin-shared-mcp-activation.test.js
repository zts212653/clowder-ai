import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeMcpLaunches } from '../dist/domains/plugin/declared/native-mcp-launches.js';
import { NativePluginActions } from '../dist/domains/plugin/declared/native-plugin-actions.js';

test('shared discovery pins the exact contribution activation and config refresh invalidates its old URL', async () => {
  const admission = {
    instance: {
      pluginInstanceId: 'instance',
      pluginId: 'fixture',
      packageDigest: 'digest',
      activationState: 'enabled',
      lifecycleState: 'installed',
      configReadiness: 'ready',
    },
    packageRecord: {
      packageDigest: 'digest',
      packageState: 'installed',
      manifest: {
        runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' },
        contributions: [
          {
            type: 'mcp',
            id: 'ordinary',
            runtime: { transport: 'stdio', entrypoint: 'dist/mcp.js' },
            sharedFactory: { module: 'dist/server.js', export: 'create' },
          },
        ],
      },
    },
  };
  const readAdmission = async (id) =>
    structuredClone({
      ...admission,
      instance: { ...admission.instance, pluginInstanceId: id },
    });
  const actions = new NativePluginActions(readAdmission);
  actions.activate(admission, 0, async () => ({}));
  const launches = new NativeMcpLaunches(readAdmission, actions);
  const server = {
    name: 'plugin__fixture__ordinary',
    command: process.execPath,
    args: ['dist/mcp.js'],
    env: actions.environment('instance', 'ordinary'),
    workingDirectory: '/fixture',
    transport: 'stdio',
  };
  const factory = () => ({ connect: async () => {}, close: async () => {} });
  launches.activate(admission, 0, [{ contributionId: 'ordinary', server }], new Map([['ordinary', factory]]));
  const first = (await launches.memberView('/fixture')).entries[0];
  assert.ok(first.sharedHttpPath, 'ordinary members need an HTTP projection while restricted launches retain stdio');
  const url = new URL(first.sharedHttpPath, 'http://localhost');
  const resolved = await launches.resolveShared('instance', 'ordinary', url.searchParams.get('activation'));
  assert.equal(resolved.factory, factory);
  launches.activate(admission, 0, [{ contributionId: 'ordinary', server }], new Map([['ordinary', factory]]));
  assert.equal(first.isCurrent(), false);
  await assert.rejects(launches.resolveShared('instance', 'ordinary', url.searchParams.get('activation')));
  assert.notEqual((await launches.memberView()).entries[0].sharedHttpPath, first.sharedHttpPath);
  const currentPath = new URL((await launches.memberView()).entries[0].sharedHttpPath, 'http://localhost');
  const other = await readAdmission('other-instance');
  actions.activate(other, 0, async () => ({}));
  launches.activate(other, 0, [{ contributionId: 'ordinary', server }], new Map([['ordinary', factory]]));
  await assert.rejects(
    launches.resolveShared('instance', 'ordinary', currentPath.searchParams.get('activation')),
    'guessing an instance URL cannot select one of two ambiguous same-plugin activations',
  );
  launches.deactivate('other-instance');
  actions.deactivate('instance');
  assert.equal((await launches.memberView()).entries[0]?.isCurrent(), false);
});
