import assert from 'node:assert/strict';
import { test } from 'node:test';
import { grantAgentAdapterDetection } from '../dist/domains/plugin/declared/agent-adapter-native-detection.js';

test('default detection grants only inspect for a matching catalog identity', () => {
  const source = {
    kind: 'catalog',
    catalogId: 'agent-kimi',
    packageName: '@clowder-ai/agent-kimi',
  };
  const request = {
    pluginId: 'official.agent-kimi',
    contributionId: 'kimi',
    pluginInstanceId: 'pi_kimi',
    packageDigest: 'verified-host-inventory-digest',
    packageProvenance: source,
    action: 'detect',
  };
  assert.deepEqual(Object.keys(grantAgentAdapterDetection(request) ?? {}), ['inspect']);
  for (const mismatch of [
    { pluginId: 'local.agent-kimi' },
    { contributionId: 'codex' },
    { packageProvenance: { ...source, catalogId: 'other' } },
    { packageProvenance: { ...source, packageName: '@other/agent-kimi' } },
    { packageProvenance: { kind: 'local-archive', packageName: source.packageName } },
    { packageProvenance: { kind: 'git', url: 'https://example.invalid/agent', packageName: source.packageName } },
    { packageProvenance: undefined },
    { action: 'quota' },
    { action: 'openSession' },
  ]) {
    assert.equal(grantAgentAdapterDetection({ ...request, ...mismatch }), undefined);
  }
});
