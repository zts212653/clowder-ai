import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { projectCompanionDecisions } from '../../src/routes/companion-decision-projection.js';
import { readCompanionDecisionProjection } from '../../src/routes/companion-decision-read-service.js';
import { approval, receipt, work } from './unified-attention-fixtures.js';

function project(rows: unknown[], reads: unknown[]) {
  return projectCompanionDecisions(
    { items: rows, coverage: { state: 'complete' } },
    { ownerReads: reads, coverage: { state: 'complete' } },
    'owner',
    { offset: 0, limit: 20 },
    100,
  );
}

test('same canonical identity is stable across complete/partial source availability and keeps original version fields', () => {
  const row = {
    ...approval('a', 'F306'),
    needsMeDecisionRefs: [{ producerId: 'f306.runtime_interaction', subjectRef: 'a', revision: 20 }],
  };
  assert.equal(
    project([row], [work([receipt('a')])]).items[0].decisionRef,
    project([], [work([receipt('a')])]).items[0].decisionRef,
  );
  assert.equal(project([row], []).items[0].decisionRef, project([], [work([receipt('a')])]).items[0].decisionRef);
  const regular = { ...approval('taste'), entrustedWorkTaskRef: { subjectRef: 'task:work:one', observedRevision: 3 } };
  const linked = work([receipt('approval:F221:taste', 'f246.approval', 10)]);
  assert.equal(project([regular], [linked]).totalCount, 1);
  assert.equal(project([regular], [linked]).items[0].decisionRef, project([], [linked]).items[0].decisionRef);
  const stale = { ...linked, attentionReceipts: [receipt('approval:F221:taste', 'f246.approval', 11)] };
  assert.equal(project([regular], [stale]).totalCount, undefined);
  assert.equal(project([regular], [stale]).items.length, 2);
});

test('duplicate concrete identities count once; conflicting original versions stay visible without a precise count', () => {
  assert.equal(project([approval('a'), approval('a')], []).totalCount, 1);
  const conflict = project([approval('a'), approval('a', 'F221', 11)], []);
  assert.equal(conflict.totalCount, undefined);
  assert.equal(conflict.items.length, 2);
  assert.equal(project([], [work([receipt('a'), receipt('a')])]).totalCount, 1);
  assert.equal(project([], [work([receipt('a'), receipt('a', 'f306.runtime_interaction', 21)])]).totalCount, undefined);
});

test('legacy approval count and pagination describe the same deduplicated vector that is paged', () => {
  const approvals = Array.from({ length: 20 }, (_, index) => approval(`decision-${index}`));
  const result = project([...approvals, approvals[0]], []);
  assert.equal(result.approvals.length, 20);
  assert.equal(result.totalCount, 20);
  assert.equal(result.approvalCount, 20);
  assert.equal(result.page.hasMoreApprovals, false);
  assert.equal(result.page.hasMore, false);
});

test('legacy Needs Me metadata counts original Task groups once when source rows repeat', () => {
  const row = work([receipt('a')]);
  const result = project([], [row, row]);
  assert.equal(result.needsMeCount, 1);
  assert.equal(result.otherNeedsMeCount, 1);
  assert.equal(result.otherNeedsMe.length, 1);
  assert.equal(result.page.hasMoreNeedsMe, false);
});

test('missing anchors/times preserve source facts; accepted unknown materialization never regains inline approval', () => {
  const row = {
    ...approval('legacy'),
    resolution: 'accepted',
    materialization: { state: 'outcome_unknown' },
    inlineApprovable: false,
  };
  const result = project([row], []);
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0].approval?.navigation, { state: 'legacy_unanchored' });
  assert.equal(result.items[0].approval?.resolution, 'accepted');
  assert.equal(result.items[0].approval?.inlineApprovable, false);
  assert.equal(result.items[0].approval?.expiresAt, undefined);
});

test('invalid or cross-owner source is isolated; all failures have no exact count or known-items dot', async (t) => {
  for (const invalid of ['foreign', 'malformed', 'offline']) {
    const app = Fastify();
    t.after(() => app.close());
    app.get('/api/approval-hub/pending', async () => ({ items: [approval('safe')] }));
    app.get('/api/entrusted-work/needs-me', async (_request, reply) =>
      invalid === 'foreign'
        ? {
            ownerReads: [
              {
                ...work([receipt('secret')]),
                envelope: { ...work([]).envelope, visibility: { ownerUserId: 'other' } },
              },
            ],
          }
        : invalid === 'malformed'
          ? { ownerReads: 'broken' }
          : reply.code(503).send({ error: 'offline' }),
    );
    const result = await readCompanionDecisionProjection(app, 'owner', { offset: 0, limit: 20 });
    assert.equal(result.status, 'partial');
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].summary, 'Choose safe');
    assert.equal(result.totalCount, undefined);
    assert.doesNotMatch(JSON.stringify(result), /secret|"other"/);
  }
  const app = Fastify();
  t.after(() => app.close());
  app.get('/api/approval-hub/pending', async (_request, reply) => reply.code(401).send({ error: 'expired' }));
  app.get('/api/entrusted-work/needs-me', async (_request, reply) => reply.code(403).send({ error: 'denied' }));
  const result = await readCompanionDecisionProjection(app, 'owner', { offset: 0, limit: 20 });
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.items, []);
  assert.equal(result.totalCount, undefined);
  assert.equal(result.sources.approvals.status, 'unauthenticated');
  assert.equal(result.sources.needsMe.status, 'forbidden');
});

test('late reads remain request-scoped and do not reuse rows after principal change', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  let unblock: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  app.get('/api/approval-hub/pending', async (request) => {
    const userId = String(request.headers['x-cat-cafe-user']);
    if (userId === 'owner') await blocked;
    return { items: [{ ...approval(userId), ownerUserId: userId }] };
  });
  app.get('/api/entrusted-work/needs-me', async () => ({ ownerReads: [] }));
  const oldRead = readCompanionDecisionProjection(app, 'owner', { offset: 0, limit: 20 });
  const newRead = await readCompanionDecisionProjection(app, 'new-owner', { offset: 0, limit: 20 });
  unblock();
  assert.equal(newRead.identity.ownerUserId, 'new-owner');
  assert.equal(newRead.items[0].summary, 'Choose new-owner');
  assert.equal((await oldRead).identity.ownerUserId, 'owner');
  assert.equal(newRead.items[0].summary, 'Choose new-owner');
});
