import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FilePluginCapabilityKeyring } from '../src/domains/plugin/capability-token/plugin-capability-token.js';
import { NativePluginActions } from '../src/domains/plugin/declared/native-plugin-actions.js';

const admission = () => ({
  instance: {
    pluginInstanceId: 'instance',
    pluginId: 'fixture.plugin',
    packageDigest: 'digest',
    lifecycleRevision: 1,
    activationState: 'enabled',
    lifecycleState: 'installed',
    configReadiness: 'ready',
    runtimeState: 'healthy',
  },
  packageRecord: {
    pluginId: 'fixture.plugin',
    packageDigest: 'digest',
    packageState: 'installed',
    manifest: {
      pluginId: 'fixture.plugin',
      version: '1.0.0',
      contractVersion: '0.3.1-candidate.1',
      name: 'fixture',
      runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' },
      contributions: [{ type: 'mcp', id: 'native', runtime: { transport: 'stdio', entrypoint: 'dist/mcp.js' } }],
      features: [{ id: 'main', name: 'Main', resources: [], contributions: [{ type: 'mcp', id: 'native' }] }],
    },
  },
});

const caller = () => ({
  catId: 'cat',
  threadId: 'thread',
  userId: 'owner',
  invocationId: 'invocation',
  assertCurrent: async () => {},
});

test('native action credentials live in an activation file and old activation/boot tokens never revive', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-native-capability-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keyring = new FilePluginCapabilityKeyring({ path: join(root, 'capability-keyring.json') });
  const current = admission();
  const actions = new NativePluginActions(async () => current as never, {
    tokens: keyring,
    credentialRoot: join(root, 'native-credentials'),
    bootId: 'boot-a',
  });

  await actions.activate(current as never, 0, async () => 'first');
  const environment = actions.environment('instance', 'native');
  assert.equal(environment.CLOWDER_PLUGIN_ACTION_TOKEN, undefined);
  assert.ok(environment.CLOWDER_PLUGIN_ACTION_CREDENTIAL_FILE);
  const first = JSON.parse(await readFile(environment.CLOWDER_PLUGIN_ACTION_CREDENTIAL_FILE!, 'utf8')) as {
    token: string;
    activationId: string;
    bootId: string;
  };
  assert.equal(first.bootId, 'boot-a');
  assert.equal(await actions.call(first.token, 'native.run', {}, caller()), 'first');

  actions.deactivate('instance');
  await assert.rejects(actions.call(first.token, 'native.run', {}, caller()), /not active/);
  await assert.rejects(access(environment.CLOWDER_PLUGIN_ACTION_CREDENTIAL_FILE!));

  await actions.activate(current as never, actions.generation('instance'), async () => 'second');
  const secondFile = actions.environment('instance', 'native').CLOWDER_PLUGIN_ACTION_CREDENTIAL_FILE!;
  assert.notEqual(
    secondFile,
    environment.CLOWDER_PLUGIN_ACTION_CREDENTIAL_FILE,
    'each activation must own a distinct credential path so stale refresh cleanup cannot remove its successor',
  );
  const second = JSON.parse(await readFile(secondFile, 'utf8')) as { token: string; activationId: string };
  assert.notEqual(second.activationId, first.activationId);
  assert.notEqual(second.token, first.token);
  assert.equal(await actions.call(second.token, 'native.run', {}, caller()), 'second');
  await assert.rejects(actions.call(first.token, 'native.run', {}, caller()), /not active/);

  const restarted = new NativePluginActions(async () => current as never, {
    tokens: keyring,
    credentialRoot: join(root, 'native-credentials'),
    bootId: 'boot-b',
  });
  await restarted.activate(current as never, 0, async () => 'restarted');
  await assert.rejects(restarted.call(second.token, 'native.run', {}, caller()), /not active/);
});

test('a live native transport renews its file before expiry and retires the grace token', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-native-renewal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = admission();
  const actions = new NativePluginActions(async () => current as never, {
    tokens: new FilePluginCapabilityKeyring({ path: join(root, 'capability-keyring.json') }),
    credentialRoot: join(root, 'native-credentials'),
    bootId: 'boot-renewal',
    nativeTtlSeconds: 2,
    refreshGraceMs: 10,
  });
  await actions.activate(current as never, 0, async () => 'active');
  const file = actions.environment('instance', 'native').CLOWDER_PLUGIN_ACTION_CREDENTIAL_FILE!;
  const first = (JSON.parse(await readFile(file, 'utf8')) as { token: string }).token;
  let second = first;
  const deadline = Date.now() + 2_000;
  while (second === first && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    second = (JSON.parse(await readFile(file, 'utf8')) as { token: string }).token;
  }
  assert.notEqual(second, first, 'credential file must rotate before the original token expires');
  assert.equal(await actions.call(second, 'native.run', {}, caller()), 'active');
  await new Promise((resolve) => setTimeout(resolve, 30));
  await assert.rejects(actions.call(first, 'native.run', {}, caller()), /not active/);
});
