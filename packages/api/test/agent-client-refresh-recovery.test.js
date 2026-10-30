import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeclaredRuntimeContributions } from '../dist/domains/plugin/declared/declared-runtime-contributions.js';

test('a transient agent-client library refresh failure can recover on the next refresh', async () => {
  let activations = 0;
  let releases = 0;
  const contributions = new DeclaredRuntimeContributions({
    packages: {},
    configuration: {},
    agentSessionProviders: {
      async activate() {
        activations += 1;
        if (activations === 2) throw new Error('temporary provider-library refresh failure');
        return async () => {
          releases += 1;
        };
      },
    },
  });
  const admission = {
    instance: { pluginInstanceId: 'refresh-recovery-fixture' },
    packageRecord: { pluginId: 'refresh-recovery-fixture', manifest: { contributions: [] } },
    effectiveGrants: [],
  };
  await contributions.activate(admission, async () => {});
  await assert.rejects(
    contributions.refreshAgentSessionProviders(admission),
    /temporary provider-library refresh failure/,
  );
  assert.equal(releases, 1, 'the old provider must be released before its replacement is attempted');

  await contributions.refreshAgentSessionProviders(admission);
  assert.equal(activations, 3, 'a failed refresh must not disable later provider-library activation attempts');
  assert.equal(releases, 1, 'the already released provider must not be released again');

  await contributions.deactivate(admission.instance.pluginInstanceId);
  assert.equal(releases, 2, 'the recovered provider remains owned and is released during deactivation');
});
