import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { buildLifecycleRootArtifact } from '../../dist/infrastructure/harness-eval/publish-verdict/lifecycle-root-artifact.js';
import { projectReevalCase } from '../../dist/infrastructure/harness-eval/reeval-case.js';
import { planReevalClosureEvents } from '../../dist/infrastructure/harness-eval/reeval-closure-reconciler.js';

const indexSource = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');
const availableVerdictRef = (value) => ({ kind: 'verdict', availability: 'available', value });

function packet(verdictId, createdAt, verdict = 'keep_observe') {
  return {
    id: verdictId,
    domainId: 'eval:trajectory-inspector',
    findingKey: 'utility-window',
    createdAt,
    phenomenon: 'Bounded trajectory utility window.',
    harnessUnderEval: { featureId: 'F299', componentId: 'trajectory-inspector-utility', name: 'Inspector' },
    evidencePacket: {
      snapshotRefs: [`snapshot:bundle/${verdictId}/snapshot`],
      attributionRefs: [`attribution:bundle/${verdictId}/no-finding`],
      metricRefs: ['metric:eligible_episodes'],
      sampleTraceRefs: ['snapshot:window'],
    },
    dailyTrend: { window: 'weekly', current: {}, baseline: {}, threshold: {}, direction: 'unknown' },
    rootCauseHypothesis: { summary: 'Calibration.', confidence: 'low', alternatives: ['Window drift.'] },
    verdict,
    ownerAsk: { targetFeatureId: 'F299', targetOwnerCatId: 'fable5', requestedAction: 'Observe.' },
    acceptanceReevalPlan: {
      nextEvalAt: '2026-09-07T03:00:00.000Z',
      closureCondition: 'A later trusted verdict replays the same case lineage.',
    },
    counterarguments: ['The bounded window may be incomplete.'],
  };
}

describe('eval:trajectory-inspector F192/F266 control-plane wiring', () => {
  it('constructs one runtime provider and flips generator-map and wired-domain support together', () => {
    const providerStart = indexSource.indexOf('const trajectoryInspectorProvider');
    const providerEnd = indexSource.indexOf("verdictGenerators['eval:trajectory-inspector']", providerStart);
    const providerWiring = indexSource.slice(providerStart, providerEnd);
    assert.match(indexSource, /new TrajectoryInspectorSourceProviderImpl/);
    assert.match(indexSource, /new RepoTrajectoryInspectorEvidenceSource/);
    assert.match(
      indexSource,
      /verdictGenerators\['eval:trajectory-inspector'\]\s*=\s*createTrajectoryInspectorGeneratorAdapter/,
    );
    assert.match(indexSource, /wiredPublishDomains\.add\('eval:trajectory-inspector'\)/);
    assert.match(indexSource, /resolveCanonicalInvocationTrajectory/);
    assert.match(providerWiring, /const owned = sessions\.filter\(\(session\) => session\.userId === input\.userId\)/);
    assert.match(providerWiring, /input\.invocationEventsBySession/);
    assert.match(providerWiring, /transcriptReader\.readInvocationEventsForSessions\(owned, invocationId, signal\)/);
    assert.match(providerWiring, /candidateLocator/);
    assert.match(providerWiring, /execution\.userId === ownerUserId/);
    assert.doesNotMatch(providerWiring, /readAllEvents/);
  });

  it('attaches a later trusted verdict to the same generic case and records the re-eval continuation', () => {
    const first = buildLifecycleRootArtifact(packet('f299-trajectory-week-a', '2026-08-24T20:00:00.000Z'));
    const next = buildLifecycleRootArtifact(packet('f299-trajectory-week-b', '2026-08-31T20:00:00.000Z'));
    assert.equal(first.caseId, next.caseId);
    const caseRoot = {
      caseId: first.caseId,
      domainId: first.domainId,
      targetOwnerCatId: 'fable5',
      assignedEvalCatId: 'codex-sol',
      cycles: [first, next].map(({ verdictId, createdAt, verdict }) => ({ verdictId, createdAt, verdict })),
    };
    const observed = {
      eventId: 'observe-f299-week-a',
      caseId: first.caseId,
      verdictId: first.verdictId,
      domainId: first.domainId,
      type: 'verdict_cycle_observed',
      actor: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
      occurredAt: '2026-08-24T20:01:00.000Z',
      cycleCreatedAt: first.createdAt,
      reason: 'first trusted cycle observed',
      refs: [availableVerdictRef(`verdict:${first.verdictId}`)],
    };
    const requested = {
      eventId: 'request-f299-week-a',
      caseId: first.caseId,
      verdictId: first.verdictId,
      domainId: first.domainId,
      type: 'reeval_requested',
      actor: { kind: 'cat', id: 'codex-sol' },
      occurredAt: '2026-08-31T19:00:00.000Z',
      dueAt: '2026-09-02T20:00:00.000Z',
      assignedEvalCatId: 'codex-sol',
      reason: 'weekly trajectory re-eval requested',
      refs: [availableVerdictRef(`verdict:${first.verdictId}`)],
    };
    const planned = planReevalClosureEvents(
      {
        caseRoot,
        roots: [first, next],
        assignedEvalCatId: 'codex-sol',
        acknowledgeHours: 48,
        events: [observed, requested],
        openRefsByVerdictId: new Map([
          [first.verdictId, [availableVerdictRef(`verdict:${first.verdictId}`)]],
          [next.verdictId, [availableVerdictRef(`verdict:${next.verdictId}`)]],
        ]),
        responsibilityContext: {
          systemThreadId: 'thread_eval_trajectory_inspector',
          featureId: 'F299',
          ownerCatId: 'fable5',
          evalCatId: 'codex-sol',
        },
      },
      '2026-08-31T20:01:00.000Z',
    );
    assert.deepEqual(
      planned.map((entry) => entry.event.type),
      ['verdict_cycle_observed', 'reeval_passed'],
    );
    const projection = projectReevalCase(caseRoot, [observed, requested, ...planned.map((entry) => entry.event)]);
    assert.equal(projection.activeVerdictId, next.verdictId);
    assert.equal(projection.status, 'monitoring');
    assert.deepEqual(projection.observedVerdictIds, [first.verdictId, next.verdictId]);
  });
});
