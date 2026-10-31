import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';

const { threadsRoutes } = await import('../dist/routes/threads.js');
const AUTH = { 'x-cat-cafe-user': 'alice' };
const MESSAGE = {
  id: 'publication-message',
  catId: 'codex61-sol',
  timestamp: 100,
  extra: {
    rich: {
      v: 1,
      blocks: [
        {
          kind: 'media_gallery',
          v: 1,
          id: 'gallery',
          items: [{ url: '/uploads/original.png', caption: 'Original' }],
        },
      ],
    },
  },
};

async function fixture(t, { resolve, threadOwner = 'alice' } = {}) {
  const inputs = [];
  const app = Fastify();
  t.after(() => app.close());
  await app.register(threadsRoutes, {
    threadStore: {
      get: async (id) => (id === 'T1' ? { id, createdBy: threadOwner, title: 'Current thread' } : null),
      getThreadMemory: async () => null,
      list: async () => {
        throw new Error('A thread query must not scan the global thread list');
      },
    },
    messageStore: {
      getByThread: async (threadId) => {
        assert.equal(threadId, 'T1');
        return [MESSAGE];
      },
      getByThreadBefore: async () => [],
    },
    taskStore: { listByThread: async () => [] },
    ...(resolve
      ? {
          artifactWorkLineage: {
            current: {
              resolve: async (input) => {
                inputs.push(input);
                return resolve(input);
              },
            },
          },
        }
      : {}),
  });
  return { app, inputs };
}

test('thread artifact cards retain their full publication DTO with the exact owner version', async (t) => {
  const work = { contentRef: 'prepared-media:original', ownerRevision: 7, currentOwnerRevision: 9 };
  const { app, inputs } = await fixture(t, { resolve: async () => [work] });
  const response = await app.inject({ method: 'GET', url: '/api/threads/T1/artifacts', headers: AUTH });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].ownerUserId, 'alice');
  assert.equal(inputs[0].artifacts.length, 1);
  assert.equal(inputs[0].artifacts[0].threadId, 'T1');
  assert.equal(body.workLineage, 'resolved');
  assert.equal(body.threadId, 'T1');
  assert.equal(body.artifacts.length, 1);
  assert.deepEqual(body.artifacts[0].work, work);
  assert.equal(body.artifacts[0].sourceMessageId, MESSAGE.id);
  assert.equal(body.artifacts[0].url, '/uploads/original.png');
  assert.equal(body.artifacts[0].createdAt, 100);
  assert.deepEqual(body.artifacts[0].publicationItem, { kind: 'media-gallery', blockId: 'gallery', itemIndex: 0 });
  assert.equal(body.artifacts[0].threadId, undefined, 'projection context must not replace the thread DTO');
});

test('missing or ambiguous owner landings remain absent without inventing a card version', async (t) => {
  const { app } = await fixture(t, { resolve: async () => [undefined] });
  const response = await app.inject({ method: 'GET', url: '/api/threads/T1/artifacts', headers: AUTH });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().workLineage, 'resolved');
  assert.equal(response.json().artifacts[0].work, undefined);
});

test('an unavailable owner reader preserves the artifact and exposes no partial version', async (t) => {
  const { app } = await fixture(t, {
    resolve: async () => {
      throw new Error('owner catalogue unavailable');
    },
  });
  const response = await app.inject({ method: 'GET', url: '/api/threads/T1/artifacts', headers: AUTH });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.workLineage, 'unavailable');
  assert.equal(body.artifacts.length, 1);
  assert.equal(body.artifacts[0].sourceMessageId, MESSAGE.id);
  assert.equal(body.artifacts[0].work, undefined);
});

test('the thread access guard runs before any owner version lookup', async (t) => {
  const { app, inputs } = await fixture(t, { threadOwner: 'bob', resolve: async () => [] });
  const response = await app.inject({ method: 'GET', url: '/api/threads/T1/artifacts', headers: AUTH });
  assert.equal(response.statusCode, 403);
  assert.deepEqual(inputs, []);
});
