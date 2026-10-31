// @ts-check
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { anchorApproval } from './approval-hub/helpers.js';

// ── Minimal stubs ──

function makeSocketManager() {
  const emitted = [];
  return {
    emitToUser: (userId, event, data) => emitted.push({ userId, event, data }),
    broadcastToRoom: () => {},
    _emitted: emitted,
  };
}

// Inject a minimal callback-auth prehandler that reads x-invocation-id header
// We need to register the requireCallbackAuth decorator for the route to work.
// Since we can't easily replicate the full auth stack, we'll test the route logic
// by calling the store directly through the decision routes (user-auth).

describe('taste-proposal-decision-routes', () => {
  let InMemoryTasteProposalStore;
  let registerTasteProposalDecisionRoutes;
  let store;
  let app;
  let socketManager;
  /** @type {(proposal: any) => Promise<{slug: string, path: string}>} */
  let mockWriter;
  let writerCalls;

  beforeEach(async () => {
    ({ InMemoryTasteProposalStore } = await import('../dist/domains/taste/stores/InMemoryTasteProposalStore.js'));
    ({ registerTasteProposalDecisionRoutes } = await import('../dist/routes/taste-proposal-decision-routes.js'));
    store = new InMemoryTasteProposalStore();
    socketManager = makeSocketManager();
    writerCalls = [];
    mockWriter = async (proposal) => {
      writerCalls.push(proposal);
      return {
        slug: `${proposal.dimension}-${proposal.tags[0]}`,
        path: `docs/taste/vignettes/${proposal.dimension}-${proposal.tags[0]}.md`,
      };
    };

    app = Fastify();
    registerTasteProposalDecisionRoutes(app, {
      tasteProposalStore: store,
      socketManager,
      writeVignette: mockWriter,
    });
    await app.ready();
  });

  afterEach(() => app?.close());

  const makeProposal = async (overrides = {}) => {
    const proposal = store.create({
      userId: 'user-1',
      catId: 'opus',
      threadId: 'thread-1',
      scene: 'operator said "太客服了"',
      quote: '太客服了，我要的是活人感',
      tags: ['活人感'],
      dimension: 'authentic-expression',
      privacy: 'public',
      ...overrides,
    });
    // F246 Phase I: anchor publication so decision guards pass.
    await anchorApproval(store, {
      proposalId: proposal.id,
      sourceFeatureId: 'F221',
      ownerUserId: proposal.userId,
      requesterCatId: proposal.catId,
      threadId: proposal.threadId,
      createdAt: proposal.createdAt,
    });
    return proposal;
  };

  const inject = (method, url, body) =>
    app.inject({
      method,
      url,
      headers: { 'x-cat-cafe-user': 'user-1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { payload: body } : {}),
    });

  // ── GET /api/taste-proposals/:id ──

  describe('GET /api/taste-proposals/:id', () => {
    it('returns proposal status', async () => {
      const p = await makeProposal();
      const res = await inject('GET', `/api/taste-proposals/${p.id}`);
      assert.equal(res.statusCode, 200);
      const json = res.json();
      assert.equal(json.proposalId, p.id);
      assert.equal(json.status, 'pending');
    });

    it('returns 404 for unknown id', async () => {
      const res = await inject('GET', '/api/taste-proposals/nonexistent');
      assert.equal(res.statusCode, 404);
    });

    it('returns 401 without userId', async () => {
      const p = await makeProposal();
      const res = await app.inject({ method: 'GET', url: `/api/taste-proposals/${p.id}` });
      assert.equal(res.statusCode, 401);
    });

    it('returns 403 for wrong user', async () => {
      const p = await makeProposal({ userId: 'user-2' });
      const res = await inject('GET', `/api/taste-proposals/${p.id}`);
      assert.equal(res.statusCode, 403);
    });
  });

  // ── POST /api/taste-proposals/:id/approve ──

  describe('POST /api/taste-proposals/:id/approve', () => {
    it('approves a pending proposal → vignette written, status=approved', async () => {
      const p = await makeProposal();
      const res = await inject('POST', `/api/taste-proposals/${p.id}/approve`);
      assert.equal(res.statusCode, 200);
      const json = res.json();
      assert.equal(json.status, 'approved');
      assert.ok(json.vignettePath);
      // Writer was called
      assert.equal(writerCalls.length, 1);
      assert.equal(writerCalls[0].id, p.id);
    });

    it('approve emits proposal_updated WebSocket event', async () => {
      const p = await makeProposal();
      await inject('POST', `/api/taste-proposals/${p.id}/approve`);
      const event = socketManager._emitted.find((e) => e.event === 'proposal_updated');
      assert.ok(event);
      assert.equal(event.data.status, 'approved');
    });

    it('resumes a persisted approving checkpoint without rewriting and remains idempotent', async () => {
      const p = await makeProposal();
      store.claimForApproval(p.id, 'user-1');
      store.recordWriteCheckpoint(p.id, {
        vignetteSlug: 'already-written',
        vignettePath: 'docs/taste/vignettes/already-written.md',
      });

      const resumed = await inject('POST', `/api/taste-proposals/${p.id}/approve`);
      const retried = await inject('POST', `/api/taste-proposals/${p.id}/approve`);

      assert.equal(resumed.statusCode, 200);
      assert.equal(resumed.json().recovered, true);
      assert.equal(retried.statusCode, 200);
      assert.equal(store.get(p.id)?.status, 'approved');
      assert.equal(writerCalls.length, 0);
    });

    it('returns 409 for already rejected proposal', async () => {
      const p = await makeProposal();
      store.markRejected(p.id, 'wrong', 'user-1');
      const res = await inject('POST', `/api/taste-proposals/${p.id}/approve`);
      assert.equal(res.statusCode, 409);
    });

    it('rollbacks claim on writer failure (ADV-3)', async () => {
      const failWriter = async () => {
        throw new Error('disk full');
      };
      // Recreate app with failing writer
      await app.close();
      app = Fastify();
      registerTasteProposalDecisionRoutes(app, {
        tasteProposalStore: store,
        socketManager,
        writeVignette: failWriter,
      });
      await app.ready();

      const p = await makeProposal();
      const res = await inject('POST', `/api/taste-proposals/${p.id}/approve`);
      assert.equal(res.statusCode, 500);
      // Proposal rolled back to pending
      const fetched = store.get(p.id);
      assert.equal(fetched?.status, 'pending');
    });

    it('returns 404 for unknown proposal', async () => {
      const res = await inject('POST', '/api/taste-proposals/nonexistent/approve');
      assert.equal(res.statusCode, 404);
    });

    it('returns 401 without userId', async () => {
      const p = await makeProposal();
      const res = await app.inject({ method: 'POST', url: `/api/taste-proposals/${p.id}/approve` });
      assert.equal(res.statusCode, 401);
    });
  });

  // ── POST /api/taste-proposals/:id/reject ──

  describe('POST /api/taste-proposals/:id/reject', () => {
    it('rejects a pending proposal with reason', async () => {
      const p = await makeProposal();
      const res = await inject('POST', `/api/taste-proposals/${p.id}/reject`, {
        rejectionReason: 'not a taste signal',
      });
      assert.equal(res.statusCode, 200);
      const json = res.json();
      assert.equal(json.status, 'rejected');
      // No writer calls — reject has no file side effects (AC-B7)
      assert.equal(writerCalls.length, 0);
    });

    it('reject emits proposal_updated WebSocket event', async () => {
      const p = await makeProposal();
      await inject('POST', `/api/taste-proposals/${p.id}/reject`, { rejectionReason: 'wrong' });
      const event = socketManager._emitted.find((e) => e.event === 'proposal_updated');
      assert.ok(event);
      assert.equal(event.data.status, 'rejected');
    });

    it('returns 409 for already approved proposal', async () => {
      const p = await makeProposal();
      store.claimForApproval(p.id, 'user-1');
      store.finalizeApproval(p.id, 'user-1', 'slug', 'path');
      const res = await inject('POST', `/api/taste-proposals/${p.id}/reject`, { rejectionReason: 'too late' });
      assert.equal(res.statusCode, 409);
    });

    it('refuses rejection while an approving proposal may already have durable output', async () => {
      const p = await makeProposal();
      store.claimForApproval(p.id, 'user-1');
      store.recordWriteCheckpoint(p.id, {
        vignetteSlug: 'already-written',
        vignettePath: 'docs/taste/vignettes/already-written.md',
      });

      const res = await inject('POST', `/api/taste-proposals/${p.id}/reject`, { rejectionReason: 'unsafe' });
      assert.equal(res.statusCode, 409);
      assert.equal(store.get(p.id)?.status, 'approving');
    });

    it('uses default reason when none provided', async () => {
      const p = await makeProposal();
      const res = await inject('POST', `/api/taste-proposals/${p.id}/reject`, {});
      assert.equal(res.statusCode, 200);
      const fetched = store.get(p.id);
      assert.equal(fetched?.rejectionReason, 'No reason provided');
    });

    it('returns 404 for unknown proposal', async () => {
      const res = await inject('POST', '/api/taste-proposals/nonexistent/reject', { rejectionReason: 'nope' });
      assert.equal(res.statusCode, 404);
    });

    it('returns 401 without userId', async () => {
      const p = await makeProposal();
      const res = await app.inject({
        method: 'POST',
        url: `/api/taste-proposals/${p.id}/reject`,
        headers: { 'content-type': 'application/json' },
        payload: { rejectionReason: 'test' },
      });
      assert.equal(res.statusCode, 401);
    });
  });
});
