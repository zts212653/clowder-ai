/**
 * F167 R5 — Suite 8+9+10: approvedDevelopmentScope fence tests.
 *
 * Suite 8: ProposalStoreDelegateProvider scope drift detection.
 * Suite 9: Redis serialize/hydrate round-trip for approvedDevelopmentScope.
 * Suite 10: Proposal card 执行范围 visibility.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CHILD_CAT,
  CHILD_THREAD,
  DEV_SCOPE,
  makeBindingProvider,
  makeProposal,
  makeProposalStore,
  OWNER_CAT,
  OWNER_THREAD,
  PROPOSAL_ID,
  TASK_ID,
  TENANT,
} from './f167-delegate-test-helpers.js';

const { ProposalStoreDelegateProvider } = await import('../dist/domains/ball-custody/ProposalStoreDelegateProvider.js');
const { InMemoryProposalStore } = await import('../dist/domains/cats/services/stores/ports/ProposalStore.js');
const { serializeProposal, hydrateProposal } = await import(
  '../dist/domains/cats/services/stores/redis/RedisProposalStoreHelpers.js'
);
const { buildProposalCardBlock } = await import('../dist/routes/proposal-card-block.js');

const SCOPE = {
  featureRef: 'feature:F167',
  phaseKey: 'B',
  workUnitRef: 'feature-phase:F167:B',
  acceptedSourceRef: 'file:docs/features/F167.md',
  acceptedRevision: 'a'.repeat(40),
};

function scopedProposal(scopeOverrides = {}) {
  return makeProposal({ approvedDevelopmentScope: { ...SCOPE, ...scopeOverrides } });
}

function scopedBinding() {
  return { proposalId: PROPOSAL_ID, approvedUnderOwner: OWNER_CAT };
}

// ═══════════════════════════════════════════════════════════════════════
// Suite 8: ProposalStoreDelegateProvider scope drift detection
// ═══════════════════════════════════════════════════════════════════════

describe('F167 R5 — scope drift detection in ProposalStoreDelegateProvider', () => {
  test('same scope → delegates returned', async () => {
    const provider = new ProposalStoreDelegateProvider(
      makeProposalStore(scopedProposal()),
      makeBindingProvider({ binding: scopedBinding() }),
    );
    const delegates = await provider.getForTask(TASK_ID, OWNER_THREAD, OWNER_CAT, TENANT, SCOPE);
    assert.equal(delegates.length, 1);
    assert.equal(delegates[0].catId, CHILD_CAT);
    assert.equal(delegates[0].threadId, CHILD_THREAD);
  });

  test('workUnitRef changed → empty (scope drift)', async () => {
    const provider = new ProposalStoreDelegateProvider(
      makeProposalStore(scopedProposal()),
      makeBindingProvider({ binding: scopedBinding() }),
    );
    const drifted = { ...SCOPE, workUnitRef: 'plan:B-impl-2' };
    const delegates = await provider.getForTask(TASK_ID, OWNER_THREAD, OWNER_CAT, TENANT, drifted);
    assert.equal(delegates.length, 0, 'workUnitRef drift must invalidate delegation');
  });

  test('acceptedSourceRef changed → empty (scope drift)', async () => {
    const provider = new ProposalStoreDelegateProvider(
      makeProposalStore(scopedProposal()),
      makeBindingProvider({ binding: scopedBinding() }),
    );
    const drifted = { ...SCOPE, acceptedSourceRef: 'file:docs/features/F999.md' };
    const delegates = await provider.getForTask(TASK_ID, OWNER_THREAD, OWNER_CAT, TENANT, drifted);
    assert.equal(delegates.length, 0, 'acceptedSourceRef drift must invalidate delegation');
  });

  test('acceptedRevision changed → empty (scope drift)', async () => {
    const provider = new ProposalStoreDelegateProvider(
      makeProposalStore(scopedProposal()),
      makeBindingProvider({ binding: scopedBinding() }),
    );
    const drifted = { ...SCOPE, acceptedRevision: 'b'.repeat(40) };
    const delegates = await provider.getForTask(TASK_ID, OWNER_THREAD, OWNER_CAT, TENANT, drifted);
    assert.equal(delegates.length, 0, 'acceptedRevision drift must invalidate delegation');
  });

  test('featureRef changed → empty (scope drift)', async () => {
    const provider = new ProposalStoreDelegateProvider(
      makeProposalStore(scopedProposal()),
      makeBindingProvider({ binding: scopedBinding() }),
    );
    const drifted = { ...SCOPE, featureRef: 'feature:F999' };
    const delegates = await provider.getForTask(TASK_ID, OWNER_THREAD, OWNER_CAT, TENANT, drifted);
    assert.equal(delegates.length, 0, 'featureRef drift must invalidate delegation');
  });

  test('phaseKey changed → empty (scope drift)', async () => {
    const provider = new ProposalStoreDelegateProvider(
      makeProposalStore(scopedProposal()),
      makeBindingProvider({ binding: scopedBinding() }),
    );
    const drifted = { ...SCOPE, phaseKey: 'C' };
    const delegates = await provider.getForTask(TASK_ID, OWNER_THREAD, OWNER_CAT, TENANT, drifted);
    assert.equal(delegates.length, 0, 'phaseKey drift must invalidate delegation');
  });

  test('proposal without approvedDevelopmentScope → empty (fail closed)', async () => {
    const provider = new ProposalStoreDelegateProvider(
      makeProposalStore(makeProposal()), // no scope
      makeBindingProvider({ binding: scopedBinding() }),
    );
    const delegates = await provider.getForTask(TASK_ID, OWNER_THREAD, OWNER_CAT, TENANT, SCOPE);
    assert.equal(delegates.length, 0, 'no approved scope → fail closed');
  });

  test('task without current scope → empty (fail closed)', async () => {
    const provider = new ProposalStoreDelegateProvider(
      makeProposalStore(scopedProposal()),
      makeBindingProvider({ binding: scopedBinding() }),
    );
    // undefined currentDevelopmentScope
    const delegates = await provider.getForTask(TASK_ID, OWNER_THREAD, OWNER_CAT, TENANT, undefined);
    assert.equal(delegates.length, 0, 'no current scope → fail closed');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Suite 9: approvedDevelopmentScope Redis serialize/hydrate round-trip
// ═══════════════════════════════════════════════════════════════════════

describe('F167 R5 — approvedDevelopmentScope Redis round-trip', () => {
  test('serialize includes approvedDevelopmentScope and hydrate recovers it', () => {
    const proposal = {
      proposalId: 'prop-scope-rt',
      status: 'approved',
      sourceThreadId: OWNER_THREAD,
      sourceInvocationId: 'inv-scope',
      sourceCatId: OWNER_CAT,
      title: 'Scope round-trip',
      reason: 'Test scope serialization',
      parentThreadId: OWNER_THREAD,
      preferredCats: [CHILD_CAT],
      projectPath: '/test',
      createdBy: TENANT,
      createdAt: 3000,
      subjectTaskId: TASK_ID,
      approvedDevelopmentScope: SCOPE,
    };

    const serialized = serializeProposal(proposal);
    const scopeIdx = serialized.indexOf('approvedDevelopmentScope');
    assert.ok(scopeIdx >= 0, 'approvedDevelopmentScope must appear in serialized output');
    const parsed = JSON.parse(serialized[scopeIdx + 1]);
    assert.deepEqual(parsed, SCOPE, 'serialized scope JSON must match original');

    const data = {};
    for (let i = 0; i < serialized.length; i += 2) {
      data[serialized[i]] = serialized[i + 1];
    }
    const hydrated = hydrateProposal(data);
    assert.deepEqual(hydrated.approvedDevelopmentScope, SCOPE, 'hydrated scope must match');
  });

  test('corrupt JSON in approvedDevelopmentScope → hydrate drops it (fail closed)', () => {
    const data = {
      proposalId: 'prop-corrupt',
      status: 'approved',
      sourceThreadId: OWNER_THREAD,
      sourceInvocationId: 'inv-corrupt',
      sourceCatId: OWNER_CAT,
      title: 'Corrupt scope',
      reason: 'Test',
      parentThreadId: OWNER_THREAD,
      preferredCats: '["codex6-sol"]',
      projectPath: '/test',
      createdBy: TENANT,
      createdAt: '4000',
      approvedDevelopmentScope: '{invalid-json',
    };
    const hydrated = hydrateProposal(data);
    assert.equal(hydrated.approvedDevelopmentScope, undefined, 'corrupt scope must be dropped');
  });

  test('absent approvedDevelopmentScope → hydrate leaves undefined', () => {
    const data = {
      proposalId: 'prop-noscope',
      status: 'pending',
      sourceThreadId: OWNER_THREAD,
      sourceInvocationId: 'inv-ns',
      sourceCatId: OWNER_CAT,
      title: 'No scope',
      reason: 'Legacy',
      parentThreadId: OWNER_THREAD,
      preferredCats: '[]',
      projectPath: '/test',
      createdBy: TENANT,
      createdAt: '5000',
    };
    const hydrated = hydrateProposal(data);
    assert.equal(hydrated.approvedDevelopmentScope, undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Suite 10: proposal card 执行范围 field visibility
// ═══════════════════════════════════════════════════════════════════════

describe('F167 R5 — proposal card 执行范围 visibility', () => {
  function cardProposal(overrides = {}) {
    return {
      proposalId: 'prop-card',
      status: 'pending',
      sourceThreadId: OWNER_THREAD,
      sourceInvocationId: 'inv-card',
      sourceCatId: OWNER_CAT,
      sourceMessageId: 'msg-card',
      title: 'Card test',
      reason: 'Test card fields',
      parentThreadId: OWNER_THREAD,
      preferredCats: [CHILD_CAT],
      projectPath: '/test',
      createdBy: TENANT,
      createdAt: 6000,
      reportingMode: 'final-only',
      ...overrides,
    };
  }

  test('card shows 执行范围 when proposal has subjectTaskId + scope', () => {
    const card = buildProposalCardBlock(cardProposal({ subjectTaskId: TASK_ID, approvedDevelopmentScope: SCOPE }));
    const scopeField = card.fields.find((f) => f.label === '执行范围');
    assert.ok(scopeField, '执行范围 field must be present');
    assert.ok(scopeField.value.includes('feature-phase:F167:B'), 'must show workUnitRef');
    assert.ok(scopeField.value.includes('F167.md'), 'must show acceptedSourceRef');
    assert.ok(scopeField.value.includes('aaaaaaaa'), 'must show truncated revision');
  });

  test('card omits 执行范围 when no scope', () => {
    const card = buildProposalCardBlock(cardProposal({ subjectTaskId: TASK_ID }));
    const scopeField = card.fields.find((f) => f.label === '执行范围');
    assert.equal(scopeField, undefined, '执行范围 must not appear without scope');
  });

  test('card omits 执行范围 when no subjectTaskId (even if scope present)', () => {
    const card = buildProposalCardBlock(cardProposal({ approvedDevelopmentScope: SCOPE }));
    const scopeField = card.fields.find((f) => f.label === '执行范围');
    assert.equal(scopeField, undefined, '执行范围 requires subjectTaskId');
  });

  test('card still shows 关联任务 field with subjectTaskTitle', () => {
    const card = buildProposalCardBlock(
      cardProposal({
        subjectTaskId: TASK_ID,
        subjectTaskTitle: 'Implement X',
        approvedDevelopmentScope: SCOPE,
      }),
    );
    const taskField = card.fields.find((f) => f.label === '关联任务');
    assert.ok(taskField, '关联任务 field must be present');
    assert.ok(taskField.value.includes('Implement X'));
    assert.ok(taskField.value.includes(TASK_ID));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Suite 11: R6 — schema-valid JSON but schema-invalid data in hydrate
// ═══════════════════════════════════════════════════════════════════════

function hydrateData(id, scopeJson) {
  return {
    proposalId: id,
    status: 'approved',
    sourceThreadId: OWNER_THREAD,
    sourceInvocationId: `inv-${id}`,
    sourceCatId: OWNER_CAT,
    title: id,
    reason: 'Test',
    parentThreadId: OWNER_THREAD,
    preferredCats: '[]',
    projectPath: '/test',
    createdBy: TENANT,
    createdAt: '7000',
    ...(scopeJson !== undefined ? { approvedDevelopmentScope: scopeJson } : {}),
  };
}

describe('F167 R6 — schema-invalid-but-JSON-valid scope hydrate', () => {
  test('acceptedRevision as number → hydrate drops scope (fail closed)', () => {
    const hydrated = hydrateProposal(hydrateData('bad-rev', JSON.stringify({ ...SCOPE, acceptedRevision: 7 })));
    assert.equal(hydrated.approvedDevelopmentScope, undefined, 'schema-invalid scope must be dropped');
  });

  test('missing featureRef → hydrate drops scope (fail closed)', () => {
    const { featureRef: _, ...incomplete } = SCOPE;
    const hydrated = hydrateProposal(hydrateData('no-feat', JSON.stringify(incomplete)));
    assert.equal(hydrated.approvedDevelopmentScope, undefined, 'incomplete scope must be dropped');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Suite 12: R6 — InMemoryProposalStore deep-copy isolation
// ═══════════════════════════════════════════════════════════════════════

function scopedInput(suffix) {
  return {
    sourceThreadId: OWNER_THREAD,
    sourceInvocationId: `inv-iso-${suffix}`,
    sourceCatId: OWNER_CAT,
    sourceMessageId: `msg-iso-${suffix}`,
    title: `Isolation ${suffix}`,
    reason: 'Deep-copy regression',
    parentThreadId: OWNER_THREAD,
    preferredCats: [CHILD_CAT],
    projectPath: '/test',
    createdBy: TENANT,
    approvedDevelopmentScope: DEV_SCOPE,
  };
}

describe('F167 R6 — InMemoryProposalStore scope deep-copy isolation', () => {
  test('mutating create() return does not leak into store', () => {
    const store = new InMemoryProposalStore();
    const created = store.create(scopedInput('1'));
    created.approvedDevelopmentScope.featureRef = 'feature:TAMPERED';
    const fetched = store.get(created.proposalId);
    assert.equal(fetched.approvedDevelopmentScope.featureRef, DEV_SCOPE.featureRef, 'store must be unaffected');
  });

  test('mutating get() return does not leak into store', () => {
    const store = new InMemoryProposalStore();
    const created = store.create(scopedInput('2'));
    const first = store.get(created.proposalId);
    first.approvedDevelopmentScope.acceptedRevision = 'b'.repeat(40);
    const second = store.get(created.proposalId);
    assert.equal(
      second.approvedDevelopmentScope.acceptedRevision,
      DEV_SCOPE.acceptedRevision,
      'store must be unaffected',
    );
  });
});
