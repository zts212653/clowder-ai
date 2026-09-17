import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { projectThreadRelations } from '../dist/domains/thread-navigation/thread-relation-projection.js';
import { threadsRoutes } from '../dist/routes/threads.js';

function thread(id, overrides = {}) {
  return {
    id,
    projectPath: 'default',
    title: id,
    createdBy: 'alice',
    participants: [],
    lastActiveAt: 2,
    createdAt: 1,
    ...overrides,
  };
}

describe('F277 ThreadRelationProjection', () => {
  it('keeps origin and placement separate for an F128 re-root', () => {
    const projection = projectThreadRelations([
      thread('source-a'),
      thread('parent-b'),
      thread('child', {
        parentThreadId: 'parent-b',
        createdFromProposalId: 'proposal-1',
        sourceThreadId: 'source-a',
        sourceInvocationId: 'invocation-1',
        sourceMessageId: 'message-1',
        declaredWorkMode: 'parallel',
      }),
    ]);

    assert.deepEqual(projection, {
      v: 1,
      nodes: [
        {
          threadId: 'child',
          origin: {
            sourceThreadId: 'source-a',
            sourceInvocationId: 'invocation-1',
            sourceMessageId: 'message-1',
            mechanism: 'f128_proposal',
          },
          placement: { parentThreadId: 'parent-b', declaredWorkMode: 'parallel' },
        },
      ],
    });
  });

  it('projects exact message-branch provenance and never infers from title adjacency', () => {
    const projection = projectThreadRelations([
      thread('source'),
      thread('branch', {
        parentThreadId: 'source',
        branchAudit: { sourceThreadId: 'source', sourceMessageId: 'message-2', branchedAt: 10 },
      }),
      thread('F296 same-looking title'),
    ]);

    assert.deepEqual(projection.nodes, [
      {
        threadId: 'branch',
        origin: {
          sourceThreadId: 'source',
          sourceMessageId: 'message-2',
          mechanism: 'message_branch',
        },
        placement: { parentThreadId: 'source', declaredWorkMode: 'unknown' },
      },
    ]);
  });

  it('does not invent provenance for legacy parent-only or unrelated threads', () => {
    const projection = projectThreadRelations([
      thread('parent'),
      thread('legacy-child', { parentThreadId: 'parent' }),
      thread('unrelated'),
    ]);

    assert.deepEqual(projection.nodes, [
      {
        threadId: 'legacy-child',
        placement: { parentThreadId: 'parent', declaredWorkMode: 'unknown' },
      },
    ]);
  });

  it('omits standalone birth-only placement from cluster edges without rewriting its truth', () => {
    const projection = projectThreadRelations([
      thread('source'),
      thread('standalone', {
        parentThreadId: 'source',
        createdFromProposalId: 'proposal-2',
        sourceThreadId: 'source',
        declaredWorkMode: 'standalone',
      }),
    ]);

    assert.equal(projection.nodes[0].placement.declaredWorkMode, 'standalone');
    assert.equal(projection.nodes[0].origin.mechanism, 'f128_proposal');
    assert.equal('workId' in projection.nodes[0], false);
  });

  it('serves only the authenticated owner relation projection', async () => {
    const threadStore = new ThreadStore();
    const aliceParent = threadStore.create('alice', 'Alice parent');
    threadStore.create('alice', 'Alice child', 'default', aliceParent.id, undefined, {
      sourceThreadId: aliceParent.id,
      sourceMessageId: 'alice-message',
      branchedAt: 10,
    });
    const bobParent = threadStore.create('bob', 'Bob parent');
    threadStore.create('bob', 'Bob child', 'default', bobParent.id, undefined, {
      sourceThreadId: bobParent.id,
      sourceMessageId: 'bob-message',
      branchedAt: 20,
    });

    const app = Fastify();
    await app.register(threadsRoutes, { threadStore });
    await app.ready();
    const response = await app.inject({
      method: 'GET',
      url: '/api/threads/relations',
      headers: { 'x-cat-cafe-user': 'alice' },
    });

    assert.equal(response.statusCode, 200, response.body);
    const projection = response.json();
    assert.equal(projection.nodes.length, 1);
    assert.equal(projection.nodes[0].origin.sourceMessageId, 'alice-message');
    assert.equal(JSON.stringify(projection).includes('bob-message'), false);
    await app.close();
  });
});
