import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';
import { createSessionRecoveryGeneratorAdapter } from '../../dist/infrastructure/harness-eval/publish-verdict/session-recovery-generator-adapter.js';

const DOMAIN_YAML = `domainId: eval:session-recovery
displayName: Session Recovery Correctness
systemThreadId: thread_eval_session_recovery
evalCat:
  catId: cat-vjdun65e
  handle: "@cat-vjdun65e"
  model: gpt-5.6-sol
frequency: weekly
sourceAdapter: session-recovery-eval
sourceRefsKind: session-recovery-window
threadPolicy:
  role: working-home
  stateSot: registry
  allowedContent: [longitudinal-analysis, verdict-discussion, handoff-drafts]
legacyScheduledTaskIds: []
handoffTargetResolver:
  featureId: F192
  ownerCatId: cat-vjdun65e
  threadLookup: feature-thread
sla:
  acknowledgeHours: 48
  reevalWithinHours: 168
`;

function seedHarness(root) {
  mkdirSync(join(root, 'eval-domains'), { recursive: true });
  mkdirSync(join(root, 'verdicts'), { recursive: true });
  mkdirSync(join(root, 'bundles'), { recursive: true });
  writeFileSync(join(root, 'eval-domains', 'eval-session-recovery.yaml'), DOMAIN_YAML);
}

function packet(id) {
  return {
    id,
    domainId: 'eval:session-recovery',
    createdAt: '2026-07-16T10:00:00.000Z',
    phenomenon: 'Session recovery publish validation test.',
    harnessUnderEval: { featureId: 'F192', componentId: 'session-recovery', name: 'session recovery correctness' },
    evidencePacket: {
      snapshotRefs: ['placeholder:snapshot'],
      attributionRefs: ['placeholder:attribution'],
      metricRefs: ['metric:session-recovery/assessed_total'],
      sampleTraceRefs: ['session:source-1'],
    },
    dailyTrend: {
      window: '7d',
      current: { assessed_total: 1 },
      baseline: { assessed_total: 0 },
      threshold: { stale_count: 0 },
      direction: 'flat',
    },
    rootCauseHypothesis: {
      summary: 'No regression in this fixture.',
      confidence: 'low',
      alternatives: ['Small sample.'],
    },
    verdict: 'keep_observe',
    ownerAsk: {
      targetFeatureId: 'F192',
      targetOwnerCatId: 'cat-vjdun65e',
      requestedAction: 'Keep observing the next bounded window.',
    },
    acceptanceReevalPlan: {
      nextEvalAt: '2026-07-23T10:00:00.000Z',
      closureCondition: 'The next bounded window remains recovered and aligned.',
    },
    counterarguments: ['A single fixture cannot establish a provider-wide trend.'],
  };
}

function assessment(overrides = {}) {
  return {
    trialId: 'session-recovery:target-1',
    stateReconstruction: 'recovered',
    firstMeaningfulAction: 'aligned',
    firstMeaningfulEventRef: 'transcript:target-1:event:2',
    outcome: 'continued',
    evidenceRefs: ['session:source-1', 'transcript:target-1:event:2'],
    rationale: 'The visible anchors match the live task state.',
    ...overrides,
  };
}

function sourceRefs(overrides = {}) {
  return {
    kind: 'session-recovery-window',
    windowStartMs: 1_000,
    windowEndMs: 2_000,
    assessments: [assessment()],
    ...overrides,
  };
}

function resolvedTrial() {
  return {
    trialId: 'session-recovery:target-1',
    source: {
      sessionId: 'source-1',
      evidenceRef: 'session:source-1',
      threadId: 'thread-1',
      catId: 'cat-vjdun65e',
      userId: 'owner-user',
      seq: 1,
      status: 'sealed',
      createdAt: 1_000,
      sealedAt: 1_500,
    },
    target: {
      sessionId: 'target-1',
      evidenceRef: 'session:target-1',
      threadId: 'thread-1',
      catId: 'cat-vjdun65e',
      userId: 'owner-user',
      seq: 2,
      status: 'active',
      createdAt: 1_501,
    },
    firstInvocationId: 'inv-target-1',
    terminalEventRef: 'transcript:target-1:event:5',
    transcriptEvidenceStatus: 'available',
    evidenceRefs: [
      'session:source-1',
      'session:target-1',
      'invocation:inv-target-1',
      'transcript:target-1:event:2',
      'transcript:target-1:event:5',
    ],
    assessment: assessment(),
  };
}

