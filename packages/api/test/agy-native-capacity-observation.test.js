import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import {
  applyUsageEvidenceToInvocationSnapshot,
  resolveInvocationCapacitySnapshot,
} from '../dist/domains/cats/services/agents/invocation/invocation-capacity-snapshot.js';
import { resolveManagedSessionPolicySnapshot } from '../dist/domains/cats/services/agents/invocation/session-policy-snapshot.js';
import { AgyNativeAgentService } from '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js';
import { agyCapacityFixture as fixture } from './helpers/agy-capacity-fixture.js';

test('an effort override records its verified effective model without lending evidence to the configured model', async (t) => {
  const f = fixture(t);
  const low = await f.run(f.makeService(), { checkpoint: true, reasoningEffortOverride: 'low' });
  assert.equal(low.errorCode, undefined);
  assert.equal(low.metadata.model, 'gemini-4-carbon-low');
  assert.equal(low.metadata.contextWindowObservation?.model, 'gemini-4-carbon-low');
  const inherited = await f.run(f.makeService());
  assert.equal(inherited.errorCode, undefined);
  assert.equal(inherited.metadata.contextWindowObservation, undefined);
});

test('a verified automatic checkpoint supplies a durable observed ceiling for that exact native scope', async (t) => {
  const f = fixture(t);
  const first = await f.run(f.makeService(), { checkpoint: true });
  assert.equal(first.errorCode, undefined);
  const observation = first.metadata.contextWindowObservation;
  assert.equal(
    observation?.windowTokens,
    511499,
    'use checkpoint input plus cached input, not catalog or binary defaults',
  );
  assert.equal(observation.cliVersion, '1.5.9');
  assert.equal(observation.model, f.model);
  assert.match(observation.evidenceRef, /agy_native_checkpoint:capacity-session:1/);
  assert.match(observation.scopeId, /^[a-f0-9]{64}$/);
  const resumed = await f.run(f.makeService());
  assert.equal(resumed.metadata.contextWindowObservation?.windowTokens, 511499, 'survives service reconstruction');
  const larger = await f.run(f.makeService(), { checkpoint: true, tokens: 525714 });
  assert.equal(
    larger.metadata.contextWindowObservation.windowTokens,
    511499,
    'later larger samples cannot inflate the observed operational ceiling',
  );
  const smaller = await f.run(f.makeService(), { checkpoint: true, tokens: 500000 });
  assert.equal(smaller.metadata.contextWindowObservation.windowTokens, 500000);
  assert.equal(
    (await f.run(f.makeService({ model: 'gemini-4-argon-high' }))).metadata.contextWindowObservation,
    undefined,
  );
  assert.equal(
    (await f.run(f.makeService({ profileId: 'another-profile' }))).metadata.contextWindowObservation,
    undefined,
  );
  f.setGrant('synthetic-refresh-grant-B');
  assert.equal(
    (await f.run(f.makeService())).metadata.contextWindowObservation,
    undefined,
    're-login in the same credential directory cannot borrow the old grant',
  );
  f.setGrant('synthetic-refresh-grant-A');
  f.setVersion('1.6.0');
  assert.equal(
    (await f.run(f.makeService())).metadata.contextWindowObservation,
    undefined,
    'an upgraded CLI needs its own evidence',
  );
});

for (const variant of [
  { checkpoint: false },
  { checkpoint: true, prompt: '/compact' },
  { checkpoint: true, state: 'ACTIVE' },
  { checkpoint: true, state: 'ERROR' },
  { checkpoint: true, error: true },
  { checkpoint: true, failure: 'undeclared' },
  { checkpoint: true, failure: 'transport' },
  { checkpoint: true, tokens: 0 },
  { checkpoint: true, tokens: -1 },
])
  test(`non-evidence cannot create an automatic checkpoint ceiling: ${JSON.stringify(variant)}`, async (t) => {
    const f = fixture(t);
    const terminal = await f.run(f.makeService(), variant);
    if (variant.failure)
      assert.equal(terminal.errorCode, variant.failure === 'undeclared' ? 'AGY_UNEXPECTED_TOOL' : 'AGY_NATIVE_FAILED');
    assert.equal((await f.run(f.makeService())).metadata.contextWindowObservation, undefined);
  });

