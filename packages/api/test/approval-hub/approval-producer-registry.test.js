import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

let ApprovalProducerRegistry;
let APPROVAL_PRODUCER_IDS;

before(async () => {
  ({ ApprovalProducerRegistry } = await import('../../dist/domains/approval-hub/ApprovalProducerRegistry.js'));
  ({ APPROVAL_PRODUCER_IDS } = await import('@cat-cafe/shared'));
});

function adapter(featureId) {
  return {
    featureId,
    async listPending() {
      return [];
    },
  };
}

function completeBindings() {
  return Object.fromEntries(APPROVAL_PRODUCER_IDS.map((featureId) => [featureId, { adapter: adapter(featureId) }]));
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
    const bindings = { ...completeBindings(), F028: { adapter: adapter('F028') } };
    assert.throws(() => new ApprovalProducerRegistry(bindings), /extra.*F028/i);
  });

  it('fails closed when a binding is registered under the wrong feature ID', () => {
    const bindings = completeBindings();
    bindings.F128 = { adapter: adapter('F225') };
    assert.throws(() => new ApprovalProducerRegistry(bindings), /F128.*F225/);
  });
});
