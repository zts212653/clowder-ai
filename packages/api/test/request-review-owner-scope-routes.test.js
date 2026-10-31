import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { MemoryRequestReviewOwnerLedger } from '../dist/infrastructure/capability-evolution/adapters/request-review/request-review-owner-ledger.js';
import { projectRequestReviewVersionFacts } from '../dist/infrastructure/capability-evolution/adapters/request-review/request-review-owner-projection.js';
import { RequestReviewLineageBindingResolver } from '../dist/infrastructure/capability-evolution/change/request-review-lineage-binding-resolver.js';
import { RequestReviewOwnerFactAuthority } from '../dist/infrastructure/capability-evolution/change/request-review-owner-fact-authority.js';
import { registerCallbackRequestReviewOwnerRoutes } from '../dist/routes/callback-request-review-owner-routes.js';
import { actionRef, caseAction, fixture, principal, ref } from './harness-eval/eval-repair-approval-fixtures.js';

const targetVersionRef = {
  ownerFeatureId: 'F100',
  ownerStateRef: 'skill:cat-cafe-skills/request-review/SKILL.md',
  version: 'a'.repeat(64),
  assetKind: 'skill',
  assetId: 'cat-cafe-skills/request-review/SKILL.md',
};
const programRef = {
  ownerFeatureId: 'F311',
  ownerStateRef: 'evolution-program:ba0f4524e49cc879279164d5b272cf8c',
};
const cycleRef = {
  ownerFeatureId: 'F311',
  ownerStateRef: 'evolution-cycle:evolution-program:ba0f4524e49cc879279164d5b272cf8c:1',
};
const interventionRef = {
  ownerFeatureId: 'F100',
  ownerStateRef: 'capability:development-process-harness-effectiveness',
};
const canonicalLineage = { programRef, cycleRef, interventionRef };