test('a damaged persisted sample remains unknown instead of turning into actionable capacity', async (t) => {
  const f = fixture(t);
  const first = await f.run(f.makeService(), { checkpoint: true });
  const scope = first.metadata.contextWindowObservation.scopeId;
  writeFileSync(join(f.root, 'profiles/fixture/.gemini/config/.cat-cafe-context-capacity', scope, '511499.json'), '{}');
  assert.equal((await f.run(f.makeService())).metadata.contextWindowObservation, undefined);
});

test('the real invocation snapshot binds observed capacity without claiming a provider configuration or native report', () => {
  const catId = 'test-f325-observed-capacity';
  const savedConfigs = catRegistry.getAllConfigs();
  catRegistry.register(catId, {
    id: catId,
    name: 'fixture',
    displayName: 'fixture',
    mentionPatterns: [],
    clientId: 'google',
    defaultModel: 'gemini-4-carbon-high',
    mcpSupport: false,
    avatar: '/fixture.svg',
    color: { primary: '#123456', secondary: '#ffffff' },
  });
  try {
    const service = new AgyNativeAgentService({ catId, profile: { enabled: true, model: 'gemini-4-carbon-high' } });
    const before = resolveInvocationCapacitySnapshot({ catId, service });
    assert.equal(before.capacity.actionable, false);
    const observedWindow = {
      provider: 'google',
      carrier: 'agy_stream_json',
      model: before.model,
      cliVersion: '1.5.9',
      scopeId: 'a'.repeat(64),
      windowTokens: 511499,
      observedAt: Date.now(),
      evidenceRef: 'agy_native_checkpoint:fixture:1',
    };
    const after = applyUsageEvidenceToInvocationSnapshot({
      snapshot: before,
      catId,
      capability: service.contextCapability(),
      observedWindow,
    });
    assert.equal(after.capacity.source, 'observed');
    assert.equal(after.capacity.windowTokens, 511499);
    assert.equal(after.capacity.inputCeilingTokens, 495499);
    assert.equal(after.capacity.actionable, true);
    assert.equal(after.binding.source, 'observed');
    assert.equal(after.nativeWindowTokens, null);
    assert.equal(after.capability.reportsRuntimeWindow, false);
    assert.equal(
      applyUsageEvidenceToInvocationSnapshot({
        snapshot: { ...before, model: undefined },
        catId,
        capability: service.contextCapability(),
        observedWindow: { ...observedWindow, model: undefined },
      }).capacity.actionable,
      false,
    );
    const policy = resolveManagedSessionPolicySnapshot({
      catId,
      evidence: { capacitySnapshot: after, authoritativeUsage: true, sessionRotation: true, continuityBootstrap: true },
      base: {
        config: { strategy: 'handoff' },
        source: 'default',
        revision: 0,
        changedAt: 0,
        execution: { status: 'unavailable', missingCapabilities: [] },
      },
    });
    assert.equal(policy.execution.status, 'active');
    const manual = {
      ...before,
      memberWindowTokens: 200000,
      capacity: {
        ...before.capacity,
        source: 'manual',
        windowTokens: 200000,
        inputCeilingTokens: 184000,
        actionable: true,
      },
    };
    const capped = applyUsageEvidenceToInvocationSnapshot({
      snapshot: manual,
      catId,
      capability: service.contextCapability(),
      observedWindow,
    });
    assert.equal(capped.capacity.windowTokens, 200000, 'operator caps still constrain observed ceilings');
    const catalog = {
      ...before,
      capacity: { ...before.capacity, source: 'catalog', windowTokens: 400000, inputCeilingTokens: 384000 },
    };
    assert.equal(
      applyUsageEvidenceToInvocationSnapshot({
        snapshot: catalog,
        catId,
        capability: service.contextCapability(),
        observedWindow,
      }).capacity.windowTokens,
      400000,
    );
    for (const bad of [
      { ...observedWindow, model: 'another-model' },
      { ...observedWindow, windowTokens: Infinity },
      { ...observedWindow, windowTokens: -1 },
      { ...observedWindow, evidenceRef: '' },
    ]) {
      assert.equal(
        applyUsageEvidenceToInvocationSnapshot({
          snapshot: before,
          catId,
          capability: service.contextCapability(),
          observedWindow: bad,
        }).capacity.actionable,
        false,
      );
    }
  } finally {
    catRegistry.reset();
    for (const [id, config] of Object.entries(savedConfigs)) catRegistry.register(id, config);
  }
});
