import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspectPawFeelMessage } from '../../dist/infrastructure/harness-eval/friction/paw-feel-source.js';
import { PawFeelDirectRepairFederation } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/direct-repair/direct-repair-federation.js';
import { PawFeelDirectRepairResolver } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/direct-repair/direct-repair-resolver.js';
import { PawFeelDirectRepairSourceVerifier } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/direct-repair/direct-repair-source.js';

const message = {
  id: 'message-direct',
  threadId: 'thread-source',
  userId: 'user-1',
  catId: 'codex-sol',
  content: '[爪感差: cat_cafe_hold_ball+completion callback disappeared]',
  mentions: [],
  timestamp: Date.parse('2026-09-07T00:00:00.000Z'),
};
const inspected = inspectPawFeelMessage(message);
assert.equal(inspected.kind, 'canonical');
const candidate = inspected.candidates[0];

function projection(overrides = {}) {
  return {
    signalId: candidate.signalId,
    sourceMessageId: candidate.sourceMessageId,
    sourceThreadId: candidate.sourceThreadId,
    sourceCatId: candidate.sourceCatId,
    markerDigest: candidate.markerDigest,
    sameDigestOrdinal: candidate.sameDigestOrdinal,
    markerIndex: candidate.markerIndex,
    state: 'seen',
    sequence: 2,
    discoveredAt: '2026-09-07T00:00:00.000Z',
    lastTransitionAt: '2026-09-07T00:00:01.000Z',
    backfilled: false,
    captureMethod: 'typed',
    captureAssessment: 'confirmed',
    ...overrides,
  };
}

const ref = (ownerFeatureId, ownerStateRef, version) => ({
  ownerFeatureId,
  ownerStateRef,
  ...(version ? { version } : {}),
});
const targetVersionRef = {
  ...ref('F167', 'action-target:hold-ball', 'v3'),
  assetKind: 'mcp_tool',
  assetId: 'cat_cafe_hold_ball',
};
const route = (providerId = 'f167-hold-owner', providerVersion = 'v3', match = 'exact') => ({
  schemaVersion: 1,
  providerId,
  providerVersion,
  sourceToolRoutes: [{ ownerFeatureId: 'F167', ownerStateRef: 'mcp-tool:cat_cafe_hold_ball', match }],
});

function authorizedProvider(calls, overrides = {}) {
  return {
    async resolveAuthority(input) {
      calls.push(input.actionRef);
      return {
        status: 'authorized',
        authority: {
          schemaVersion: 1,
          resolvedActionRef: ref('F167', 'action:hold-ball:repair-1'),
          actionScopeRef: ref('F167', 'action-scope:hold-ball-callback'),
          ownerAuthorizationRef: ref('F167', 'authorization:existing-internal-tool'),
          targetVersionRef,
          ownerCatId: 'opus',
          outcomeVerifierRef: ref('F167', 'outcome-verifier:hold-ball:v3'),
          ...overrides,
        },
      };
    },
    async verifyOutcome() {
      throw new Error('not used in authority routing tests');
    },
  };
}

function harness({ snapshots, storedMessage = message, custodyResolver } = {}) {
  const sourceVerifier = new PawFeelDirectRepairSourceVerifier({
    messageStore: {
      async getById() {
        return storedMessage;
      },
    },
    classifyTool(tool) {
      assert.equal(tool, 'cat_cafe_hold_ball');
      return ref('F167', 'mcp-tool:cat_cafe_hold_ball');
    },
  });
  return new PawFeelDirectRepairResolver({
    sourceVerifier,
    federation: new PawFeelDirectRepairFederation(snapshots ?? []),
    custodyResolver: custodyResolver ?? {
      async resolve(leaseId) {
        return {
          ownerCatId: 'opus',
          taskId: 'task-1',
          leaseId,
          leaseGeneration: 2,
          custodyEvidenceRef: `action-lease:${leaseId}:generation:2`,
        };
      },
    },
    approvalContinuationResolver: {
      async resolve() {
        throw new Error('not used in authorized tests');
      },
    },
  });
}

