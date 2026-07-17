import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';
import { createSessionRecoveryGeneratorAdapter } from '../../dist/infrastructure/harness-eval/publish-verdict/session-recovery-generator-adapter.js';
import { SessionRecoveryTrialProvider } from '../../dist/infrastructure/harness-eval/session-recovery/session-recovery-trial-provider.js';
import { sessionRecoveryEvalRoutes } from '../../dist/routes/session-recovery-eval.js';

const OWNER = 'owner-user';
const EVAL_CAT = 'cat-vjdun65e';
const SUBJECT_CAT = 'cat-ga18c3y8';
const AUTH_HEADERS = { 'x-invocation-id': 'inv-eval', 'x-callback-token': 'token-eval' };
const SELECTOR = { kind: 'session-recovery-window', windowStartMs: 1_000, windowEndMs: 3_000 };

function session(overrides) {
  return {
    id: 'source-1',
    cliSessionId: 'cli-source',
    threadId: 'thread-subject',
    catId: SUBJECT_CAT,
    userId: OWNER,
    seq: 1,
    status: 'sealed',
    sealReason: 'threshold',
    sealedAt: 1_500,
    messageCount: 3,
    createdAt: 1_000,
    updatedAt: 1_500,
    ...overrides,
  };
}

function event(eventNo, type, overrides = {}) {
  return {
    v: 1,
    t: 2_000 + eventNo,
    threadId: 'thread-subject',
    catId: SUBJECT_CAT,
    sessionId: 'target-1',
    cliSessionId: 'cli-target',
    invocationId: 'inv-target-1',
    eventNo,
    event: type === 'tool_use' ? { type, name: 'exec_command' } : { type },
    ...overrides,
  };
}

