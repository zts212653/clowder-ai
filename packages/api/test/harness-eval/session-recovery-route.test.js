import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { sessionRecoveryEvalRoutes } from '../../dist/routes/session-recovery-eval.js';

const PREVIEW_URL = '/api/eval-domains/eval:session-recovery/preview-trials';
const EVIDENCE_URL = '/api/eval-domains/eval:session-recovery/read-evidence';
const AUTH_HEADERS = {
  'x-invocation-id': 'inv-eval-session-recovery',
  'x-callback-token': 'token-eval-session-recovery',
};
const EVAL_CAT = 'cat-vjdun65e';
const HARNESS_FEEDBACK_ROOT = mkdtempSync(join(tmpdir(), 'session-recovery-route-'));

mkdirSync(join(HARNESS_FEEDBACK_ROOT, 'eval-domains'), { recursive: true });
writeFileSync(
  join(HARNESS_FEEDBACK_ROOT, 'eval-domains', 'eval-session-recovery.yaml'),
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

function callbackRegistry(userId = 'owner-user', catId = EVAL_CAT) {
  return {
    async verify(invocationId, callbackToken) {
      if (invocationId !== AUTH_HEADERS['x-invocation-id'] || callbackToken !== AUTH_HEADERS['x-callback-token']) {
        return { ok: false, reason: 'invalid_token' };
      }
      return {
        ok: true,
        record: {
          invocationId,
          callbackToken,
          userId,
          catId,
          threadId: 'thread-eval-session-recovery',
          clientMessageIds: new Set(),
          createdAt: 1,
          expiresAt: Number.MAX_SAFE_INTEGER,
        },
      };
    },
  };
}

function selector(overrides = {}) {
  return {
    kind: 'session-recovery-window',
    windowStartMs: 1_000,
    windowEndMs: 2_000,
    ...overrides,
  };
}

function evidenceRef(id, seq) {
  return {
    sessionId: id,
    evidenceRef: `session:${id}`,
    threadId: 'thread-1',
    catId: 'cat-vjdun65e',
    userId: 'owner-user',
    seq,
    status: seq === 1 ? 'sealed' : 'active',
    createdAt: 1_000 + seq,
    ...(seq === 1 ? { sealedAt: 1_500 } : {}),
  };
}

function emptyTranscriptReader() {
  return {
    async readEvents() {
      return { events: [], total: 0 };
    },
    async readDigest() {
      return null;
    },
    async readInvocationEvents() {
      return null;
    },
  };
}

async function buildApp(
  trialProvider,
  registry = callbackRegistry(),
  transcriptReader = emptyTranscriptReader(),
  routeOverrides = {},
) {
  const app = Fastify({ logger: false });
  await app.register(sessionRecoveryEvalRoutes, {
    trialProvider,
    transcriptReader,
    callbackRegistry: registry,
    harnessFeedbackRoot: HARNESS_FEEDBACK_ROOT,
    ...routeOverrides,
  });
  return app;
}

describe('session recovery eval preview route', () => {
  it('requires callback auth and rejects an invalid token', async () => {
    const app = await buildApp({ resolve: async () => [] });

    const missing = await app.inject({ method: 'POST', url: PREVIEW_URL, payload: { selector: selector() } });
    assert.equal(missing.statusCode, 401);

    const invalid = await app.inject({
      method: 'POST',
      url: PREVIEW_URL,
      headers: { ...AUTH_HEADERS, 'x-callback-token': 'wrong' },
      payload: { selector: selector() },
    });
    assert.equal(invalid.statusCode, 401);
    await app.close();
  });

  it('derives owner scope from the callback principal and ignores body spoofing', async () => {
    const calls = [];
    const app = await buildApp({
      async resolve(receivedSelector, scope) {
        calls.push({ receivedSelector, scope });
        return [];
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: PREVIEW_URL,
      headers: AUTH_HEADERS,
      payload: { selector: { ...selector(), ownerUserId: 'attacker-user' }, ownerUserId: 'attacker-user' },
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].scope, { ownerUserId: 'owner-user' });
    assert.equal(calls[0].receivedSelector.ownerUserId, undefined);
    await app.close();
  });

  it('maps invalid windows and unknown assessment trial IDs to fail-closed 400 responses', async () => {
    const app = await buildApp({
      async resolve(receivedSelector) {
        if (receivedSelector.windowEndMs - receivedSelector.windowStartMs > 31 * 86_400_000) {
          throw new Error('invalid_selector: window must not exceed 31 days');
        }
        throw new Error('unknown assessment trial: session-recovery:forged');
      },
    });

    const invalidWindow = await app.inject({
      method: 'POST',
      url: PREVIEW_URL,
      headers: AUTH_HEADERS,
      payload: { selector: selector({ windowEndMs: 32 * 86_400_000 + 1_000 }) },
    });
    assert.equal(invalidWindow.statusCode, 400, invalidWindow.body);
    assert.equal(invalidWindow.json().error, 'invalid_selector');

    const unknownTrial = await app.inject({
      method: 'POST',
      url: PREVIEW_URL,
      headers: AUTH_HEADERS,
      payload: {
        selector: selector({
          assessments: [
            {
              trialId: 'session-recovery:forged',
              stateReconstruction: 'unknown',
              firstMeaningfulAction: 'unknown',
              outcome: 'unknown',
              evidenceRefs: ['session:forged'],
              rationale: 'dry validation only',
            },
          ],
        }),
      },
    });
    assert.equal(unknownTrial.statusCode, 400, unknownTrial.body);
    assert.equal(unknownTrial.json().error, 'invalid_assessment');
    await app.close();
  });

  it('maps a saturated filtered scan to window_too_broad instead of an empty preview', async () => {
    const app = await buildApp({
      async resolve() {
        throw new Error(
          'session_scan_limit_reached: examined 1000 owner continuation targets before satisfying filters',
        );
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: PREVIEW_URL,
      headers: AUTH_HEADERS,
      payload: { selector: selector({ threadId: 'thread-match' }) },
    });

    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error, 'window_too_broad');
    await app.close();
  });

  it('maps correctable transcript evidence gaps to invalid_assessment', async () => {
    for (const detail of [
      'semantic assessment requires available transcript evidence: session-recovery:target-1 (read_failed)',
      'semantic assessment requires a target transcript evidence ref: session-recovery:target-1',
    ]) {
      const app = await buildApp({
        async resolve() {
          throw new Error(detail);
        },
      });
      const response = await app.inject({
        method: 'POST',
        url: PREVIEW_URL,
        headers: AUTH_HEADERS,
        payload: { selector: selector() },
      });
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(response.json().error, 'invalid_assessment');
      await app.close();
    }
  });

  it('ignores caller-supplied session/invocation IDs and reads only the resolved trial opening anchor', async () => {
    const reads = [];
    const source = evidenceRef('source-1', 1);
    const target = { ...evidenceRef('target-1', 2), catId: 'cat-ga18c3y8' };
    const app = await buildApp(
      {
        resolve: async () => [],
        async resolveTrial(receivedSelector, trialId, scope) {
          assert.deepEqual(receivedSelector, selector());
          assert.equal(trialId, 'session-recovery:target-1');
          assert.deepEqual(scope, { ownerUserId: 'owner-user' });
          return {
            trialId,
            source,
            target,
            firstInvocationId: 'inv-target-1',
            transcriptEvidenceStatus: 'available',
            evidenceRefs: ['session:source-1', 'session:target-1', 'invocation:inv-target-1'],
          };
        },
      },
      callbackRegistry(),
      {
        ...emptyTranscriptReader(),
        async readInvocationEvents(...args) {
          reads.push(args);
          return [{ eventNo: 2, event: { type: 'tool_use' } }];
        },
      },
    );
    const response = await app.inject({
      method: 'POST',
      url: EVIDENCE_URL,
      headers: AUTH_HEADERS,
      payload: {
        selector: selector(),
        trialId: 'session-recovery:target-1',
        evidenceKind: 'target_opening_invocation',
        sessionId: 'attacker-chosen-session',
        invocationId: 'attacker-chosen-invocation',
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(reads, [['target-1', 'thread-1', 'cat-ga18c3y8', 'inv-target-1']]);
    assert.doesNotMatch(response.body, /attacker-chosen/);
    assert.equal(response.json().events[0].evidenceRef, 'transcript:target-1:event:2');
    await app.close();
  });

  it('rejects a non-evaluator principal before resolving cross-cat evidence', async () => {
    let resolved = false;
    const app = await buildApp(
      {
        resolve: async () => [],
        async resolveTrial() {
          resolved = true;
          throw new Error('must not resolve');
        },
      },
      callbackRegistry('owner-user', 'cat-not-evaluator'),
    );

    const response = await app.inject({
      method: 'POST',
      url: EVIDENCE_URL,
      headers: AUTH_HEADERS,
      payload: {
        selector: selector(),
        trialId: 'session-recovery:target-1',
        evidenceKind: 'source_digest',
      },
    });

    assert.equal(response.statusCode, 403, response.body);
    assert.equal(response.json().error, 'not_allowed');
    assert.equal(resolved, false);
    await app.close();
  });

  it('uses the OQ-20 evaluator override and rejects the static evaluator while it is active', async () => {
    const overrideCat = 'cat-override-evaluator';
    const redis = {
      async get(key) {
        assert.equal(key, 'eval-domain:eval:session-recovery:evalCat-override');
        return JSON.stringify({
          catId: overrideCat,
          handle: '@override',
          model: 'override-model',
          setAt: '2026-07-17T00:00:00.000Z',
        });
      },
    };
    const provider = {
      resolve: async () => [],
      async resolveTrial() {
        throw new Error('session_recovery_evidence_not_found: expected after authorization');
      },
    };

    const overrideApp = await buildApp(provider, callbackRegistry('owner-user', overrideCat), emptyTranscriptReader(), {
      redis,
    });
    const overrideResponse = await overrideApp.inject({
      method: 'POST',
      url: EVIDENCE_URL,
      headers: AUTH_HEADERS,
      payload: {
        selector: selector(),
        trialId: 'session-recovery:target-1',
        evidenceKind: 'source_digest',
      },
    });
    assert.equal(overrideResponse.statusCode, 404, overrideResponse.body);
    await overrideApp.close();

    const staticApp = await buildApp(provider, callbackRegistry('owner-user', EVAL_CAT), emptyTranscriptReader(), {
      redis,
    });
    const staticResponse = await staticApp.inject({
      method: 'POST',
      url: EVIDENCE_URL,
      headers: AUTH_HEADERS,
      payload: {
        selector: selector(),
        trialId: 'session-recovery:target-1',
        evidenceKind: 'source_digest',
      },
    });
    assert.equal(staticResponse.statusCode, 403, staticResponse.body);
    assert.equal(staticResponse.json().error, 'not_allowed');
    await staticApp.close();
  });

  it('exposes only opening-event anchors accepted by the trial publish allowlist', async () => {
    const source = evidenceRef('source-1', 1);
    const target = evidenceRef('target-1', 2);
    const events = Array.from({ length: 150 }, (_, eventNo) => ({
      eventNo,
      invocationId: 'inv-target-1',
      event: { type: eventNo === 149 ? 'tool_use' : 'text' },
    }));
    const app = await buildApp(
      {
        resolve: async () => [],
        async resolveTrial() {
          return {
            trialId: 'session-recovery:target-1',
            source,
            target,
            firstInvocationId: 'inv-target-1',
            transcriptEvidenceStatus: 'available',
            evidenceRefs: [
              'session:source-1',
              'session:target-1',
              'invocation:inv-target-1',
              ...Array.from({ length: 100 }, (_, eventNo) => `transcript:target-1:event:${eventNo}`),
            ],
          };
        },
      },
      callbackRegistry(),
      {
        ...emptyTranscriptReader(),
        async readInvocationEvents() {
          return events;
        },
      },
    );

    const response = await app.inject({
      method: 'POST',
      url: EVIDENCE_URL,
      headers: AUTH_HEADERS,
      payload: {
        selector: selector(),
        trialId: 'session-recovery:target-1',
        evidenceKind: 'target_opening_invocation',
      },
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().events.length, 100);
    assert.equal(response.json().events.at(-1).evidenceRef, 'transcript:target-1:event:99');
    assert.equal(response.json().truncated, true);
    await app.close();
  });

  it('returns bounded anchor-first summaries without transcript bodies or owner IDs', async () => {
    const source = evidenceRef('source-1', 1);
    const target = evidenceRef('target-1', 2);
    const evidenceRefs = [
      source.evidenceRef,
      target.evidenceRef,
      'invocation:inv-target-1',
      ...Array.from({ length: 100 }, (_, index) => `transcript:target-1:event:${index}`),
    ];
    const app = await buildApp({
      async resolve() {
        return [
          {
            trialId: 'session-recovery:target-1',
            source,
            target,
            firstInvocationId: 'inv-target-1',
            terminalEventRef: 'transcript:target-1:event:99',
            transcriptEvidenceStatus: 'available',
            transcriptEvidenceTruncated: true,
            evidenceRefs,
            transcriptBody: 'SECRET TRANSCRIPT BODY MUST NOT LEAK',
          },
        ];
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: PREVIEW_URL,
      headers: AUTH_HEADERS,
      payload: { selector: selector({ limit: 1 }) },
    });

    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.count, 1);
    assert.equal(body.trials[0].source.userId, undefined);
    assert.equal(body.trials[0].target.sessionId, 'target-1');
    assert.ok(body.trials[0].evidenceRefs.length <= 25);
    assert.equal(body.trials[0].evidenceRefsTruncated, true);
    assert.ok(body.trials[0].evidenceRefs.includes('transcript:target-1:event:99'));
    assert.equal(body.trials[0].firstMeaningfulEventRef, undefined);
    assert.doesNotMatch(response.body, /SECRET TRANSCRIPT BODY/);
    assert.doesNotMatch(response.body, /owner-user/);
    await app.close();
  });
});
