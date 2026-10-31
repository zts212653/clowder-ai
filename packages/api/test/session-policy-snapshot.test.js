import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { resolveManagedSessionPolicySnapshot } = await import(
  '../dist/domains/cats/services/agents/invocation/session-policy-snapshot.js'
);

const basePolicy = {
  config: {
    strategy: 'handoff',
    thresholds: { warn: 0.7, action: 0.85 },
    handoff: { warnBeforeHandoff: true },
  },
  source: 'runtime_override',
  revision: 'runtime_override:test-revision',
  changedAt: 123_456,
  execution: { status: 'unavailable', missingCapabilities: ['authoritative_usage'] },
};

const capacitySnapshot = {
  capacity: {
    windowTokens: 200_000,
    inputCeilingTokens: 180_000,
    source: 'catalog',
    provenance: 'test catalog',
    actionable: true,
  },
  capability: {
    provider: 'openai',
    carrier: 'exec_json',
    reportsRuntimeWindow: true,
    authoritativeUsage: true,
    usageTelemetry: 'available',
    nativeWindowControl: true,
    nativeCompressionControl: true,
    observesCompression: true,
    reason: 'test carrier',
  },
  binding: { model: 'gpt-test', windowTokens: 200_000, source: 'native_flag' },
  memberWindowTokens: 200_000,
  model: 'gpt-test',
};

describe('#1329 invocation-owned policy snapshot', () => {
  it('refines execution evidence without changing policy identity during an invocation', () => {
    const unavailable = resolveManagedSessionPolicySnapshot({
      catId: 'test-cat',
      base: basePolicy,
      evidence: {
        capacitySnapshot,
        authoritativeUsage: false,
        sessionRotation: true,
        continuityBootstrap: true,
      },
    });
    assert.deepEqual(unavailable.execution, {
      status: 'unavailable',
      missingCapabilities: ['authoritative_usage'],
    });

    const active = resolveManagedSessionPolicySnapshot({
      catId: 'test-cat',
      base: unavailable,
      evidence: {
        capacitySnapshot,
        authoritativeUsage: true,
        sessionRotation: true,
        continuityBootstrap: true,
      },
    });
    assert.equal(active.execution.status, 'active');
    assert.equal(active.config, basePolicy.config);
    assert.equal(active.source, basePolicy.source);
    assert.equal(active.revision, basePolicy.revision);
    assert.equal(active.changedAt, basePolicy.changedAt);
  });

  it('does not treat a resolved but non-actionable catalog ceiling as handoff proof', () => {
    const provisional = resolveManagedSessionPolicySnapshot({
      catId: 'test-cat',
      base: basePolicy,
      evidence: {
        capacitySnapshot: {
          ...capacitySnapshot,
          capacity: { ...capacitySnapshot.capacity, actionable: false },
        },
        authoritativeUsage: true,
        sessionRotation: true,
        continuityBootstrap: true,
      },
    });

    assert.equal(provisional.execution.status, 'unavailable');
    assert.deepEqual(provisional.execution.missingCapabilities, ['effective_input_ceiling', 'carrier_binding']);
  });
});
