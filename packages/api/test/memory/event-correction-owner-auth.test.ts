import assert from 'node:assert/strict';
import { it } from 'node:test';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import type { EventMemoryCorrectionProposalStore } from '../../src/domains/memory/event/EventMemoryCorrectionProposalStore.js';
import { sessionAuthPlugin, sessionRoute } from '../../src/infrastructure/session-auth.js';
import { registerEventMemoryCorrectionDecisionRoutes } from '../../src/routes/event-memory-correction-decision-routes.js';

it('does not expose a private Event correction to a self-reported owner header without a session', async () => {
  const app = Fastify();
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  const proposal = {
    proposalId: 'proposal-a',
    ownerUserId: 'owner-a',
    status: 'pending',
    expectedRevision: `sha256:${'a'.repeat(64)}`,
    reason: 'outdated',
    suggestedPatch: { summary: 'private suggested memory' },
    sourceCatId: 'codex61-sol',
    sourceThreadId: 'private-thread',
    source: { threadId: 'private-thread', messageId: 'private-message' },
    createdAt: 100,
  };
  registerEventMemoryCorrectionDecisionRoutes(app, {
    store: { get: async () => proposal } as unknown as EventMemoryCorrectionProposalStore,
    lifecycle: {
      applyApprovedCorrection: async () => {
        throw new Error('not called');
      },
    },
    socketManager: { emitToUser: () => {} },
  });
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/event-memory-corrections/proposal-a',
      headers: { 'x-cat-cafe-user': 'owner-a' },
    });
    assert.ok([401, 403].includes(response.statusCode), response.body);
    assert.ok(!response.body.includes('private suggested memory'));
  } finally {
    await app.close();
  }
});

it('requires the browser Origin and CSRF boundary before Event correction decisions', async () => {
  const app = Fastify();
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: 'owner-a' });
  registerEventMemoryCorrectionDecisionRoutes(app, {
    store: {
      get: async () => ({
        proposalId: 'proposal-a',
        ownerUserId: 'owner-a',
        status: 'pending',
        expectedRevision: `sha256:${'a'.repeat(64)}`,
        reason: 'outdated',
        suggestedPatch: { summary: 'private suggested memory' },
        sourceCatId: 'codex61-sol',
        sourceThreadId: 'private-thread',
        source: { threadId: 'private-thread', messageId: 'private-message' },
        createdAt: 100,
      }),
    } as unknown as EventMemoryCorrectionProposalStore,
    lifecycle: {
      applyApprovedCorrection: async () => {
        throw new Error('not called');
      },
    },
    socketManager: { emitToUser: () => {} },
  });
  try {
    const login = await app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { origin: 'http://localhost:3003' },
    });
    const cookieValue = String(login.headers['set-cookie']).split(';', 1)[0];
    const response = await app.inject({
      method: 'POST',
      url: '/api/event-memory-corrections/proposal-a/approve',
      headers: { cookie: cookieValue },
    });
    assert.equal(response.statusCode, 403, response.body);
  } finally {
    await app.close();
  }
});
