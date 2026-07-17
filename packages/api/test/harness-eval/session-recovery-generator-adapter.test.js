import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadEvalHubSummary } from '../../dist/infrastructure/harness-eval/hub/eval-hub-read-model.js';
import { createSessionRecoveryGeneratorAdapter } from '../../dist/infrastructure/harness-eval/publish-verdict/session-recovery-generator-adapter.js';
import { generateSessionRecoveryLiveVerdict } from '../../dist/infrastructure/harness-eval/session-recovery/eval-session-recovery-live-verdict.js';

const domain = {
  domainId: 'eval:session-recovery',
  displayName: 'Session Recovery Correctness',
  systemThreadId: 'thread_eval_session_recovery',
  evalCat: { catId: 'cat-vjdun65e', handle: '@cat-vjdun65e', model: 'gpt-5.6-sol' },
  frequency: 'weekly',
  sourceAdapter: 'session-recovery-eval',
  sourceRefsKind: 'session-recovery-window',
  threadPolicy: {
    role: 'working-home',
    stateSot: 'registry',
    allowedContent: ['longitudinal-analysis', 'verdict-discussion', 'handoff-drafts'],
  },
  legacyScheduledTaskIds: [],
  handoffTargetResolver: { featureId: 'F192', ownerCatId: 'cat-vjdun65e', threadLookup: 'feature-thread' },
  sla: { acknowledgeHours: 48, reevalWithinHours: 168 },
  fixtures: [],
  enabled: true,
};

function packet(id = 'session-recovery-live-test') {
  return {
    id,
    domainId: 'eval:session-recovery',
    createdAt: '2026-07-16T10:00:00.000Z',
    phenomenon: 'Session recovery trials were assessed against live transition anchors.',
    harnessUnderEval: { featureId: 'F192', componentId: 'session-recovery', name: 'session recovery correctness' },
    evidencePacket: {
      snapshotRefs: ['placeholder:snapshot'],
      attributionRefs: ['placeholder:attribution'],
      metricRefs: ['metric:session-recovery/assessed_total'],
      sampleTraceRefs: ['session:source-clean'],
    },
    dailyTrend: {
      window: '7d',
      current: { assessed_total: 2 },
      baseline: { assessed_total: 0 },
      threshold: { stale_count: 0 },
      direction: 'unknown',
    },
    rootCauseHypothesis: {
      summary: 'One observed target reconstructed stale state.',
      confidence: 'medium',
      alternatives: ['The stale assessment may be isolated to one runtime family.'],
    },
    verdict: 'fix',
    ownerAsk: {
      targetFeatureId: 'F192',
      targetOwnerCatId: 'cat-vjdun65e',
      requestedAction: 'Inspect the stale first-action evidence before changing the recovery protocol.',
    },
    acceptanceReevalPlan: {
      nextEvalAt: '2026-07-23T10:00:00.000Z',
      closureCondition: 'Two consecutive windows have zero stale or misaligned assessed trials.',
    },
    counterarguments: ['The sample is intentionally small and should not be generalized across all providers.'],
  };
}

function sessionRef(sessionId, seq, status) {
  return {
    sessionId,
    evidenceRef: `session:${sessionId}`,
    threadId: 'thread-1',
    catId: 'cat-vjdun65e',
    userId: 'owner-user',
    seq,
    status,
    createdAt: 1_000 + seq,
    ...(status === 'sealed' ? { sealedAt: 1_500 } : {}),
  };
}

function trial(sourceId, semantic = 'clean') {
  const source = sessionRef(sourceId, 1, 'sealed');
  const target = sessionRef(`${sourceId}-target`, 2, 'active');
  const firstMeaningfulEventRef = `transcript:${target.sessionId}:event:2`;
  const terminalEventRef = `transcript:${target.sessionId}:event:5`;
  return {
    trialId: `session-recovery:${target.sessionId}`,
    source,
    target,
    firstInvocationId: `inv-${sourceId}`,
    terminalEventRef,
    transcriptEvidenceStatus: 'available',
    evidenceRefs: [
      source.evidenceRef,
      target.evidenceRef,
      `invocation:inv-${sourceId}`,
      firstMeaningfulEventRef,
      terminalEventRef,
    ],
    assessment: {
      trialId: `session-recovery:${target.sessionId}`,
      stateReconstruction: semantic === 'clean' ? 'recovered' : 'stale',
      firstMeaningfulAction: semantic === 'clean' ? 'aligned' : 'misaligned',
      firstMeaningfulEventRef,
      outcome: semantic === 'clean' ? 'continued' : 'failed',
      evidenceRefs: [source.evidenceRef, firstMeaningfulEventRef],
      rationale: `PRIVATE FREE TEXT ${sourceId} MUST BE HASHED, NOT COMMITTED`,
    },
    transcriptBody: `SECRET TRANSCRIPT ${sourceId} MUST NOT BE COMMITTED`,
  };
}

function selector(trials) {
  return {
    kind: 'session-recovery-window',
    windowStartMs: 1_000,
    windowEndMs: 2_000,
    limit: trials.length,
    assessments: trials.map((item) => item.assessment),
  };
}