describe('F313 source-routed direct repair authority', () => {
  it('rereads the exact source and rejects digest drift before provider selection', async () => {
    const calls = [];
    const provider = authorizedProvider(calls);
    const changed = { ...message, content: '[爪感差: cat_cafe_hold_ball+different source]' };
    const resolver = harness({ snapshots: [{ route: route(), provider }], storedMessage: changed });

    await assert.rejects(
      resolver.resolve({ projection: projection(), leaseId: 'lease-1', actionRef: 'opaque-action' }),
      (error) => error?.code === 'source_mismatch',
    );
    assert.deepEqual(calls, []);
  });

  it('fails closed before provider selection when the canonical source is unavailable', async () => {
    const calls = [];
    const resolver = harness({
      snapshots: [{ route: route(), provider: authorizedProvider(calls) }],
      storedMessage: null,
    });

    await assert.rejects(
      resolver.resolve({ projection: projection(), leaseId: 'lease-1', actionRef: 'must-not-route' }),
      (error) => error?.code === 'source_unavailable',
    );
    assert.deepEqual(calls, []);
  });

  it('fails closed for zero or overlapping source providers without exposing actionRef', async () => {
    for (const snapshots of [
      [],
      [
        { route: route('provider-a'), provider: authorizedProvider([]) },
        { route: route('provider-b'), provider: authorizedProvider([]) },
      ],
    ]) {
      const resolver = harness({ snapshots });
      await assert.rejects(
        resolver.resolve({ projection: projection(), leaseId: 'lease-1', actionRef: 'must-not-route' }),
        (error) => error?.code === (snapshots.length === 0 ? 'provider_not_found' : 'provider_ambiguous'),
      );
    }
  });

  it('selects the source provider before reading an opaque action ref', async () => {
    const resolver = harness({ snapshots: [] });
    const input = { projection: projection(), leaseId: 'lease-1' };
    Object.defineProperty(input, 'actionRef', {
      get() {
        assert.fail('actionRef must remain unread before source-provider selection');
      },
    });

    await assert.rejects(resolver.resolve(input), (error) => error?.code === 'provider_not_found');
  });

  it('passes an opaque action only to the source-selected provider and preserves provider rejection', async () => {
    const calls = [];
    const provider = {
      ...authorizedProvider(calls),
      async resolveAuthority(input) {
        calls.push(input.actionRef);
        return {
          status: 'blocked',
          reason: 'action_source_mismatch',
          blockerRef: ref('F167', 'blocker:foreign-action'),
        };
      },
    };
    const resolver = harness({ snapshots: [{ route: route(), provider }] });

    await assert.rejects(
      resolver.resolve({ projection: projection(), leaseId: 'lease-1', actionRef: 'foreign-domain-action' }),
      (error) => error?.code === 'action_source_mismatch',
    );
    assert.deepEqual(calls, ['foreign-domain-action']);
  });

  it('treats a registered but unreadable provider as unavailable without consulting actionRef', async () => {
    const resolver = harness({ snapshots: [{ route: route() }] });

    await assert.rejects(
      resolver.resolve({ projection: projection(), leaseId: 'lease-1', actionRef: 'must-not-route' }),
      (error) => error?.code === 'provider_unavailable',
    );
  });

  it('freezes the registration snapshot against caller mutation', () => {
    const mutableRoute = route();
    const federation = new PawFeelDirectRepairFederation([{ route: mutableRoute, provider: authorizedProvider([]) }]);
    mutableRoute.providerVersion = 'mutated';
    mutableRoute.sourceToolRoutes[0].ownerStateRef = 'mcp-tool:foreign';

    const selected = federation.select(ref('F167', 'mcp-tool:cat_cafe_hold_ball'));
    assert.equal(selected.route.providerVersion, 'v3');
    assert.equal(selected.route.sourceToolRoutes[0].ownerStateRef, 'mcp-tool:cat_cafe_hold_ball');
    assert.equal(Object.isFrozen(selected.route), true);
    assert.equal(Object.isFrozen(selected.route.sourceToolRoutes), true);
    assert.equal(Object.isFrozen(selected.route.sourceToolRoutes[0]), true);
  });

  it('rejects non-canonical or payload-bearing registration routes', () => {
    for (const invalidRoute of [
      route(' owner-with-space '),
      { ...route(), payload: { authority: 'forged' } },
      {
        ...route(),
        sourceToolRoutes: [{ ...route().sourceToolRoutes[0], payload: 'forged' }],
      },
    ]) {
      const federation = new PawFeelDirectRepairFederation([{ route: invalidRoute, provider: authorizedProvider([]) }]);
      assert.throws(
        () => federation.select(ref('F167', 'mcp-tool:cat_cafe_hold_ball')),
        (error) => error?.code === 'registration_invalid',
      );
    }
  });

  it('rejects custody that resolves a different lease before calling the owner provider', async () => {
    const calls = [];
    const resolver = harness({
      snapshots: [{ route: route(), provider: authorizedProvider(calls) }],
      custodyResolver: {
        async resolve() {
          return {
            ownerCatId: 'opus',
            taskId: 'task-1',
            leaseId: 'lease-other',
            leaseGeneration: 2,
            custodyEvidenceRef: 'action-lease:lease-other:generation:2',
          };
        },
      },
    });

    await assert.rejects(
      resolver.resolve({ projection: projection(), leaseId: 'lease-1', actionRef: 'repair-1' }),
      (error) => error?.code === 'terminal_evidence_invalid',
    );
    assert.deepEqual(calls, []);
  });

  it('derives a byte-stable binding across equivalent registration snapshots', async () => {
    const firstCalls = [];
    const secondCalls = [];
    const first = harness({ snapshots: [{ route: route(), provider: authorizedProvider(firstCalls) }] });
    const second = harness({ snapshots: [{ provider: authorizedProvider(secondCalls), route: route() }] });
    const input = { projection: projection(), leaseId: 'lease-1', actionRef: 'repair-1' };

    const firstResult = await first.resolve(input);
    const secondResult = await second.resolve(input);

    assert.equal(firstResult.status, 'authorized');
    assert.equal(secondResult.status, 'authorized');
    assert.deepEqual(firstResult.binding, secondResult.binding);
    assert.equal(firstResult.binding.providerVersion, 'v3');
    assert.equal(firstResult.binding.ownerCatId, 'opus');
    assert.deepEqual(firstCalls, ['repair-1']);
    assert.deepEqual(secondCalls, ['repair-1']);
  });
});