function seedHarness(root) {
  for (const dir of ['eval-domains', 'verdicts', 'bundles']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(
    join(root, 'eval-domains', 'eval-session-recovery.yaml'),
    `domainId: eval:session-recovery
displayName: Session Recovery Correctness
systemThreadId: thread_eval_session_recovery
evalCat: { catId: ${EVAL_CAT}, handle: "@${EVAL_CAT}", model: gpt-5.6-sol }
frequency: weekly
sourceAdapter: session-recovery-eval
sourceRefsKind: session-recovery-window
threadPolicy: { role: working-home, stateSot: registry, allowedContent: [longitudinal-analysis] }
legacyScheduledTaskIds: []
handoffTargetResolver: { featureId: F192, ownerCatId: ${EVAL_CAT}, threadLookup: feature-thread }
sla: { acknowledgeHours: 48, reevalWithinHours: 168 }
`,
  );
}

function packet() {
  return {
    id: 'session-recovery-cross-cat-e2e',
    domainId: 'eval:session-recovery',
    createdAt: '2026-07-17T00:00:00.000Z',
    phenomenon: 'Cross-cat trial remained evidence-grounded.',
    harnessUnderEval: { featureId: 'F192', componentId: 'session-recovery', name: 'session recovery' },
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
    rootCauseHypothesis: { summary: 'No regression.', confidence: 'low', alternatives: ['Small sample.'] },
    verdict: 'keep_observe',
    ownerAsk: { targetFeatureId: 'F192', targetOwnerCatId: EVAL_CAT, requestedAction: 'Continue observation.' },
    acceptanceReevalPlan: { nextEvalAt: '2026-07-24T00:00:00.000Z', closureCondition: 'Remain aligned.' },
    counterarguments: ['One trial is not a trend.'],
  };
}

describe('session recovery cross-cat live path', () => {
  it('lets the eval principal preview, drill a resolved foreign-cat trial, and publish its selected anchor', async () => {
    const source = session();
    const target = session({
      id: 'target-1',
      cliSessionId: 'cli-target',
      seq: 2,
      status: 'active',
      sealReason: undefined,
      sealedAt: undefined,
      createdAt: 2_000,
      updatedAt: 2_000,
      continuedFromSessionId: 'source-1',
      openedByInvocationId: 'inv-target-1',
    });
    const events = [event(0, 'session_init'), event(1, 'text'), event(2, 'tool_use'), event(3, 'done')];
    const sourceEvents = [
      event(7, 'text', {
        sessionId: 'source-1',
        cliSessionId: 'cli-source',
        invocationId: 'inv-source-1',
      }),
    ];
    const records = new Map([
      [source.id, source],
      [target.id, target],
    ]);
    const transcriptReader = {
      async readEvents(sessionId) {
        const selected = sessionId === target.id ? events : sessionId === source.id ? sourceEvents : [];
        return { events: selected, total: selected.length };
      },
      async readDigest(sessionId) {
        return sessionId === source.id ? { outstandingIntent: 'Verify current state.' } : null;
      },
      async readInvocationEvents(sessionId, _threadId, _catId, invocationId) {
        return sessionId === target.id && invocationId === 'inv-target-1' ? events : null;
      },
    };
    const provider = new SessionRecoveryTrialProvider({
      sessionStore: {
        scanContinuationTargets: () => [target],
        get: (id) => records.get(id) ?? null,
      },
      transcriptReader,
    });
    const liveRoot = mkdtempSync(join(tmpdir(), 'session-recovery-cross-cat-live-'));
    seedHarness(liveRoot);
    const app = Fastify({ logger: false });
    await app.register(sessionRecoveryEvalRoutes, {
      trialProvider: provider,
      transcriptReader,
      harnessFeedbackRoot: liveRoot,
      callbackRegistry: {
        async verify(id, token) {
          if (id !== AUTH_HEADERS['x-invocation-id'] || token !== AUTH_HEADERS['x-callback-token']) {
            return { ok: false, reason: 'invalid_token' };
          }
          return {
            ok: true,
            record: {
              invocationId: id,
              callbackToken: token,
              userId: OWNER,
              catId: EVAL_CAT,
              threadId: 'thread_eval_session_recovery',
              clientMessageIds: new Set(),
              createdAt: 1,
              expiresAt: 9e15,
            },
          };
        },
      },
    });

    const preview = await app.inject({
      method: 'POST',
      url: '/api/eval-domains/eval:session-recovery/preview-trials',
      headers: AUTH_HEADERS,
      payload: { selector: SELECTOR },
    });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(preview.json().trials[0].target.catId, SUBJECT_CAT);

    const sourceDrill = await app.inject({
      method: 'POST',
      url: '/api/eval-domains/eval:session-recovery/read-evidence',
      headers: AUTH_HEADERS,
      payload: { selector: SELECTOR, trialId: 'session-recovery:target-1', evidenceKind: 'source_digest' },
    });
    assert.equal(sourceDrill.statusCode, 200, sourceDrill.body);
    assert.equal(sourceDrill.json().digest.outstandingIntent, 'Verify current state.');

    const sourceEventsDrill = await app.inject({
      method: 'POST',
      url: '/api/eval-domains/eval:session-recovery/read-evidence',
      headers: AUTH_HEADERS,
      payload: {
        selector: SELECTOR,
        trialId: 'session-recovery:target-1',
        evidenceKind: 'source_events',
        view: 'handoff',
      },
    });
    assert.equal(sourceEventsDrill.statusCode, 200, sourceEventsDrill.body);
    assert.deepEqual(sourceEventsDrill.json().evidenceRefs, ['session:source-1']);
    assert.doesNotMatch(sourceEventsDrill.body, /transcript:source-1:event:7/);

    const drill = await app.inject({
      method: 'POST',
      url: '/api/eval-domains/eval:session-recovery/read-evidence',
      headers: AUTH_HEADERS,
      payload: { selector: SELECTOR, trialId: 'session-recovery:target-1', evidenceKind: 'target_opening_invocation' },
    });
    assert.equal(drill.statusCode, 200, drill.body);
    assert.equal(drill.json().events[2].eventNo, 2);

    const submitReadyRefs = [
      ...sourceEventsDrill.json().evidenceRefs,
      ...drill.json().events.map((item) => item.evidenceRef),
    ];
    const assessment = {
      trialId: 'session-recovery:target-1',
      stateReconstruction: 'recovered',
      firstMeaningfulAction: 'aligned',
      firstMeaningfulEventRef: 'transcript:target-1:event:2',
      outcome: 'continued',
      evidenceRefs: submitReadyRefs,
      rationale: 'Current-state inspection preceded the aligned tool action.',
    };
    const isoRoot = mkdtempSync(join(tmpdir(), 'session-recovery-cross-cat-iso-'));
    seedHarness(join(isoRoot, 'docs', 'harness-feedback'));
    const result = await handlePublishVerdict(
      {
        harnessFeedbackRoot: liveRoot,
        generator: createSessionRecoveryGeneratorAdapter(provider),
        gitPublisher: {
          async publishOnIsolatedWorktree(options) {
            await options.stage(isoRoot);
            return { commitSha: 'cross-cat-sha', prUrl: 'https://example.test/pr/cross-cat' };
          },
        },
      },
      {
        packet: packet(),
        domain: 'eval:session-recovery',
        catId: EVAL_CAT,
        ownerUserId: OWNER,
        sourceRefs: { ...SELECTOR, assessments: [assessment] },
      },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    await app.close();
  });
});
