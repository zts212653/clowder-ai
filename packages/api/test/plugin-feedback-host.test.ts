import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginRuntimeAdmission } from '../src/domains/plugin/carrier/runtime-carrier.js';
import { DeclaredPluginUi } from '../src/domains/plugin/declared/declared-plugin-ui.js';

test('two ordinary packages discover their declared HTML resources through the same sidebar registry', () => {
  const ui = new DeclaredPluginUi();
  const admission = {
    instance: { pluginInstanceId: 'fixture' },
    packageRecord: {
      pluginId: 'official.fixture',
      manifest: {
        contributions: [
          { type: 'ui', id: 'open', kind: 'command', action: { method: 'panel' } },
          { type: 'webhook', id: 'page', path: 'panel', methods: ['GET'], action: { method: 'panel' } },
          {
            type: 'ui',
            id: 'entry',
            kind: 'slot-item',
            label: '问题反馈',
            command: 'open',
            group: 'activity-bar.bottom',
          },
          {
            type: 'ui',
            id: 'unrelated',
            kind: 'slot-item',
            label: 'Other',
            command: 'open',
            group: 'composer.quick-phrases',
          },
        ],
      },
    },
  } as unknown as PluginRuntimeAdmission;
  ui.activate(admission);
  ui.activate({
    ...admission,
    instance: { ...admission.instance, pluginInstanceId: 'second' },
    packageRecord: { ...admission.packageRecord, pluginId: 'dev.unrelated' },
  });
  assert.deepEqual(
    ui.list().map((entry) => [entry.instanceId, entry.resourcePath]),
    [
      ['fixture', 'panel'],
      ['second', 'panel'],
    ],
  );
  assert.deepEqual(ui.list('composer.quick-phrases'), []);
  ui.activate({
    ...admission,
    instance: { ...admission.instance, pluginInstanceId: 'phrases' },
    packageRecord: { ...admission.packageRecord, pluginId: 'official.quick-phrases' },
  });
  assert.deepEqual(
    ui.list('composer.quick-phrases').map(({ instanceId, resourcePath }) => [instanceId, resourcePath]),
    [['phrases', 'panel']],
  );
  ui.deactivate('phrases');
  assert.deepEqual(ui.list('composer.quick-phrases'), []);
});