async function exerciseForeignEvidence({ ownerLineage, repairTarget }) {
  const ownerSnapshot = {
    status: 'resolved',
    ownerRef: ref('F100', 'owner:request-review'),
    ownerAuthorizationRef: ref('F100', `authorization:request-review:${targetVersionRef.version}`),
    targetVersionRef,
    dispatchRef: ref('F100', `dispatch:request-review:${targetVersionRef.version}`),
  };
  const approval = fixture({ ownerSnapshot });
  approval.actions.set(actionRef, caseAction({ repairTarget }));
  const proposed = await approval.service.propose({
    caseActionRef: actionRef,
    clientMessageId: `foreign-scope-${repairTarget.featureId}`,
    principal,
    ownerLineage,
  });
  assert.equal(proposed.status, 'published');
  assert.equal(
    (
      await approval.service.decide({
        proposalId: proposed.proposalId,
        decision: 'accept',
        reasonCode: 'accepted_as_proposed',
        decidedByUserId: principal.userId,
      })
    ).status,
    'accepted',
  );
  assert.equal((await approval.service.materialize(proposed.proposalId)).status, 'materialized');

  const task = {
    id: 'f313:1',
    status: 'doing',
    ownerCatId: principal.catId,
    threadId: principal.threadId,
    userId: principal.userId,
  };
  const lease = {
    leaseId: 'f313',
    generation: 1,
    status: 'active',
    subjectRef: `subject:task:${task.id}`,
    actionFamily: 'implement',
    successorSlot: 'implementer',
    holderCatIds: [principal.catId],
    holderThreadId: principal.threadId,
    tenantScope: principal.userId,
    terminalPredicate: { kind: 'task_done' },
  };
  const events = await approval.eventLog.read(caseAction().caseId);
  await approval.eventLog.append(
    {
      eventId: `f266:${repairTarget.featureId}:responsibility`,
      caseId: caseAction().caseId,
      verdictId: caseAction().verdictId,
      domainId: 'eval:friction',
      type: 'responsibility_bound',
      actor: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
      occurredAt: '2026-09-12T10:05:00.000Z',
      reason: 'foreign owner responsibility',
      refs: [
        { kind: 'task', availability: 'available', value: `task:${task.id}` },
        { kind: 'other', availability: 'available', value: `action-successor:${lease.leaseId}:1` },
        { kind: 'other', availability: 'available', value: `message:${principal.originMessageId}` },
      ],
      taskId: task.id,
      leaseId: lease.leaseId,
      leaseGeneration: lease.generation,
    },
    events.length,
  );

  const lineageResolver = new RequestReviewLineageBindingResolver({
    readBindings: async () => [
      { programRef, cycleRef, interventionRef, assetVersionRef: targetVersionRef, caseActionRef: actionRef },
    ],
    resolveCaseAction: async (refValue) => approval.actions.get(refValue) ?? null,
    versionReader: { currentVersionRef: async () => targetVersionRef },
  });
  const invocation = {
    ...principal,
    ownerAuthProvenance: 'strict',
    state: 'active',
    originTriggerMessageId: principal.originMessageId,
  };
  const authority = new RequestReviewOwnerFactAuthority({
    eventLog: approval.eventLog,
    taskStore: { get: async (id) => (id === task.id ? task : null) },
    leaseStore: { get: async (id) => (id === lease.leaseId ? lease : null) },
    invocationRegistry: { peekRecord: async (id) => (id === principal.invocationId ? invocation : null) },
    lineageBindingResolver: lineageResolver,
  });
  const ledger = new MemoryRequestReviewOwnerLedger();
  const receipts = {
    async linkEvidence(input) {
      const append = await ledger.append({
        schemaVersion: 1,
        eventId: `evidence:${input.proposalId}`,
        occurredAt: '2026-09-12T10:30:00.000Z',
        ...input,
        type: 'evidence_linked',
      });
      return { status: append.outcome === 'duplicate' ? 'duplicate' : 'recorded' };
    },
    async recordChanged() {
      throw new Error('not used');
    },
    async resolveIntervention() {
      throw new Error('not used');
    },
    async recordNoChange() {
      throw new Error('not used');
    },
    async recordFreshOutcome() {
      throw new Error('not used');
    },
    async resolveFreshOutcome() {
      throw new Error('not used');
    },
    async recordRollback() {
      throw new Error('not used');
    },
  };
  const app = Fastify({ logger: false });
  app.decorateRequest('callbackAuth', undefined);
  app.addHook('preHandler', async (request) => {
    request.callbackAuth = { ...invocation, callbackToken: 'token', clientMessageIds: new Set() };
  });
  registerCallbackRequestReviewOwnerRoutes(app, {
    ownerUserId: principal.userId,
    receipts,
    factAuthority: authority,
    resolveOutcomeService: () => undefined,
  });
  await app.ready();
  const response = await app.inject({
    method: 'POST',
    url: '/api/callbacks/request-review-owner/facts',
    payload: {
      type: 'evidence',
      proposalId: proposed.proposalId,
      assetVersionRef: targetVersionRef,
      role: 'candidate_independent_verification',
      evidenceRef: ref('F192', `evidence:${repairTarget.featureId}`),
      proofRef: ref('F267', `proof:${repairTarget.featureId}`),
      status: 'verified',
    },
  });
  const stored = await ledger.read();
  const projected = projectRequestReviewVersionFacts(stored, targetVersionRef);
  await app.close();
  return { response, stored, projected };
}

describe('request-review owner callback scope boundary', () => {
  it('rejects unrelated targets and foreign Program/cycles before ledger or F307 projection effects', async () => {
    const scenarios = [
      {
        name: 'unrelated target',
        ownerLineage: canonicalLineage,
        repairTarget: {
          featureId: 'F188',
          componentId: 'memory:evidence-reader',
          version: targetVersionRef.version,
        },
      },
      {
        name: 'same target under foreign Program/cycle',
        ownerLineage: {
          programRef: { ...programRef, ownerStateRef: 'evolution-program:foreign' },
          cycleRef: { ...cycleRef, ownerStateRef: 'evolution-cycle:evolution-program:foreign:1' },
          interventionRef,
        },
        repairTarget: {
          featureId: 'F100',
          componentId: interventionRef.ownerStateRef,
          version: targetVersionRef.version,
        },
      },
    ];
    for (const scenario of scenarios) {
      const result = await exerciseForeignEvidence(scenario);
      assert.equal(result.response.statusCode, 403, `${scenario.name}: ${result.response.body}`);
      assert.deepEqual(result.response.json(), { status: 'blocked', reason: 'owner_scope_mismatch' });
      assert.deepEqual(result.stored, [], `${scenario.name} must not append to the F100 ledger`);
      assert.deepEqual(result.projected, { evidence: [], uses: [] }, `${scenario.name} must not reach F307`);
    }
  });
});
