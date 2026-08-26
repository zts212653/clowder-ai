import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { planReevalClosureEvents } from '../../dist/infrastructure/harness-eval/reeval-closure-reconciler.js';
import { loadReevalClosureSubjects } from '../../dist/infrastructure/harness-eval/reeval-closure-task-spec.js';
import { evalHubRoutes } from '../../dist/routes/eval-hub.js';

const harnessFeedbackRoot = fileURLToPath(new URL('../../../../docs/harness-feedback', import.meta.url));

async function buildApp(lifecycleEventLog) {
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

async function workspaceNavigatorItem(app) {
  const response = await app.inject({ method: 'GET', url: '/api/eval-hub/summary' });
  assert.equal(response.statusCode, 200, response.body);
  const item = response
    .json()
    .items.find((candidate) => candidate.harnessUnderEval.componentId === 'workspace-navigator');
  assert.ok(item, 'the stable capability-wakeup case must remain discoverable');
  return item;
}

async function stableCaseReplay() {
  const emptyEventLog = { read: async () => [] };
  const subjects = await loadReevalClosureSubjects({ harnessFeedbackRoot, eventLog: emptyEventLog });
  const subject = subjects.find(
    (candidate) =>
      'caseRoot' in candidate &&
      candidate.roots.some((root) => root.harnessUnderEval.componentId === 'workspace-navigator'),
  );
  assert.ok(subject && 'caseRoot' in subject);
  return {
    caseId: subject.caseRoot.caseId,
    events: planReevalClosureEvents(subject, '2026-08-09T02:00:00.000Z').map((planned) => planned.event),
  };
}

describe('Eval Hub lifecycle summary route', () => {
  // PR #3722: latest workspace-navigator verdict is now keep_observe (no-data),
  // so the no-event-log fallback returns not_required instead of unavailable.
  it('marks lifecycle not_required when latest verdict is keep_observe and event log absent', async () => {
    const app = await buildApp();
    const item = await workspaceNavigatorItem(app);

    assert.equal(item.lifecycle.availability, 'not_required');
    assert.equal(item.lifecycle.ownerResponseStatus, 'not_required');
    await app.close();
  });

  it('enriches the same item from canonical replay at the async route boundary', async () => {
    const replay = await stableCaseReplay();
    const app = await buildApp({
      async read(subjectId) {
        return subjectId === replay.caseId ? structuredClone(replay.events) : [];
      },
    });
    const item = await workspaceNavigatorItem(app);

    assert.equal(item.lifecycle.availability, 'available');
    assert.equal(item.lifecycle.caseId, replay.caseId);
    assert.equal(item.lifecycle.closureStatus, 'escalated');
    assert.equal(
      item.lifecycle.activeVerdictId,
      '2026-07-26-capability-wakeup-workspace-navigator-insufficient-fix-v2',
    );
    assert.deepEqual(item.lifecycle.observedVerdictIds, [
      '2026-07-12-capability-wakeup-workspace-navigator-cognitive-fix',
      '2026-07-19-capability-wakeup-workspace-navigator-fix-recheck-v2',
      '2026-07-26-capability-wakeup-workspace-navigator-insufficient-fix-v2',
      '2026-08-16-capability-wakeup-workspace-navigator-no-data-observe',
      '2026-08-23-capability-wakeup-workspace-navigator-no-data-observe',
    ]);
    assert.equal(item.lifecycle.targetOwnerCatId, 'opus-47');
    await app.close();
  });
});