function seedRegistry(harnessFeedbackRoot) {
  mkdirSync(join(harnessFeedbackRoot, 'eval-domains'), { recursive: true });
  mkdirSync(join(harnessFeedbackRoot, 'verdicts'), { recursive: true });
  writeFileSync(
    join(harnessFeedbackRoot, 'eval-domains', 'eval-session-recovery.yaml'),
    `domainId: eval:session-recovery\ndisplayName: Session Recovery Correctness\nsystemThreadId: thread_eval_session_recovery\nevalCat:\n  catId: cat-vjdun65e\n  handle: "@cat-vjdun65e"\n  model: gpt-5.6-sol\nfrequency: weekly\nsourceAdapter: session-recovery-eval\nsourceRefsKind: session-recovery-window\nthreadPolicy:\n  role: working-home\n  stateSot: registry\n  allowedContent: [longitudinal-analysis, verdict-discussion, handoff-drafts]\nlegacyScheduledTaskIds: []\nhandoffTargetResolver:\n  featureId: F192\n  ownerCatId: cat-vjdun65e\n  threadLookup: feature-thread\nsla:\n  acknowledgeHours: 48\n  reevalWithinHours: 168\n`,
  );
}

describe('session recovery live verdict and generator adapter', () => {
  it('writes a sanitized, hashed, Eval-Hub-readable bundle without transcript or rationale text', () => {
    const root = mkdtempSync(join(tmpdir(), 'session-recovery-live-'));
    const harnessFeedbackRoot = join(root, 'docs', 'harness-feedback');
    seedRegistry(harnessFeedbackRoot);
    const trials = [trial('source-clean', 'clean'), trial('source-stale', 'stale')];

    const artifact = generateSessionRecoveryLiveVerdict({
      verdictId: 'session-recovery-live-test',
      harnessFeedbackRoot,
      domain,
      selector: selector(trials),
      trials,
      submittedPacket: packet(),
      generatedAt: '2026-07-16T10:00:00.000Z',
      generatorCommit: 'test-commit',
    });

    const rawPath = join(artifact.bundleDir, 'raw', 'session-recovery-trials.json');
    const rawBytes = readFileSync(rawPath);
    const raw = JSON.parse(rawBytes.toString('utf8'));
    const provenance = JSON.parse(readFileSync(join(artifact.bundleDir, 'provenance.json'), 'utf8'));
    assert.equal(raw.trials.length, 2);
    assert.equal(raw.trials[0].source.userId, undefined);
    assert.equal(raw.trials[0].transcriptBody, undefined);
    assert.equal(raw.trials[0].assessment.rationale, undefined);
    assert.match(raw.trials[0].assessment.rationaleSha256, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(rawBytes.toString('utf8'), /SECRET TRANSCRIPT|PRIVATE FREE TEXT/);
    assert.deepEqual(provenance.selector, { windowStartMs: 1_000, windowEndMs: 2_000, limit: 2 });
    assert.ok(provenance.sessionRefs.includes('session:source-clean'));
    assert.ok(provenance.invocationEventRefs.includes('transcript:source-stale-target:event:2'));
    assert.equal(provenance.rawInputs[0].sha256, createHash('sha256').update(rawBytes).digest('hex'));
    assert.equal(provenance.sanitizeRulesVersion, 'f192-session-recovery-v2');

    const summary = loadEvalHubSummary({ harnessFeedbackRoot });
    assert.equal(summary.items.length, 1);
    assert.equal(summary.items[0].domainId, 'eval:session-recovery');
    assert.equal(summary.items[0].harnessUnderEval.componentId, 'session-recovery');
    assert.equal(summary.items[0].trend.components[0].frictionCounts.stale_count, 1);
  });

  it('resolves owner-scoped assessed trials and rejects wrong kind, duplicates, or missing assessments', async () => {
    const root = mkdtempSync(join(tmpdir(), 'session-recovery-adapter-'));
    const harnessFeedbackRoot = join(root, 'docs', 'harness-feedback');
    seedRegistry(harnessFeedbackRoot);
    const assessed = trial('source-clean', 'clean');
    const calls = [];
    const adapter = createSessionRecoveryGeneratorAdapter({
      async resolve(receivedSelector, scope) {
        calls.push({ receivedSelector, scope });
        return [assessed];
      },
    });

    const artifact = await adapter(packet('session-recovery-adapter-test'), selector([assessed]), {
      harnessFeedbackRoot,
      liveHarnessFeedbackRoot: harnessFeedbackRoot,
      ownerUserId: 'owner-user',
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].scope, { ownerUserId: 'owner-user' });
    assert.equal(readFileSync(artifact.verdictPath, 'utf8').includes('domain_id: eval:session-recovery'), true);

    await assert.rejects(
      adapter(
        packet('wrong-kind'),
        { kind: 'memory-recall-snapshot', windowDays: 7 },
        {
          harnessFeedbackRoot,
          liveHarnessFeedbackRoot: harnessFeedbackRoot,
          ownerUserId: 'owner-user',
        },
      ),
      /session_recovery_adapter_wrong_kind/,
    );

    const duplicateAdapter = createSessionRecoveryGeneratorAdapter({ resolve: async () => [assessed, assessed] });
    await assert.rejects(
      duplicateAdapter(packet('duplicate-trials'), selector([assessed]), {
        harnessFeedbackRoot,
        liveHarnessFeedbackRoot: harnessFeedbackRoot,
        ownerUserId: 'owner-user',
      }),
      /duplicate_session_recovery_trial/,
    );

    const unassessedAdapter = createSessionRecoveryGeneratorAdapter({
      resolve: async () => [{ ...assessed, assessment: undefined }],
    });
    await assert.rejects(
      unassessedAdapter(packet('missing-assessment'), selector([assessed]), {
        harnessFeedbackRoot,
        liveHarnessFeedbackRoot: harnessFeedbackRoot,
        ownerUserId: 'owner-user',
      }),
      /missing_session_recovery_assessment/,
    );
  });
});
