import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

let ApprovalProducerRegistry;
let APPROVAL_PRODUCER_IDS;
let APPROVAL_PRODUCER_CATALOG;

before(async () => {
  ({ ApprovalProducerRegistry } = await import('../../dist/domains/approval-hub/ApprovalProducerRegistry.js'));
  ({ APPROVAL_PRODUCER_CATALOG, APPROVAL_PRODUCER_IDS } = await import('@cat-cafe/shared'));
});

function adapter(featureId, history = APPROVAL_PRODUCER_CATALOG[featureId]?.history ?? false) {
  const binding = {
    featureId,
    async listPending() {
      return [];
    },
  };
  if (history) {
    binding.listSettled = async () => [];
  }
  return binding;
}

function completeBindings() {
  return Object.fromEntries(
    APPROVAL_PRODUCER_IDS.map((featureId) => [
      featureId,
      {
        adapter: adapter(featureId),
        lifecycle: { contractVersion: 1, writerGeneration: featureId === 'F266' ? 'v1' : 'legacy' },
      },
    ]),
  );
}

describe('F246 ApprovalProducerRegistry', () => {
  it('returns adapters and manifest in canonical catalog order', () => {
    const registry = new ApprovalProducerRegistry(completeBindings());

    assert.deepEqual(
      registry.listAdapters().map((entry) => entry.featureId),
      APPROVAL_PRODUCER_IDS,
    );
    assert.deepEqual(
      registry.manifest().map((entry) => entry.id),
      APPROVAL_PRODUCER_IDS,
    );
    assert.equal(registry.get('F260').adapter.featureId, 'F260');
  });

  it('fails closed when a catalog binding is missing', () => {
    const bindings = completeBindings();
    delete bindings.F260;
    assert.throws(() => new ApprovalProducerRegistry(bindings), /missing.*F260/i);
  });

  it('fails closed when an extra binding is supplied', () => {
    const bindings = {
      ...completeBindings(),
      F028: { adapter: adapter('F028'), lifecycle: { contractVersion: 1, writerGeneration: 'legacy' } },
    };
    assert.throws(() => new ApprovalProducerRegistry(bindings), /extra.*F028/i);
  });

  it('fails closed when a binding is registered under the wrong feature ID', () => {
    const bindings = completeBindings();
    bindings.F128 = {
      adapter: adapter('F225'),
      lifecycle: { contractVersion: 1, writerGeneration: 'legacy' },
    };
    assert.throws(() => new ApprovalProducerRegistry(bindings), /F128.*F225/);
  });

  it('fails closed when a history-enabled producer omits listSettled', () => {
    const bindings = completeBindings();
    bindings.F276 = {
      adapter: adapter('F276', false),
      lifecycle: { contractVersion: 1, writerGeneration: 'legacy' },
    };

    assert.throws(() => new ApprovalProducerRegistry(bindings), /F276.*history.*listSettled/i);
  });

  it('fails closed when a producer omits the shared lifecycle binding', () => {
    const bindings = completeBindings();
    bindings.F266 = { adapter: adapter('F266') };
    assert.throws(() => new ApprovalProducerRegistry(bindings), /F266.*lifecycle/i);
  });

  it('keeps legacy in-flight work visible as accepted outcome_unknown without raw recovery vocabulary', async () => {
    const bindings = completeBindings();
    bindings.F139 = {
      adapter: {
        featureId: 'F139',
        async listPending() {
          return [
            {
              proposalId: 'schedule-applying-1',
              sourceFeatureId: 'F139',
              requesterCatId: 'codex-sol',
              ownerUserId: 'owner-user',
              status: 'applying',
              summary: 'Applying schedule mutation',
              detail: {},
              navigation: {
                state: 'anchored',
                originRef: { kind: 'event', anchor: 'schedule:1', summary: 'schedule mutation' },
                approvalCardRef: { threadId: 'thread-1', messageId: 'message-1' },
              },
              inlineApprovable: true,
              decisionMode: 'resume-only',
              createdAt: 1,
            },
          ];
        },
        async listSettled() {
          return [
            {
              proposalId: 'schedule-approved-1',
              sourceFeatureId: 'F139',
              requesterCatId: 'codex-sol',
              ownerUserId: 'owner-user',
              status: 'approved',
              summary: 'Approved schedule mutation',
              detail: {},
              navigation: {
                state: 'anchored',
                originRef: { kind: 'event', anchor: 'schedule:2', summary: 'schedule mutation' },
                approvalCardRef: { threadId: 'thread-1', messageId: 'message-2' },
              },
              decisionMode: 'resume-only',
              createdAt: 1,
              decidedAt: 2,
              decidedBy: 'owner-user',
            },
          ];
        },
      },
      lifecycle: { contractVersion: 1, writerGeneration: 'legacy' },
    };
    const [item] = await new ApprovalProducerRegistry(bindings).listPendingFor('F139', 'owner-user');
    assert.equal(item.resolution, 'accepted');
    assert.deepEqual(item.materialization, { state: 'outcome_unknown' });
    assert.equal(item.inlineApprovable, false);
    assert.equal(Object.hasOwn(item, 'status'), false);
    assert.equal(Object.hasOwn(item, 'decisionMode'), false);
    const [settled] = await new ApprovalProducerRegistry(bindings).listSettledFor('F139', 'owner-user', 10);
    assert.equal(settled.resolution, 'accepted');
    assert.deepEqual(settled.materialization, { state: 'outcome_unknown' });
    assert.equal(Object.hasOwn(settled, 'status'), false);
    assert.equal(Object.hasOwn(settled, 'decisionMode'), false);
  });
});
