import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { planReevalClosureEvents } from '../../dist/infrastructure/harness-eval/reeval-closure-reconciler.js';
import { loadReevalClosureSubjects } from '../../dist/infrastructure/harness-eval/reeval-closure-task-spec.js';
import { evalHubRoutes } from '../../dist/routes/eval-hub.js';
import { createEvalHubCase, fixtureCaseId, fixtureCaseVerdictIds } from './eval-hub-corpus-fixture.js';

async function buildApp(harnessFeedbackRoot, lifecycleEventLog) {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = 'owner-user';
  });
  await app.register(evalHubRoutes, {
    harnessFeedbackRoot,
    ...(lifecycleEventLog ? { lifecycleEventLog } : {}),
  });
  return app;
}

async function caseItem(app) {
  const response = await app.inject({ method: 'GET', url: '/api/eval-hub/summary' });
  assert.equal(response.statusCode, 200, response.body);
  const item = response
    .json()
    .items.find((candidate) => candidate.harnessUnderEval.componentId === 'fixture-navigation');
  assert.ok(item, 'the stable capability-wakeup case must remain discoverable');
  return item;
}

async function stableCaseReplay(harnessFeedbackRoot) {
  const emptyEventLog = { read: async () => [] };
  const subjects = await loadReevalClosureSubjects({ harnessFeedbackRoot, eventLog: emptyEventLog });
  const subject = subjects.find(
    (candidate) =>
      'caseRoot' in candidate &&
      candidate.roots.some((root) => root.harnessUnderEval.componentId === 'fixture-navigation'),
  );
  assert.ok(subject && 'caseRoot' in subject);
  return {
    caseId: subject.caseRoot.caseId,
    expectedObservedVerdictIds: subject.caseRoot.cycles.map((cycle) => cycle.verdictId),
    events: planReevalClosureEvents(subject, '2026-08-09T02:00:00.000Z').map((planned) => planned.event),
  };
}

describe('Eval Hub lifecycle summary route', () => {
  // The latest independent cycle is keep_observe while its prior repair is unresolved.
  it('marks lifecycle not_required when latest verdict is keep_observe and event log absent', async (t) => {
    const app = await buildApp(createEvalHubCase(t));
    const item = await caseItem(app);

    assert.equal(item.lifecycle.availability, 'not_required');
    assert.equal(item.lifecycle.ownerResponseStatus, 'not_required');
    await app.close();
  });

  it('enriches the same item from canonical replay at the async route boundary', async (t) => {
    const root = createEvalHubCase(t);
    const replay = await stableCaseReplay(root);
    assert.equal(replay.caseId, fixtureCaseId);
    assert.deepEqual(replay.expectedObservedVerdictIds, fixtureCaseVerdictIds);
    const app = await buildApp(root, {
      async read(subjectId) {
        return subjectId === replay.caseId ? structuredClone(replay.events) : [];
      },
    });
    const item = await caseItem(app);

    assert.equal(item.lifecycle.availability, 'available');
    assert.equal(item.lifecycle.caseId, replay.caseId);
    assert.equal(item.lifecycle.closureStatus, 'escalated');
    assert.equal(item.lifecycle.activeVerdictId, fixtureCaseVerdictIds[0]);
    // This route test consumes an independent two-cycle case. Its contract is that
    // replay projects every cycle selected for the case, not that the weekly
    // corpus stops at a hard-coded date.
    assert.deepEqual(item.lifecycle.observedVerdictIds, replay.expectedObservedVerdictIds);
    assert.equal(item.lifecycle.targetOwnerCatId, 'opus-47');
    await app.close();
  });
});
