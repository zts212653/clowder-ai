import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

import { enrichEvalHubLifecycle } from '../../dist/infrastructure/harness-eval/hub/eval-hub-lifecycle-projection.js';
import { classifyReevalCaseRoot } from '../../dist/infrastructure/harness-eval/reeval-case-root.js';
import { planReevalClosureEvents } from '../../dist/infrastructure/harness-eval/reeval-closure-reconciler.js';
import {
  createReevalClosureTaskSpec,
  loadReevalClosureSubjects,
} from '../../dist/infrastructure/harness-eval/reeval-closure-task-spec.js';
import { evalVerdictLifecycleRoutes } from '../../dist/routes/eval-verdict-lifecycle.js';

const verdictId = 'f313-v3-quarantined-child';

class CountingEventLog {
  readCalls = 0;
  appendCalls = 0;

  async append() {
    this.appendCalls += 1;
    return { outcome: 'appended', sequence: 0 };
  }

  async read() {
    this.readCalls += 1;
    return [];
  }

  async listVerdictIds() {
    return [];
  }

  async listSubjectIds() {
    return [];
  }
}

function setupV3Root(t) {
  const root = mkdtempSync(join(tmpdir(), 'f313-v3-quarantine-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'bundles', verdictId), { recursive: true });
  mkdirSync(join(root, 'eval-domains'), { recursive: true });
  writeFileSync(
    join(root, 'bundles', verdictId, 'lifecycle-root.json'),
    `${JSON.stringify({
      schemaVersion: 3,
      caseId: `eval-case-v1-${'a'.repeat(64)}`,
      findingKey: 'evidence-reader-drilldown-path',
      findingBinding: {
        artifactRef: `docs/harness-feedback/bundles/${verdictId}/finding.json`,
        artifactSha256: 'b'.repeat(64),
        analysisDisposition: 'repair',
        approvalRequirement: { kind: 'required', reason: 'repair' },
      },
      repairTarget: {
        featureId: 'F188',
        ownerCatId: 'codex-sol',
        version: `repair-target-v1-${'c'.repeat(64)}`,
        resolutionRef: 'feature-thread-owner:v1:F188:thread_f188:codex-sol',
        resolvedAt: '2026-08-29T12:00:00.000Z',
      },
      verdictId,
      domainId: 'eval:friction',
      createdAt: '2026-08-29T12:00:00.000Z',
      verdict: 'fix',
      harnessUnderEval: { featureId: 'F245', componentId: 'friction-rollup', name: 'Friction rollup' },
      ownerAsk: {
        targetFeatureId: 'F188',
        targetOwnerCatId: 'codex-sol',
        requestedAction: 'repair the evidence reader drilldown path',
      },
      acceptanceReevalPlan: {
        nextEvalAt: '2026-09-05T12:00:00.000Z',
        closureCondition: 'a fresh friction window passes',
      },
    })}\n`,
  );
  writeFileSync(
    join(root, 'eval-domains', 'eval-friction.yaml'),
    `domainId: eval:friction
displayName: Friction Signal Eval
systemThreadId: thread_eval_friction
evalCat: { catId: gpt52, handle: '@gpt52', model: gpt-5.4 }
frequency: weekly
sourceAdapter: f245-friction-rollup
sourceRefsKind: friction-rollup-snapshot
threadPolicy: { role: working-home, stateSot: registry, allowedContent: [verdict-discussion] }
legacyScheduledTaskIds: []
handoffTargetResolver: { featureId: F245, ownerCatId: opus-47, threadLookup: feature-thread }
sla: { acknowledgeHours: 48, reevalWithinHours: 168 }
fixtures: []
`,
  );
  return root;
}

function summary() {
  return {
    generatedAt: '2026-08-30T12:00:00.000Z',
    counts: { total: 1, actionable: 1, keepObserve: 0, stale: 0, registeredDomains: 1 },
    items: [
      {
        id: verdictId,
        domainId: 'eval:friction',
        verdict: 'fix',
        harnessUnderEval: { featureId: 'F245', componentId: 'friction-rollup', name: 'Friction rollup' },
        evidence: { attributionRefs: ['bundle:attribution'], metricRefs: ['friction.cluster_count'] },
        lifecycle: {
          availability: 'unavailable',
          ownerResponseStatus: 'unavailable',
          closureStatus: 'unavailable',
          stale: false,
          unavailableReason: 'canonical lifecycle event log unavailable',
        },
      },
    ],
  };
}

describe('F313 schema-v3 re-evaluation root quarantine', () => {
  it('activates v3 atomically only with the cutover token and creates no custody before Approval', async (t) => {
    const root = setupV3Root(t);
    const eventLog = new CountingEventLog();
    const cutover = { lifecycleVersion: 1 };
    const classified = classifyReevalCaseRoot(root, verdictId, undefined, cutover);
    assert.equal(classified.status, 'available');

    const subjects = await loadReevalClosureSubjects({
      harnessFeedbackRoot: root,
      eventLog,
      frictionV3Cutover: cutover,
    });
    assert.equal(subjects.length, 1);
    const planned = planReevalClosureEvents(subjects[0], '2026-08-30T12:00:00.000Z');
    assert.deepEqual(
      planned.map(({ event }) => event.type),
      ['verdict_cycle_observed', 'case_ready_for_proposal'],
    );
    assert.ok(planned.every(({ event }) => !('taskId' in event) && !('leaseId' in event)));
    assert.equal(eventLog.appendCalls, 0, 'pure planning cannot create Proposal/Card/Task/lease side effects');
  });

  it('recognizes v3 while suppressing every Phase C side effect and event-log read', async (t) => {
    const root = setupV3Root(t);
    const eventLog = new CountingEventLog();
    let responsibilityCalls = 0;
    let reevaluationCalls = 0;
    const classified = classifyReevalCaseRoot(root, verdictId);
    assert.equal(classified.status, 'known-but-quarantined');
    assert.deepEqual(classified.diagnostic.effects, {
      openCase: false,
      approvalProposal: false,
      approvalCard: false,
      task: false,
      f167Lease: false,
    });

    assert.deepEqual(await loadReevalClosureSubjects({ harnessFeedbackRoot: root, eventLog }), []);
    const task = createReevalClosureTaskSpec({
      eventLog,
      loadSubjects: () => loadReevalClosureSubjects({ harnessFeedbackRoot: root, eventLog }),
      responsibilityService: {
        async reconcile() {
          responsibilityCalls += 1;
        },
      },
      reevaluationService: {
        async needsReconcile() {
          return true;
        },
        async reconcile() {
          reevaluationCalls += 1;
        },
      },
      log: { info() {}, warn() {} },
    });
    assert.equal((await task.admission.gate({ taskId: task.id, lastRunAt: null, tickCount: 1 })).run, false);

    const enriched = await enrichEvalHubLifecycle(summary(), { harnessFeedbackRoot: root, eventLog });
    assert.equal(
      enriched.items[0].lifecycle.unavailableReason,
      'schema-v3 known but quarantined until Phase C cutover',
    );
    assert.equal(enriched.items[0].lifecycle.caseId, undefined);
    assert.equal(enriched.items[0].lifecycle.taskId, undefined);
    assert.equal(enriched.items[0].lifecycle.leaseId, undefined);
    assert.equal(enriched.counts.actionable, 0);
    assert.equal(eventLog.readCalls, 0);
    assert.equal(eventLog.appendCalls, 0);
    assert.equal(responsibilityCalls, 0);
    assert.equal(reevaluationCalls, 0);
  });

  it('rejects lifecycle commands with a typed quarantine diagnostic and no append', async (t) => {
    const root = setupV3Root(t);
    const eventLog = new CountingEventLog();
    const app = Fastify({ logger: false });
    await app.register(evalVerdictLifecycleRoutes, {
      harnessFeedbackRoot: root,
      eventLog,
      callbackRegistry: {
        async verify() {
          return {
            ok: true,
            record: {
              invocationId: 'owner-invocation',
              callbackToken: 'valid',
              userId: 'owner-user',
              catId: 'codex-sol',
              threadId: 'thread_f313',
              clientMessageIds: new Set(),
              createdAt: Date.now() - 1_000,
              expiresAt: Date.now() + 60_000,
            },
          };
        },
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/eval-verdicts/${verdictId}/lifecycle-events`,
      headers: { 'x-invocation-id': 'owner-invocation', 'x-callback-token': 'valid' },
      payload: {
        type: 'plan_action',
        eventId: 'forbidden-v3-command',
        expectedSequence: 0,
        reason: 'must remain quarantined',
        refs: [{ kind: 'message', availability: 'available', value: 'thread:f313' }],
      },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, 'friction_lifecycle_v3_quarantined');
    assert.equal(response.json().status, 'known-but-quarantined');
    assert.equal(eventLog.readCalls, 0);
    assert.equal(eventLog.appendCalls, 0);
    await app.close();
  });
});
