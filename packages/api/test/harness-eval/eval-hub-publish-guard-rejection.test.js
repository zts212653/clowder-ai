import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { evalHubRoutes } from '../../dist/routes/eval-hub.js';

const harnessFeedbackRoot = fileURLToPath(new URL('../../../../docs/harness-feedback', import.meta.url));
const validPacket = {
  id: 'f257-publish-policy-route',
  domainId: 'eval:a2a',
  createdAt: '2026-08-14T00:00:00.000Z',
  phenomenon: 'publish authority rejection coverage',
  harnessUnderEval: { featureId: 'F257', componentId: 'publish-policy', name: 'publish policy' },
  evidencePacket: {
    snapshotRefs: ['snapshot:test'],
    attributionRefs: ['attribution:test'],
    metricRefs: ['metric:turn_custody.projections_total'],
    sampleTraceRefs: ['trace:test'],
  },
  dailyTrend: {
    window: '24h',
    current: { rejects: 1 },
    baseline: { rejects: 0 },
    threshold: { rejects: 1 },
    direction: 'regressed',
  },
  rootCauseHypothesis: { summary: 'wrong domain owner', confidence: 'high', alternatives: ['stale assignment'] },
  verdict: 'keep_observe',
  ownerAsk: { targetFeatureId: 'F257', targetOwnerCatId: 'opus-47', requestedAction: 'observe' },
  acceptanceReevalPlan: { nextEvalAt: '2026-08-21T00:00:00.000Z', closureCondition: 'no rejects' },
  counterarguments: ['test fixture'],
};

describe('eval hub publish-policy guard rejection ledger', () => {
  it('emits only for handler 403 and returns the ledger coordinate', async () => {
    const appended = [];
    const app = Fastify({ logger: false });
    app.register(evalHubRoutes, {
      harnessFeedbackRoot,
      callbackRegistry: { verify: async () => ({ ok: false, reason: 'unknown_invocation' }) },
      agentKeyRegistry: {
        verify: async () => ({
          ok: true,
          record: {
            agentKeyId: 'ak-f257',
            catId: 'opus-47',
            userId: 'owner-1',
            secretHash: 'unused',
            salt: 'unused',
            scope: 'user-bound',
            issuedAt: Date.now() - 1_000,
            expiresAt: Date.now() + 60_000,
          },
        }),
      },
      guardRejectionLog: { append: async (event) => void appended.push(event) },
      artifactPublisher: { publishArtifact: async () => assert.fail('publisher must not run') },
      verdictGenerators: { 'eval:a2a': async () => assert.fail('generator must not run') },
    });

    const headers = { 'x-agent-key-secret': 'secret', 'content-type': 'application/json' };
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/eval-domains/eval:a2a/publish-verdict',
      headers,
      payload: JSON.stringify({
        packet: validPacket,
        sourceRefs: { snapshotName: 'snapshot.yaml', attributionName: 'attribution.yaml' },
      }),
    });

    assert.equal(forbidden.statusCode, 403, forbidden.body);
    assert.equal(forbidden.json().ledgerId, 'eval/publish-verdict-authority');
    assert.equal(appended.length, 1);
    assert.deepEqual(
      {
        kind: appended[0].kind,
        guardId: appended[0].guardId,
        ledgerId: appended[0].ledgerId,
        catId: appended[0].catId,
        ownerUserId: appended[0].ownerUserId,
        threadId: appended[0].threadId,
        invocationId: appended[0].invocationId,
        correlationConfidence: appended[0].correlationConfidence,
      },
      {
        kind: 'publish_policy_reject',
        guardId: 'publish_verdict_authority',
        ledgerId: 'eval/publish-verdict-authority',
        catId: 'opus-47',
        ownerUserId: 'owner-1',
        threadId: 'unknown',
        invocationId: 'unknown',
        correlationConfidence: 'window',
      },
    );

    const unsupported = await app.inject({
      method: 'POST',
      url: '/api/eval-domains/eval:no-such-domain/publish-verdict',
      headers,
      payload: JSON.stringify({ packet: { ...validPacket, domainId: 'eval:no-such-domain' }, sourceRefs: {} }),
    });
    assert.notEqual(unsupported.statusCode, 403, unsupported.body);
    assert.equal(appended.length, 1, 'non-403 failures are not publish-policy rejects');
    await app.close();
  });
});
