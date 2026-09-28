import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { registerCallbackRequestReviewOwnerRoutes } from '../dist/routes/callback-request-review-owner-routes.js';

const targetVersionRef = {
  ownerFeatureId: 'F100',
  ownerStateRef: 'skill:cat-cafe-skills/request-review/SKILL.md',
  version: 'a'.repeat(64),
  assetKind: 'skill',
  assetId: 'cat-cafe-skills/request-review/SKILL.md',
};
const candidateVersionRef = { ...targetVersionRef, version: 'b'.repeat(64) };
const receiptRef = { ownerFeatureId: 'F100', ownerStateRef: 'intervention:request-review-receipt' };
const boundReceipt = {
  kind: 'changed',
  caseRef: { ownerFeatureId: 'F266', ownerStateRef: 'eval-case:case-1', version: 'verdict-1' },
  proposalRef: { ownerFeatureId: 'F266', ownerStateRef: 'eval-repair-proposal:proposal-1' },
  approvalRef: { ownerFeatureId: 'F246', ownerStateRef: 'approval:proposal-1' },
  ownerAuthorizationRef: { ownerFeatureId: 'F100', ownerStateRef: 'authorization:request-review-v1' },
  targetVersionRef,
  interventionRef: {
    ownerFeatureId: 'F100',
    ownerStateRef: 'capability:development-process-harness-effectiveness',
  },
  receiptRef,
  assetVersionRef: candidateVersionRef,
  mainCommitSha: 'c'.repeat(40),
  loadedRuntimeRef: { ownerFeatureId: 'F302', ownerStateRef: 'runtime:alpha', version: 'c'.repeat(40) },
  changedAt: '2026-09-12T10:00:00.000Z',
  loadedAt: '2026-09-12T10:05:00.000Z',
};

describe('request-review owner callback route', () => {
  it('preflights F266 consumer availability and derives lifecycle bindings from the owner receipt', async () => {
    const app = Fastify({ logger: false });
    app.decorateRequest('callbackAuth', undefined);
    app.addHook('preHandler', async (request) => {
      request.callbackAuth = {
        invocationId: 'inv-owner',
        callbackToken: 'token',
        userId: 'owner-user',
        catId: request.headers['x-test-wrong-holder'] ? 'codex-terra' : 'codex-sol',
        threadId: 'thread-f100',
        ownerAuthProvenance: request.headers['x-test-untrusted'] ? 'unknown' : 'strict',
        originTriggerMessageId: 'message-owner-task',
        clientMessageIds: new Set(),
        createdAt: 0,
        expiresAt: Number.MAX_SAFE_INTEGER,
      };
    });
    const calls = [];
    const receipts = {
      async recordChanged(input) {
        calls.push({ kind: 'owner', input });
        return { status: 'recorded', receiptRef };
      },
      async resolveIntervention(ref) {
        calls.push({ kind: 'resolve', ref });
        return boundReceipt;
      },
      async recordNoChange() {
        throw new Error('not used');
      },
      async linkEvidence(input) {
        calls.push({ kind: 'evidence', input });
        return { status: 'recorded' };
      },
      async recordFreshOutcome() {
        throw new Error('not used');
      },
      async resolveFreshOutcome() {
        throw new Error('not used');
      },
      async recordRollback() {
        throw new Error('not used');
      },
    };
    let outcomeService;
    registerCallbackRequestReviewOwnerRoutes(app, {
      ownerUserId: 'owner-user',
      receipts,
      resolveOutcomeService: () => outcomeService,
      factAuthority: {
        async authorize({ principal, proposalId }) {
          calls.push({ kind: 'authority', principal, proposalId });
          return principal.catId === 'codex-sol'
            ? { status: 'authorized' }
            : { status: 'blocked', reason: 'owner_custody_mismatch' };
        },
      },
    });
    await app.ready();
    const payload = {
      type: 'changed',
      proposalId: 'proposal-1',
      assetVersionRef: candidateVersionRef,
      mainCommitSha: 'c'.repeat(40),
      loadedRuntimeRef: boundReceipt.loadedRuntimeRef,
      changedAt: boundReceipt.changedAt,
      loadedAt: boundReceipt.loadedAt,
    };

    const unavailable = await app.inject({
      method: 'POST',
      url: '/api/callbacks/request-review-owner/facts',
      payload,
    });
    assert.equal(unavailable.statusCode, 503);
    assert.equal(calls.length, 0, 'no F100 event may land before the F266 consumer is available');

    outcomeService = {
      async recordIntervention(input) {
        calls.push({ kind: 'lifecycle', input });
        return { status: 'recorded', kind: 'changed' };
      },
      async recordOutcome() {
        throw new Error('not used');
      },
    };
    const recorded = await app.inject({
      method: 'POST',
      url: '/api/callbacks/request-review-owner/facts',
      payload,
    });
    assert.equal(recorded.statusCode, 200);
    assert.equal(recorded.json().lifecycle.status, 'recorded');
    assert.deepEqual(
      calls.map((call) => call.kind),
      ['authority', 'owner', 'resolve', 'lifecycle'],
    );
    assert.deepEqual(calls[3].input.caseRef, boundReceipt.caseRef);
    assert.deepEqual(calls[3].input.approvalRef, boundReceipt.approvalRef);

    calls.length = 0;
    const evidenceRecorded = await app.inject({
      method: 'POST',
      url: '/api/callbacks/request-review-owner/facts',
      payload: {
        type: 'evidence',
        proposalId: 'proposal-1',
        assetVersionRef: candidateVersionRef,
        role: 'candidate_independent_verification',
        evidenceRef: { ownerFeatureId: 'F192', ownerStateRef: 'evidence:f100-review' },
        proofRef: { ownerFeatureId: 'F267', ownerStateRef: 'proof:f100-review' },
        status: 'verified',
      },
    });
    assert.equal(evidenceRecorded.statusCode, 200);
    assert.deepEqual(
      calls.map((call) => call.kind),
      ['authority', 'evidence'],
    );
    assert.equal(Object.hasOwn(calls[1].input, 'type'), false, 'transport discriminant must not enter owner facts');

    calls.length = 0;
    const wrongHolder = await app.inject({
      method: 'POST',
      url: '/api/callbacks/request-review-owner/facts',
      headers: { 'x-test-wrong-holder': 'true' },
      payload,
    });
    assert.equal(wrongHolder.statusCode, 403);
    assert.deepEqual(
      calls.map((call) => call.kind),
      ['authority'],
      'a strict same-user invocation outside active Task/F167 custody must have zero owner effects',
    );

    const untrusted = await app.inject({
      method: 'POST',
      url: '/api/callbacks/request-review-owner/facts',
      headers: { 'x-test-untrusted': 'true' },
      payload,
    });
    assert.equal(untrusted.statusCode, 403);
    await app.close();
  });
});
