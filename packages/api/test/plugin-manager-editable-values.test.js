import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HostPluginConfigurationService } from '../dist/domains/plugin/manager/plugin-manager-configuration.js';
import { writePluginConfig } from '../dist/domains/plugin/plugin-config-store.js';

test('installed Manager configuration exposes complete editable values and masks declared secrets', async (t) => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'plugin-editable-values-'));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  const pluginId = 'example.installed';
  writePluginConfig(projectRoot, pluginId, [
    { name: 'labels', value: 'acceptance-bot,second-bot' },
    { name: 'token', value: 'test-only-secret-value' },
    { name: 'undeclared', value: 'must-not-be-exposed' },
  ]);
  const service = new HostPluginConfigurationService({
    projectRoot,
    inventory: {
      readCurrentAuthority: async (requestedPluginId) =>
        requestedPluginId === pluginId
          ? {
              instance: { pluginId, lifecycleState: 'installed', packageDigest: 'digest' },
              packageRecord: {
                packageDigest: 'digest',
                manifest: {
                  configuration: [
                    { key: 'labels', label: 'Labels', kind: 'text', required: false },
                    { key: 'token', label: 'Token', kind: 'secret', required: true },
                  ],
                },
              },
            }
          : undefined,
    },
  });
  const fields = await service.fields(pluginId);
  assert.equal(fields.find((field) => field.key === 'labels').currentValue, 'acceptance-bot,second-bot');
  assert.equal(fields.find((field) => field.key === 'token').currentValue, '••••••');
  assert.equal(fields.length, 2);
  assert.equal(JSON.stringify(fields).includes('test-only-'), false);
  assert.equal(JSON.stringify(fields).includes('must-not-be-exposed'), false);
  assert.deepEqual(await service.readActionInput(pluginId), { labels: 'acceptance-bot,second-bot' });
});

test('saving a thread configuration field requires every chosen id to be an existing conversation', async () => {
  const pluginId = 'example.threads';
  const service = new HostPluginConfigurationService({
    projectRoot: mkdtempSync(join(tmpdir(), 'plugin-thread-values-')),
    threads: { get: async (id) => (id === 'thread-a' ? { id } : null) },
    inventory: {
      readCurrentAuthority: async () => ({
        instance: { pluginId, pluginInstanceId: 'instance', lifecycleState: 'installed', packageDigest: 'digest' },
        packageRecord: {
          packageDigest: 'digest',
          manifest: {
            configuration: [{ key: 'threadIds', label: 'Threads', kind: 'thread', multiple: true, required: false }],
          },
        },
      }),
    },
  });
  await assert.rejects(
    service.configure(pluginId, 'instance', {
      expectedRevision: 0,
      updates: [{ key: 'threadIds', value: '["thread-a","thread-gone"]' }],
    }),
    /threadIds is not a conversation/,
  );
});
