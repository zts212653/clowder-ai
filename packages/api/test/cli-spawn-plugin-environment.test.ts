import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { NativePluginActions } from '../src/domains/plugin/declared/native-plugin-actions.js';
import { buildChildEnv } from '../src/utils/cli-spawn.js';

const fingerprint = (env: NodeJS.ProcessEnv) =>
  createHash('sha256')
    .update(JSON.stringify(Object.entries(env).sort(([left], [right]) => left.localeCompare(right))))
    .digest('hex');

test('plugin activation leaves the model process environment stable while scoped MCP credentials stay available', (t) => {
  const instanceId = `environment-fixture-${randomUUID()}`;
  const admission = {
    instance: { pluginInstanceId: instanceId },
    packageRecord: { manifest: { contributions: [{ type: 'mcp', id: 'native' }] } },
  } as never;
  const actions = new NativePluginActions(async () => admission);
  const before = fingerprint(buildChildEnv());
  actions.activate(admission, actions.generation(instanceId), async () => {
    throw Error('No tool call expected');
  });
  const references = actions.environmentReferences(instanceId, 'native');
  const keys = Object.values(references).map((reference) => reference.slice(2, -1));
  t.after(() => {
    actions.deactivate(instanceId);
    keys.forEach((key) => {
      delete process.env[key];
    });
  });
  assert.equal(keys.length, 2);
  assert.ok(keys.every((key) => process.env[key] !== undefined));
  assert.equal(fingerprint(buildChildEnv()), before);
  assert.ok(keys.every((key) => buildChildEnv({ [key]: 'explicit-host-reference' })[key] === undefined));
  const scoped = actions.environment(instanceId, 'native');
  const child = buildChildEnv(scoped);
  assert.ok(child.CLOWDER_PLUGIN_ACTION_TOKEN === scoped.CLOWDER_PLUGIN_ACTION_TOKEN);
  assert.equal(child.CLOWDER_PLUGIN_ACTION_PATH, '/api/plugin-runtime/action');
});

test('real provider environment changes remain part of the child fingerprint', () => {
  assert.notEqual(
    fingerprint(buildChildEnv({ DSH_NATIVE_ENV_PROBE: 'first' })),
    fingerprint(buildChildEnv({ DSH_NATIVE_ENV_PROBE: 'second' })),
  );
  assert.equal(
    buildChildEnv({ CLOWDER_PLUGIN_CUSTOM_ACTION_TOKEN: 'custom-setting' }).CLOWDER_PLUGIN_CUSTOM_ACTION_TOKEN,
    'custom-setting',
  );
});
