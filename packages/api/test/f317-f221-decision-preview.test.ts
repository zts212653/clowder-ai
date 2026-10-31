import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InMemoryTasteProposalStore } from '../src/domains/taste/stores/InMemoryTasteProposalStore.js';
import { registerTasteProposalDecisionRoutes } from '../src/routes/taste-proposal-decision-routes.js';

test('owner can read an exact anchored F221 decision preview; no writer is invoked', async () => {
  const store = new InMemoryTasteProposalStore();
  const app = Fastify();
  let writes = 0;
  registerTasteProposalDecisionRoutes(app, {
    tasteProposalStore: store,
    socketManager: { emitToUser() {} },
    writeVignette: async () => {
      writes++;
      throw new Error('preview must not write');
    },
  });
  try {
    const proposal = await store.create({
      userId: 'owner',
      catId: 'codex',
      threadId: 'source-thread',
      sourceMessageId: 'source-message',
      scene: '共同看设计稿',
      quote: '要保留一点呼吸感',
      takeaway: '留白让重点更清楚',
      tags: ['留白'],
      dimension: 'visual-quality',
      privacy: 'sensitive',
    });
    const url = `/api/taste-proposals/${proposal.id}/decision-preview`;
    const get = (owner = 'owner') => app.inject({ method: 'GET', url, headers: { 'x-cat-cafe-user': owner } });
    assert.equal((await get()).statusCode, 409, 'unanchored proposal is not a voice candidate');
    await store.commitEnvelope(proposal.id, {
      canonicalProposalId: proposal.id,
      sourceFeatureId: 'F221',
      ownerUserId: 'owner',
      requesterCatId: 'codex',
      createdAt: proposal.createdAt,
      originRef: { kind: 'message', threadId: 'source-thread', messageId: 'source-message' },
      approvalCardRef: { threadId: 'source-thread', messageId: 'card-message' },
    });
    assert.equal((await get('other')).statusCode, 403);
    const response = await get();
    assert.equal(response.statusCode, 200);
    const preview = response.json();
    assert.equal(preview.proposalId, proposal.id);
    assert.equal(preview.ownerUserId, 'owner');
    assert.equal(preview.fields.quote, '要保留一点呼吸感');
    assert.equal(preview.fields.takeaway, '留白让重点更清楚');
    assert.equal(preview.fields.privacy, 'sensitive');
    assert.equal(preview.fields.sourceMessageId, 'source-message');
    assert.match(preview.fields.publication, /card-message/);
    assert.match(preview.digest, /^[a-f0-9]{64}$/);
    assert.equal(writes, 0);
    await store.markRejected(proposal.id, '不合适', 'owner');
    assert.equal((await get()).statusCode, 409, 'settled proposal cannot stage another decision');
  } finally {
    await app.close();
  }
});