function buildDeps(provider) {
  const liveRoot = mkdtempSync(join(tmpdir(), 'publish-session-recovery-live-'));
  seedHarness(liveRoot);
  const isoRoot = mkdtempSync(join(tmpdir(), 'publish-session-recovery-iso-'));
  const isoHarness = join(isoRoot, 'docs', 'harness-feedback');
  seedHarness(isoHarness);
  return {
    deps: {
      harnessFeedbackRoot: liveRoot,
      generator: createSessionRecoveryGeneratorAdapter(provider),
      gitPublisher: {
        async publishOnIsolatedWorktree(options) {
          await options.stage(isoRoot);
          return { commitSha: 'session-recovery-sha', prUrl: 'https://example.test/pr/session-recovery' };
        },
      },
    },
  };
}

async function publish(deps, id, refs = sourceRefs(), ownerUserId = 'owner-user') {
  return handlePublishVerdict(deps, {
    packet: packet(id),
    domain: 'eval:session-recovery',
    catId: 'cat-vjdun65e',
    ownerUserId,
    sourceRefs: refs,
  });
}

describe('publish_verdict session recovery selector', () => {
  it('publishes assessed trials through the isolated-worktree generator', async () => {
    const { deps } = buildDeps({ resolve: async () => [resolvedTrial()] });
    const result = await publish(deps, 'session-recovery-publish-happy');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.commitSha, 'session-recovery-sha');
    assert.equal(result.verdictPath, 'docs/harness-feedback/verdicts/session-recovery-publish-happy.md');
  });

  it('rejects kind mismatch, invalid windows, missing assessments, and duplicate assessments before publish', async () => {
    let providerCalls = 0;
    const { deps } = buildDeps({
      resolve: async () => {
        providerCalls++;
        return [resolvedTrial()];
      },
    });
    const cases = [
      {
        id: 'session-recovery-kind-mismatch',
        refs: { kind: 'memory-recall-snapshot', windowDays: 7 },
        error: 'sourceRefs_kind_mismatch',
      },
      {
        id: 'session-recovery-invalid-window',
        refs: sourceRefs({ windowEndMs: 1_000 }),
        error: 'invalid_source_ref',
      },
      {
        id: 'session-recovery-missing-assessments',
        refs: sourceRefs({ assessments: undefined }),
        error: 'invalid_source_ref',
      },
      {
        id: 'session-recovery-duplicate-assessments',
        refs: sourceRefs({ assessments: [assessment(), assessment()] }),
        error: 'invalid_source_ref',
      },
    ];
    for (const item of cases) {
      const result = await publish(deps, item.id, item.refs);
      assert.equal(result.status, 400, `${item.id}: ${JSON.stringify(result)}`);
      assert.equal(result.error, item.error);
    }
    assert.equal(providerCalls, 0);
  });

  it('maps unknown trial IDs and forged evidence refs to fail-closed 400 responses', async () => {
    for (const [id, message] of [
      ['session-recovery-unknown-trial', 'unknown assessment trial: session-recovery:forged'],
      ['session-recovery-foreign-ref', 'foreign assessment evidence ref: transcript:other:event:1'],
    ]) {
      const { deps } = buildDeps({
        resolve: async () => {
          throw new Error(message);
        },
      });
      const result = await publish(deps, id);
      assert.equal(result.status, 400, JSON.stringify(result));
      assert.equal(result.error, 'invalid_assessment');
    }
  });

  it('maps correctable transcript evidence gaps to invalid_assessment instead of generator_failed', async () => {
    for (const message of [
      'semantic assessment requires available transcript evidence: session-recovery:target-1 (read_failed)',
      'semantic assessment requires a target transcript evidence ref: session-recovery:target-1',
    ]) {
      const { deps } = buildDeps({
        resolve: async () => {
          throw new Error(message);
        },
      });
      const result = await publish(deps, `session-recovery-evidence-gap-${message.includes('available') ? 'a' : 'b'}`);
      assert.equal(result.status, 400, JSON.stringify(result));
      assert.equal(result.error, 'invalid_assessment');
    }
  });
});
