import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { projectCompanionDecisions } from '../../src/routes/companion-decision-projection.js';
import { registerCompanionWorkReadRoutes } from '../../src/routes/companion-work-read.js';

import { approval, receipt, work } from './unified-attention-fixtures.js';

function project(approvals: unknown[], ownerReads: unknown[], offset = 0, limit = 20) {
  return projectCompanionDecisions(
    { items: approvals, coverage: { state: 'complete' } },
    { ownerReads, coverage: { state: 'complete' } },
    'owner',
    { offset, limit },
    100,
  ) as unknown as {
    items: { decisionRef: string; kind: string; linkedNeedsMe?: unknown[] }[];
    totalCount?: number;
    status: string;
    consistency: { state: string; reasons: string[] };
    page: { hasMore: boolean };
  };
}

test('keeps unlinked pending, counts individual decisions on one Task before paging, and never runs an action', () => {
  const result = project([approval('unlinked')], [work([receipt('a'), receipt('b')])], 1, 1);
  assert.equal(result.totalCount, 3);
  assert.equal(result.items.length, 1);
  assert.equal(result.page.hasMore, true);
  assert.equal(project([approval('unlinked')], []).items[0].decisionRef, 'approval:F221:unlinked');
});

test('only current eligible receipts with prepared material survive; source closure retires them on reread', () => {
  const valid = work([receipt('a')]);
  const stale = { ...valid, envelope: { ...valid.envelope, freshness: { state: 'stale', observedRevision: 2 } } };
  const closed = { ...valid, brief: { ...valid.brief, current: { state: 'done' } } };
  const noMaterial = { ...valid, preparedArtifact: undefined };
  for (const source of [stale, closed, noMaterial, work([{ ...receipt('a'), eligible: false }])]) {
    assert.equal(project([], [source]).items.length, 0);
  }
  assert.equal(project([], [valid]).items.length, 1);
  assert.equal(project([], []).totalCount, 0);
});

test('F306 uses updated version witness; same Task does not collapse a different decision', () => {
  const row = {
    ...approval('a', 'F306', 10),
    needsMeDecisionRefs: [{ producerId: 'f306.runtime_interaction', subjectRef: 'a', revision: 20 }],
  };
  const result = project([row], [work([receipt('a'), receipt('b')])]);
  assert.equal(result.totalCount, 2);
  assert.equal(result.items[0].linkedNeedsMe?.length, 1);
});

test('F292 canonical meeting aliases deduplicate only producer-issued exact revision witnesses', () => {
  const row = {
    ...approval('minute', 'F292'),
    needsMeDecisionRefs: [
      { producerId: 'f292.repair', subjectRef: 'minute', revision: 5 },
      { producerId: 'f292.repair', subjectRef: 'note', revision: 8 },
    ],
  };
  const result = project([row], [work([receipt('minute', 'f292.repair', 5), receipt('note', 'f292.repair', 8)])]);
  assert.equal(result.totalCount, 1);
  assert.equal(result.items[0].linkedNeedsMe?.length, 2);
});

test('missing or conflicting F292/F306 versions remain separate and withhold exact count', () => {
  for (const row of [
    approval('a', 'F306'),
    {
      ...approval('a', 'F306'),
      needsMeDecisionRefs: [{ producerId: 'f306.runtime_interaction', subjectRef: 'a', revision: 19 }],
    },
  ]) {
    const result = project([row], [work([receipt('a')])]);
    assert.equal(result.totalCount, undefined);
    assert.equal(result.items.length, 2);
    assert.equal(result.consistency.state, 'uncertain');
  }
});

test('callback partial reads preserve successful source and distinguish 401 from 403 and 503', async (t) => {
  for (const code of [401, 403, 503]) {
    const app = Fastify();
    t.after(() => app.close());
    app.addHook('preHandler', async (request) => {
      if (request.url.startsWith('/api/callbacks/companion/'))
        request.callbackAuth = { userId: 'owner' } as NonNullable<typeof request.callbackAuth>;
    });
    app.get('/api/approval-hub/pending', async (_request, reply) => reply.code(code).send({ error: 'source failure' }));
    app.get('/api/entrusted-work/needs-me', async () => ({ ownerReads: [work([receipt('a')])] }));
    registerCompanionWorkReadRoutes(app, '/current');
    const response = await app.inject('/api/callbacks/companion/decisions?view=unified');
    assert.equal(response.statusCode, 200);
    const result = response.json();
    assert.equal(result.status, 'partial');
    assert.equal(result.items.length, 1);
    assert.equal(result.totalCount, undefined);
    assert.equal(
      result.sources.approvals.status,
      code === 401 ? 'unauthenticated' : code === 403 ? 'forbidden' : 'unavailable',
    );
    assert.equal(result.sources.needsMe.status, 'available');
  }
});

test('successful legacy sources without exhaustive coverage cannot certify a total', async (t) => {
  const { readCompanionDecisionProjection } = await import('../../src/routes/companion-decision-read-service.js');
  const app = Fastify();
  t.after(() => app.close());
  app.get('/api/approval-hub/pending', async () => ({ items: [approval('known')] }));
  app.get('/api/entrusted-work/needs-me', async () => ({ ownerReads: [] }));
  const result = await readCompanionDecisionProjection(app, 'owner', { offset: 0, limit: 20 });
  assert.equal(result.status, 'partial');
  assert.equal(result.items.length, 1);
  assert.equal(result.totalCount, undefined);
  assert.equal(result.sources.approvals.exhaustiveness, 'unknown');
});

test('real F260 source reads all pending proposals before unified paging', async (t) => {
  const { InMemoryEntityProposalStore } = await import(
    '../../src/domains/approval-hub/stores/ports/IEntityProposalStore.js'
  );
  const { F260ApprovalAdapter } = await import('../../src/domains/approval-hub/adapters/F260ApprovalAdapter.js');
  const { approvalHubRoutes } = await import('../../src/routes/approval-hub-routes.js');
  const { readCompanionDecisionProjection } = await import('../../src/routes/companion-decision-read-service.js');
  const { createTestApprovalRegistry, anchorApproval } = await import('../approval-hub/helpers.js');
  const store = new InMemoryEntityProposalStore();
  for (let index = 0; index < 125; index++) {
    const p = store.create({
      entityId: `concept:${index}`,
      entityType: 'concept',
      canonicalName: `Concept ${index}`,
      aliases: [],
      stance: 'endorsed',
      visibilityScope: 'workspace',
      provenance: [],
      rationale: 'pending',
      sourceThreadId: 'source-thread',
      sourceCatId: 'codex61-sol',
      ownerUserId: 'owner',
    });
    await anchorApproval(store, {
      proposalId: p.proposalId,
      sourceFeatureId: 'F260',
      ownerUserId: 'owner',
      requesterCatId: 'codex61-sol',
      threadId: 'source-thread',
      createdAt: p.createdAt,
    });
  }
  const app = Fastify();
  t.after(() => app.close());
  await app.register(approvalHubRoutes, {
    registry: await createTestApprovalRegistry([new F260ApprovalAdapter(store)]),
  });
  app.get('/api/entrusted-work/needs-me', async () => ({ ownerReads: [], coverage: { state: 'complete' } }));
  const page = await readCompanionDecisionProjection(app, 'owner', { offset: 100, limit: 20 });
  assert.equal(page.totalCount, 125);
  assert.equal(page.items.length, 20);
  assert.equal(page.page.hasMore, true);
  const end = await readCompanionDecisionProjection(app, 'owner', { offset: 120, limit: 20 });
  assert.equal(end.items.length, 5);
  assert.equal(end.page.hasMore, false);
});
