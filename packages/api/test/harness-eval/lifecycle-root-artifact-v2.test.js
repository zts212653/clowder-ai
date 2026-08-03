import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCapabilityWakeupVerdictHandoff } from '../../dist/infrastructure/harness-eval/capability-wakeup/eval-capability-wakeup-verdict.js';
import {
  buildLifecycleRootArtifact,
  deriveEvalCaseId,
  LifecycleRootArtifactSchema,
} from '../../dist/infrastructure/harness-eval/publish-verdict/lifecycle-root-artifact.js';
import { domain } from './capability-wakeup-test-helpers.js';

function packet(overrides = {}) {
  return {
    id: 'capability-wakeup-2026-08-01-rich-messaging',
    domainId: 'eval:capability-wakeup',
    findingKey: 'rich-messaging',
    createdAt: '2026-08-01T12:00:00.000Z',
    phenomenon: 'rich-messaging missed the activation opportunity',
    harnessUnderEval: { featureId: 'F203', componentId: 'rich-messaging', name: 'rich-messaging' },
    evidencePacket: {
      snapshotRefs: ['snapshot:one'],
      attributionRefs: ['attribution:one'],
      metricRefs: ['miss_rate'],
      sampleTraceRefs: ['trace:one'],
    },
    dailyTrend: { window: '168h', current: {}, baseline: {}, threshold: {}, direction: 'regressed' },
    rootCauseHypothesis: { summary: 'attention missed', confidence: 'medium', alternatives: ['reachability'] },
    verdict: 'fix',
    ownerAsk: {
      targetFeatureId: 'F203',
      targetOwnerCatId: 'codex-sol',
      requestedAction: 'repair the activation path',
    },
    acceptanceReevalPlan: {
      nextEvalAt: '2026-08-08T12:00:00.000Z',
      closureCondition: 'the next real eval passes',
    },
    counterarguments: ['small sample'],
    ...overrides,
  };
}

describe('F266 lifecycle root v2 lineage', () => {
  it('lets the real capability-wakeup producer mint a stable finding identity', () => {
    const verdict = buildCapabilityWakeupVerdictHandoff({
      domain,
      capability: 'rich-messaging',
      createdAt: '2026-08-01T12:00:00.000Z',
      trials: [
        {
          capability: 'rich-messaging',
          outcome: 'miss',
          label: 'cognitive',
          ruleId: 'rich-messaging-missed',
          window: { currentInvocationId: 'inv-real' },
          opportunityEvidence: ['message:real-opportunity'],
        },
      ],
    });
    const artifact = buildLifecycleRootArtifact(verdict);

    assert.equal(verdict.findingKey, 'rich-messaging');
    assert.equal(artifact.schemaVersion, 2);
    assert.equal(artifact.caseId, deriveEvalCaseId('eval:capability-wakeup', 'rich-messaging'));
  });

  it('derives one stable case id for repeated verdict cycles of the same finding', () => {
    const first = buildLifecycleRootArtifact(packet());
    const next = buildLifecycleRootArtifact(
      packet({ id: 'capability-wakeup-2026-08-08-rich-messaging', createdAt: '2026-08-08T12:00:00.000Z' }),
    );
    const other = buildLifecycleRootArtifact(packet({ findingKey: 'workspace-navigator' }));

    assert.equal(first.schemaVersion, 2);
    assert.equal(first.caseId, next.caseId);
    assert.notEqual(first.caseId, other.caseId);
    assert.equal(first.caseId, deriveEvalCaseId('eval:capability-wakeup', 'rich-messaging'));
    assert.match(first.caseId, /^eval-case-v1-[a-f0-9]{64}$/);
  });

  it('keeps legacy packets on schema v1 and rejects caller-authored case ids', () => {
    const { findingKey: _findingKey, ...legacyPacket } = packet();
    const legacy = buildLifecycleRootArtifact(legacyPacket);

    assert.equal(legacy.schemaVersion, 1);
    assert.equal('caseId' in legacy, false);
    assert.equal(
      LifecycleRootArtifactSchema.safeParse({ ...buildLifecycleRootArtifact(packet()), caseId: 'caller-picked-case' })
        .success,
      false,
    );
  });
});
