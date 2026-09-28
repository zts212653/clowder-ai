import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { MemoryRequestReviewOwnerLedger } from '../dist/infrastructure/capability-evolution/adapters/request-review/request-review-owner-ledger.js';
import { RequestReviewUseReceiptService } from '../dist/infrastructure/capability-evolution/adapters/request-review/request-review-use-receipt.js';
import { registerCallbackSkillConsumptionRoutes } from '../dist/routes/callback-skill-consumption-routes.js';

const assetVersionRef = {
  ownerFeatureId: 'F100',
  ownerStateRef: 'skill:cat-cafe-skills/request-review/SKILL.md',
  version: 'a'.repeat(64),
  assetKind: 'skill',
  assetId: 'cat-cafe-skills/request-review/SKILL.md',
};

describe('request-review consumption callback routes', () => {
  it('requires author preparation, exact reviewer invocation binding, and typed verdict settlement', async () => {
    const app = Fastify({ logger: false });
    app.decorateRequest('callbackAuth', undefined);
    app.decorateRequest('callbackPrincipal', undefined);
    const messages = new Map();
    const invocations = new Map();
    const ledger = new MemoryRequestReviewOwnerLedger();
    const receipts = new RequestReviewUseReceiptService({
      ledger,
      messageStore: { getById: async (id) => messages.get(id) ?? null },
      invocationRegistry: { peekRecord: async (id) => invocations.get(id) ?? null },
      versionAttestor: {
        deliver: async (ref) => ({
          status: 'attested',
          deliveredAssetVersionRef: ref,
          deliveredPackageRevision: `sha256:${'e'.repeat(64)}`,
        }),
      },
      randomToken: () => 'route-handle',
      now: () => '2026-09-12T11:00:00.000Z',
    });
    app.addHook('preHandler', async (request) => {
      const reviewer = request.headers['x-test-role'] === 'reviewer';
      const agentKey = request.headers['x-test-role'] === 'agent-key';
      const untrustedAuthor = request.headers['x-test-role'] === 'untrusted-author';
      const originlessAuthor = request.headers['x-test-role'] === 'originless-author';
      if (agentKey) {
        request.callbackPrincipal = {
          kind: 'agent_key',
          agentKeyId: 'agent-key-1',
          userId: 'owner-user',
          catId: 'codex-sol',
          scope: 'user-bound',
        };
        return;
      }
      const auth = reviewer
        ? {
            invocationId: 'inv-reviewer',
            userId: 'owner-user',
            threadId: 'thread-review',
            catId: 'codex-terra',
          }
        : {
            invocationId: 'inv-author',
            userId: 'owner-user',
            threadId: 'thread-review',
            catId: 'codex-sol',
          };
      request.callbackAuth = {
        ...auth,
        callbackToken: 'token',
        ownerAuthProvenance: untrustedAuthor ? 'unknown' : 'strict',
        ...(originlessAuthor ? {} : { originTriggerMessageId: 'message-author-origin' }),
        clientMessageIds: new Set(),
        createdAt: 0,
        expiresAt: Number.MAX_SAFE_INTEGER,
      };
      request.callbackPrincipal = { kind: 'invocation', ...auth };
    });
    registerCallbackSkillConsumptionRoutes(app, {
      receipts: {},
      requestReviewReceipts: receipts,
    });
    await app.ready();

    const preparePayload = {
      assetVersionRef,
      reviewerCatId: 'codex-terra',
      reviewSubjectRef: 'pr:owner/cat-cafe#4512',
      reviewedHeadSha: 'b'.repeat(40),
      acceptedSourceRef: 'docs/features/F314-development-episode-alignment-experiment.md',
      acceptedRevision: 'c'.repeat(40),
    };
    for (const role of ['untrusted-author', 'originless-author']) {
      const rejected = await app.inject({
        method: 'POST',
        url: '/api/callbacks/request-review-consumption/prepare',
        headers: { 'x-test-role': role },
        payload: preparePayload,
      });
      assert.equal(rejected.statusCode, 403);
      assert.deepEqual(await ledger.read(), [], `${role} must have zero F100 reservation effects`);
    }

    const prepared = await app.inject({
      method: 'POST',
      url: '/api/callbacks/request-review-consumption/prepare',
      payload: preparePayload,
    });
    assert.equal(prepared.statusCode, 200);
    assert.equal(prepared.json().handle, 'route-handle');

    messages.set('message-request', {
      id: 'message-request',
      threadId: 'thread-review',
      catId: 'codex-sol',
      content: [
        'Review this.',
        'Review-Subject-Ref: pr:owner/cat-cafe#4512',
        `Reviewed-Head-Sha: ${'b'.repeat(40)}`,
        'Request-Review-Consumption-Handle: route-handle',
        'Accepted-Source-Ref: docs/features/F314-development-episode-alignment-experiment.md',
        `Accepted-Revision: ${'c'.repeat(40)}`,
      ].join('\n'),
      mentions: ['codex-terra'],
      extra: {
        targetCats: ['codex-terra'],
        stream: { invocationId: 'inv-author', turnInvocationId: 'inv-author' },
      },
    });
    invocations.set('inv-reviewer', {
      invocationId: 'inv-reviewer',
      userId: 'owner-user',
      catId: 'codex-terra',
      threadId: 'thread-review',
      ownerAuthProvenance: 'strict',
      originTriggerMessageId: 'message-request',
    });
    const bound = await app.inject({
      method: 'POST',
      url: '/api/callbacks/request-review-consumption/bind',
      headers: { 'x-test-role': 'reviewer' },
      payload: { handle: 'route-handle' },
    });
    assert.equal(bound.statusCode, 200);
    assert.equal(bound.json().status, 'bound');

    messages.set('message-review', {
      id: 'message-review',
      threadId: 'thread-review',
      catId: 'codex-terra',
      content: 'REQUEST_CHANGES',
      mentions: ['codex-sol'],
      extra: {
        stream: { invocationId: 'inv-reviewer', turnInvocationId: 'inv-reviewer' },
        localReviewVerdict: {
          verdict: 'changes_requested',
          clientMessageId: 'review-result',
          reviewedHeadSha: 'b'.repeat(40),
          reviewSubjectRef: 'pr:owner/cat-cafe#4512',
          acceptedSourceRef: 'docs/features/F314-development-episode-alignment-experiment.md',
          acceptedRevision: 'c'.repeat(40),
        },
      },
    });
    const recorded = await app.inject({
      method: 'POST',
      url: '/api/callbacks/request-review-consumption/record',
      headers: { 'x-test-role': 'reviewer' },
      payload: { handle: 'route-handle', reviewMessageId: 'message-review' },
    });
    assert.equal(recorded.statusCode, 200);
    assert.equal(recorded.json().receipt.use, 'applied');
    assert.equal(recorded.json().receipt.invocationRef.ownerStateRef, 'inv:inv-reviewer');

    const unsupported = await app.inject({
      method: 'POST',
      url: '/api/callbacks/request-review-consumption/prepare',
      headers: { 'x-test-role': 'agent-key' },
      payload: preparePayload,
    });
    assert.equal(unsupported.statusCode, 409);
    await app.close();
  });
});
