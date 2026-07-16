import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { sessionRecoveryEvalRoutes } from '../../dist/routes/session-recovery-eval.js';

const PREVIEW_URL = '/api/eval-domains/eval:session-recovery/preview-trials';
const AUTH_HEADERS = {
  'x-invocation-id': 'inv-eval-session-recovery',
  'x-callback-token': 'token-eval-session-recovery',
};

function callbackRegistry(userId = 'owner-user') {
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
          catId: 'cat-vjdun65e',
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

async function buildApp(trialProvider, registry = callbackRegistry()) {
  const app = Fastify({ logger: false });
  await app.register(sessionRecoveryEvalRoutes, {
    trialProvider,
    callbackRegistry: registry,
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

  it('returns bounded anchor-first summaries without transcript bodies or owner IDs', async () => {
    const source = evidenceRef('source-1', 1);
    const target = evidenceRef('target-1', 2);
    const duplicateTargets = Array.from({ length: 20 }, (_, index) => evidenceRef(`duplicate-${index}`, index + 2));
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
            trialId: 'session-recovery:source-1',
            source,
            target,
            duplicateTargets,
            lineage: 'duplicate',
            transitionIntegrity: 'fail',
            delivery: 'provider_dispatched',
            structuralIssues: ['duplicate continuation targets'],
            firstInvocationId: 'inv-target-1',
            firstMeaningfulEventRef: 'transcript:target-1:event:90',
            terminalEventRef: 'transcript:target-1:event:99',
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
    assert.equal(body.trials[0].duplicateTargetCount, 20);
    assert.ok(body.trials[0].duplicateTargets.length <= 10);
    assert.equal(body.trials[0].duplicateTargetsTruncated, true);
    assert.ok(body.trials[0].evidenceRefs.length <= 25);
    assert.equal(body.trials[0].evidenceRefsTruncated, true);
    assert.ok(body.trials[0].evidenceRefs.includes('transcript:target-1:event:90'));
    assert.ok(body.trials[0].evidenceRefs.includes('transcript:target-1:event:99'));
    assert.doesNotMatch(response.body, /SECRET TRANSCRIPT BODY/);
    assert.doesNotMatch(response.body, /owner-user/);
    await app.close();
  });
});
