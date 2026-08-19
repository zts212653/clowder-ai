import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

const TEST_CAT_ID = 'capacity-owner-test';

describe('#1208 invocation-owned capacity snapshot', () => {
  let resolveInvocationCapacitySnapshot;
  let applyContextBindingToInvocationSnapshot;
  let applyUsageEvidenceToInvocationSnapshot;
  let applyReportedWindowToInvocationSnapshot;
  let applyActiveSessionCapacityPin;
  let resolvePreInvocationCapacityAction;
  let sealBeforeInvocationIfNeeded;
  let SessionChainStore;
  let CodexAgentService;
  let savedConfigs;

  function registerTestCat(contextWindow, defaultModel = 'gpt-5.4') {
    catRegistry.reset();
    catRegistry.register(TEST_CAT_ID, {
      id: TEST_CAT_ID,
      name: TEST_CAT_ID,
      displayName: 'Capacity Owner Test',
      avatar: '🐱',
      color: { primary: '#000', secondary: '#fff' },
      mentionPatterns: ['@capacity-owner-test'],
      clientId: 'openai',
      accountRef: 'codex-oauth',
      provider: 'openai',
      defaultModel,
      contextWindow,
      mcpSupport: false,
      roleDescription: 'test',
      personality: 'test',
    });
  }

  before(async () => {
    ({
      resolveInvocationCapacitySnapshot,
      applyContextBindingToInvocationSnapshot,
      applyUsageEvidenceToInvocationSnapshot,
      applyReportedWindowToInvocationSnapshot,
      applyActiveSessionCapacityPin,
      resolvePreInvocationCapacityAction,
      sealBeforeInvocationIfNeeded,
    } = await import('../../dist/domains/cats/services/agents/invocation/invocation-capacity-snapshot.js'));
    ({ SessionChainStore } = await import('../../dist/domains/cats/services/stores/ports/SessionChainStore.js'));
    ({ CodexAgentService } = await import('../../dist/domains/cats/services/agents/providers/CodexAgentService.js'));
    savedConfigs = catRegistry.getAllConfigs();
    registerTestCat(200_000);
  });

  after(() => {
    catRegistry.reset();
    for (const [id, config] of Object.entries(savedConfigs)) catRegistry.register(id, config);
  });

  function service() {
    return {
      async *invoke() {},
      contextCapability() {
        return {
          provider: 'openai',
          carrier: 'exec_json',
          reportsRuntimeWindow: true,
          authoritativeUsage: true,
          usageTelemetry: 'available',
          nativeWindowControl: true,
          nativeCompressionControl: true,
          observesCompression: true,
          reason: 'test carrier',
        };
      },
    };
  }

  function activePolicySnapshot(config) {
    return {
      config,
      source: 'runtime_override',
      revision: 'test-policy-revision',
      changedAt: 0,
      execution: { status: 'active', missingCapabilities: [] },
    };
  }

  it('keeps an active session at its pinned capacity when a later invocation requests an increase', async () => {
    const store = new SessionChainStore();
    const firstResolved = await resolveInvocationCapacitySnapshot({
      catId: TEST_CAT_ID,
      service: service(),
    });
    const active = store.create({
      cliSessionId: 'cli-capacity-owner',
      threadId: 'thread-capacity-owner',
      catId: TEST_CAT_ID,
      userId: 'user-1',
    });
    const first = await applyActiveSessionCapacityPin({
      snapshot: firstResolved,
      catId: TEST_CAT_ID,
      threadId: 'thread-capacity-owner',
      sessionChainStore: store,
    });
    assert.equal(first.capacity.windowTokens, 200_000);
    assert.equal(store.get(active.id)?.capacityPin?.windowTokens, 200_000);

    registerTestCat(1_000_000);

    const next = await applyActiveSessionCapacityPin({
      snapshot: await resolveInvocationCapacitySnapshot({
        catId: TEST_CAT_ID,
        service: service(),
      }),
      catId: TEST_CAT_ID,
      threadId: 'thread-capacity-owner',
      sessionChainStore: store,
    });
    assert.equal(next.capacity.windowTokens, 200_000);
    assert.match(next.capacity.provenance, /session-pinned/);
    assert.equal(store.get(active.id)?.capacityPin?.windowTokens, 200_000);
  });

  it('shrinks the active session pin when a later invocation resolves a smaller capacity', async () => {
    registerTestCat(1_000_000);
    const store = new SessionChainStore();
    const active = store.create({
      cliSessionId: 'cli-capacity-shrink',
      threadId: 'thread-capacity-shrink',
      catId: TEST_CAT_ID,
      userId: 'user-1',
    });
    const first = await applyActiveSessionCapacityPin({
      snapshot: await resolveInvocationCapacitySnapshot({
        catId: TEST_CAT_ID,
        service: service(),
      }),
      catId: TEST_CAT_ID,
      threadId: 'thread-capacity-shrink',
      sessionChainStore: store,
    });
    assert.equal(first.capacity.windowTokens, 1_000_000);

    registerTestCat(256_000);
    const next = await applyActiveSessionCapacityPin({
      snapshot: await resolveInvocationCapacitySnapshot({
        catId: TEST_CAT_ID,
        service: service(),
      }),
      catId: TEST_CAT_ID,
      threadId: 'thread-capacity-shrink',
      sessionChainStore: store,
    });
    assert.equal(next.capacity.windowTokens, 256_000);
    assert.equal(store.get(active.id)?.capacityPin?.windowTokens, 256_000);
  });

  it('allows a larger capacity after the pinned session rolls over', async () => {
    registerTestCat(200_000);
    const store = new SessionChainStore();
    const oldSession = store.create({
      cliSessionId: 'cli-capacity-old',
      threadId: 'thread-capacity-rollover',
      catId: TEST_CAT_ID,
      userId: 'user-1',
    });
    await applyActiveSessionCapacityPin({
      snapshot: await resolveInvocationCapacitySnapshot({ catId: TEST_CAT_ID, service: service() }),
      catId: TEST_CAT_ID,
      threadId: 'thread-capacity-rollover',
      sessionChainStore: store,
    });
    store.update(oldSession.id, { status: 'sealed' });

    registerTestCat(1_000_000);
    const newSession = store.create({
      cliSessionId: 'cli-capacity-new',
      threadId: 'thread-capacity-rollover',
      catId: TEST_CAT_ID,
      userId: 'user-1',
    });
    const next = await applyActiveSessionCapacityPin({
      snapshot: await resolveInvocationCapacitySnapshot({ catId: TEST_CAT_ID, service: service() }),
      catId: TEST_CAT_ID,
      threadId: 'thread-capacity-rollover',
      sessionChainStore: store,
    });

    assert.equal(next.capacity.windowTokens, 1_000_000);
    assert.equal(store.get(newSession.id)?.capacityPin?.windowTokens, 1_000_000);
  });

  it('keeps Auto refinement bound to the member inputs captured for this invocation', async () => {
    registerTestCat(undefined);
    const snapshot = await resolveInvocationCapacitySnapshot({
      catId: TEST_CAT_ID,
      service: service(),
    });

    // A concurrent catalog edit belongs to the next invocation, not this one.
    registerTestCat(256_000);
    const refined = applyReportedWindowToInvocationSnapshot({
      snapshot,
      catId: TEST_CAT_ID,
      reportedWindowSize: 1_000_000,
    });

    assert.equal(refined.capacity.source, 'reported');
    assert.equal(refined.capacity.windowTokens, 1_000_000);
  });

  it('uses the effective runtime model override for Auto catalog resolution', async () => {
    registerTestCat(undefined);
    const envKey = 'CAT_CAPACITY_OWNER_TEST_MODEL';
    const previous = process.env[envKey];
    process.env[envKey] = 'gpt-5.3';

    try {
      const snapshot = await resolveInvocationCapacitySnapshot({
        catId: TEST_CAT_ID,
        service: service(),
      });

      assert.equal(snapshot.model, 'gpt-5.3');
      assert.equal(snapshot.capacity.source, 'catalog');
      assert.equal(snapshot.capacity.windowTokens, 128_000);
    } finally {
      if (previous === undefined) delete process.env[envKey];
      else process.env[envKey] = previous;
    }
  });

  it('does not treat generic provider capabilities as proof of an invocation-bound catalog window', async () => {
    registerTestCat(undefined, 'claude-opus-4-6');
    const snapshot = await resolveInvocationCapacitySnapshot({
      catId: TEST_CAT_ID,
      service: {
        async *invoke() {},
        contextCapability() {
          return {
            provider: 'opencode',
            carrier: 'run_json',
            reportsRuntimeWindow: false,
            authoritativeUsage: true,
            usageTelemetry: 'available',
            nativeWindowControl: true,
            nativeCompressionControl: true,
            observesCompression: false,
            reason: 'test OpenCode carrier',
          };
        },
      },
    });

    assert.equal(snapshot.capacity.source, 'catalog');
    assert.equal(snapshot.capacity.actionable, false);
    assert.deepEqual(
      resolvePreInvocationCapacityAction({
        snapshot,
        contextHealth: {
          usedTokens: 850_000,
          windowTokens: snapshot.capacity.windowTokens,
          fillRatio: 850_000 / snapshot.capacity.inputCeilingTokens,
          source: 'exact',
          usedFrom: 'last_turn',
          measuredAt: Date.now(),
        },
        hybridProgressCount: null,
        policySnapshot: activePolicySnapshot({
          strategy: 'handoff',
          thresholds: { warn: 0.5, action: 0.8 },
        }),
      }),
      { type: 'none' },
    );
  });

  it('makes a catalog window actionable when the concrete carrier proves the exact model and window', async () => {
    registerTestCat(undefined, 'claude-opus-4-6');
    const snapshot = await resolveInvocationCapacitySnapshot({
      catId: TEST_CAT_ID,
      service: {
        async *invoke() {},
        contextCapability() {
          return {
            provider: 'opencode',
            carrier: 'acp',
            reportsRuntimeWindow: false,
            authoritativeUsage: true,
            usageTelemetry: 'available',
            nativeWindowControl: true,
            nativeCompressionControl: false,
            observesCompression: false,
            reason: 'test OpenCode ACP carrier',
          };
        },
        contextBinding() {
          return {
            model: 'claude-opus-4-6',
            windowTokens: 1_000_000,
            source: 'service_spawn',
          };
        },
      },
    });

    assert.equal(snapshot.capacity.source, 'catalog');
    assert.equal(snapshot.capacity.actionable, true);
    assert.deepEqual(snapshot.binding, {
      model: 'claude-opus-4-6',
      windowTokens: 1_000_000,
      source: 'service_spawn',
    });
    assert.deepEqual(
      resolvePreInvocationCapacityAction({
        snapshot,
        contextHealth: {
          usedTokens: 850_000,
          windowTokens: snapshot.capacity.windowTokens,
          fillRatio: 850_000 / snapshot.capacity.inputCeilingTokens,
          source: 'exact',
          usedFrom: 'last_turn',
          measuredAt: Date.now(),
        },
        hybridProgressCount: null,
        policySnapshot: activePolicySnapshot({
          strategy: 'handoff',
          thresholds: { warn: 0.5, action: 0.8 },
        }),
      }),
      { type: 'seal', reason: 'threshold' },
    );
  });

  it('binds the Codex exec-json catalog window before pre-invocation lifecycle checks', async () => {
    registerTestCat(undefined, 'gpt-5.3');
    const snapshot = await resolveInvocationCapacitySnapshot({
      catId: TEST_CAT_ID,
      service: new CodexAgentService({
        catId: TEST_CAT_ID,
        model: 'gpt-5.3',
        carrierMode: 'exec_json',
      }),
    });

    assert.equal(snapshot.capacity.source, 'catalog');
    assert.equal(snapshot.capacity.windowTokens, 128_000);
    assert.equal(snapshot.capacity.actionable, true);
    assert.deepEqual(snapshot.binding, {
      model: 'gpt-5.3',
      windowTokens: 128_000,
      source: 'invocation_config',
    });
    assert.deepEqual(
      resolvePreInvocationCapacityAction({
        snapshot,
        contextHealth: {
          usedTokens: 120_000,
          windowTokens: 1_000_000,
          fillRatio: 0.12,
          source: 'exact',
          usedFrom: 'context',
          measuredAt: Date.now(),
        },
        hybridProgressCount: null,
        policySnapshot: activePolicySnapshot({
          strategy: 'handoff',
          thresholds: { warn: 0.75, action: 0.85 },
        }),
      }),
      { type: 'seal', reason: 'budget_exhausted' },
    );
  });

  it('keeps Codex app-server catalog capacity provisional without a native window binding', async () => {
    registerTestCat(undefined, 'gpt-5.3');
    const snapshot = await resolveInvocationCapacitySnapshot({
      catId: TEST_CAT_ID,
      service: new CodexAgentService({
        catId: TEST_CAT_ID,
        model: 'gpt-5.3',
        carrierMode: 'app_server',
      }),
    });

    assert.equal(snapshot.capacity.source, 'catalog');
    assert.equal(snapshot.capacity.actionable, false);
    assert.equal(snapshot.binding, undefined);
  });

  it('promotes the invocation snapshot when same-carrier usage telemetry becomes available', async () => {
    registerTestCat(undefined, 'claude-opus-4-6');
    const conditionalCapability = {
      provider: 'opencode',
      carrier: 'acp',
      reportsRuntimeWindow: false,
      authoritativeUsage: true,
      usageTelemetry: 'conditional',
      nativeWindowControl: true,
      nativeCompressionControl: false,
      observesCompression: false,
      reason: 'waiting for the first ACP usage_update event',
    };
    const snapshot = await resolveInvocationCapacitySnapshot({
      catId: TEST_CAT_ID,
      service: {
        async *invoke() {},
        contextCapability: () => conditionalCapability,
        contextBinding: () => ({
          model: 'claude-opus-4-6',
          windowTokens: 1_000_000,
          source: 'service_spawn',
        }),
      },
    });
    assert.equal(snapshot.capacity.actionable, false, 'catalog binding stays provisional before telemetry');

    const promoted = applyUsageEvidenceToInvocationSnapshot({
      snapshot,
      catId: TEST_CAT_ID,
      capability: {
        ...conditionalCapability,
        usageTelemetry: 'available',
        reason: 'ACP usage_update observed for this service process',
      },
    });

    assert.equal(promoted.capacity.source, 'catalog');
    assert.equal(promoted.capacity.actionable, true);
    assert.equal(promoted.capability.usageTelemetry, 'available');
    assert.match(promoted.capacity.provenance, /service_spawn/);
  });

  it('keeps a catalog window provisional when an invocation binding proves a different window', async () => {
    registerTestCat(undefined, 'claude-opus-4-6');
    const snapshot = await resolveInvocationCapacitySnapshot({
      catId: TEST_CAT_ID,
      service: {
        async *invoke() {},
        contextCapability() {
          return {
            provider: 'opencode',
            carrier: 'run_json',
            reportsRuntimeWindow: false,
            authoritativeUsage: true,
            usageTelemetry: 'available',
            nativeWindowControl: true,
            nativeCompressionControl: true,
            observesCompression: false,
            reason: 'test OpenCode carrier',
          };
        },
      },
    });
    const mismatched = applyContextBindingToInvocationSnapshot({
      snapshot,
      binding: {
        model: 'claude-opus-4-6',
        windowTokens: 200_000,
        source: 'invocation_config',
      },
    });

    assert.equal(mismatched.capacity.windowTokens, 1_000_000);
    assert.equal(mismatched.capacity.actionable, false);
  });

  it('requests a pre-invocation seal when stored authoritative usage exceeds the new manual ceiling', async () => {
    registerTestCat(256_000);
    const snapshot = await resolveInvocationCapacitySnapshot({
      catId: TEST_CAT_ID,
      service: service(),
    });
    const action = resolvePreInvocationCapacityAction({
      snapshot,
      contextHealth: {
        usedTokens: 245_000,
        windowTokens: 1_000_000,
        fillRatio: 0.245,
        source: 'exact',
        usedFrom: 'context',
        measuredAt: Date.now(),
      },
      hybridProgressCount: null,
      policySnapshot: activePolicySnapshot({
        strategy: 'handoff',
        thresholds: { warn: 0.75, action: 0.85 },
      }),
    });
    assert.deepEqual(action, { type: 'seal', reason: 'budget_exhausted' });
  });

  it('seals and clears the old provider session before invoking under a reduced ceiling', async () => {
    registerTestCat(256_000);
    const store = new SessionChainStore();
    const active = store.create({
      cliSessionId: 'cli-before-shrink',
      threadId: 'thread-capacity-preflight',
      catId: TEST_CAT_ID,
      userId: 'user-1',
    });
    store.update(active.id, {
      contextHealth: {
        usedTokens: 245_000,
        windowTokens: 1_000_000,
        fillRatio: 0.245,
        source: 'exact',
        usedFrom: 'context',
        measuredAt: Date.now(),
      },
    });
    const calls = [];
    const sealed = await sealBeforeInvocationIfNeeded({
      snapshot: await resolveInvocationCapacitySnapshot({ catId: TEST_CAT_ID, service: service() }),
      catId: TEST_CAT_ID,
      threadId: 'thread-capacity-preflight',
      sessionChainStore: store,
      sessionSealer: {
        async requestSeal({ sessionId, reason }) {
          calls.push(['requestSeal', sessionId, reason]);
          store.update(sessionId, { status: 'sealing', sealReason: reason });
          return { accepted: true, status: 'sealing', sessionId };
        },
        async finalize({ sessionId }) {
          calls.push(['finalize', sessionId]);
          store.update(sessionId, { status: 'sealed' });
        },
      },
      async clearProviderSession() {
        calls.push(['clearProviderSession']);
      },
      policySnapshot: activePolicySnapshot({
        strategy: 'handoff',
        thresholds: { warn: 0.75, action: 0.85 },
      }),
    });

    assert.equal(sealed, true);
    assert.deepEqual(calls, [
      ['requestSeal', active.id, 'budget_exhausted'],
      ['clearProviderSession'],
      ['finalize', active.id],
    ]);
    assert.equal(store.getActive(TEST_CAT_ID, 'thread-capacity-preflight'), null);
  });
});
