import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { WorkCatalogue } from '../dist/domains/collaborative-content/works/catalogue.js';
import { threadsRoutes } from '../dist/routes/threads.js';
import { workCatalogueFixture } from './helpers/work-catalogue-fixture.js';

test('actual thread and global Works HTTP readers share discovery only within each admitted request', async (t) => {
  const f = await workCatalogueFixture(t);
  const threads = Array.from({ length: 7 }, (_, i) => ({ id: `T${i}`, createdBy: 'owner', title: `Thread ${i}` }));
  const expected = [];
  // More than thirty owner entries; no single thread has more than one ten-item Work page.
  for (let i = 0; i < 35; i++)
    expected.push((await f.create(`film-${i}`, threads[i % threads.length].id)).reference.contentRef);
  const app = Fastify();
  t.after(() => app.close());
  const messages = new MessageStore();
  const tasks = new TaskStore();
  await app.register(threadsRoutes, {
    threadStore: {
      list: async () => threads,
      get: async (id) => threads.find((thread) => thread.id === id) ?? null,
      getThreadMemory: async () => null,
    },
    messageStore: messages,
    taskStore: tasks,
    artifactWorkLineage: {
      independent: new WorkCatalogue(f.service),
      current: { resolve: async ({ artifacts }) => artifacts.map((item) => item.work) },
    },
  });
  const counter = f.countReads();
  const headers = { 'x-cat-cafe-user': 'owner' };
  const unauthorized = await app.inject({ url: '/api/artifacts?view=works' });
  assert.equal(unauthorized.statusCode, 401);
  const foreign = await app.inject({
    url: '/api/threads/T0/artifacts?view=works',
    headers: { 'x-cat-cafe-user': 'foreign' },
  });
  assert.equal(foreign.statusCode, 403);
  assert.equal(counter.stats().stateReads, 0);
  for (const url of ['/api/artifacts?view=works', '/api/artifacts?view=works&read=pages']) {
    const found = [];
    let cursor;
    for (let page = 0; page < 4; page++) {
      counter.reset();
      const response = await app.inject({ url: cursor ? `${url}&cursor=${encodeURIComponent(cursor)}` : url, headers });
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json();
      found.push(...body.artifacts.map((item) => item.ref));
      assert.ok(body.artifacts.every((item) => item.sourceMessageId === null && item.work.ownerRevision === 1));
      t.diagnostic(JSON.stringify({ url, ...counter.stats() }));
      assert.ok(
        counter.stats().stateReads <= 2 * 35 + 3 * body.artifacts.length,
        `global request repeated owner discovery: ${counter.stats().stateReads}`,
      );
      if (body.complete) break;
      assert.ok(body.nextCursor, 'bounded global pagination retains its continuation');
      cursor = body.nextCursor;
    }
    assert.deepEqual(found.sort(), [...expected].sort());
  }
  counter.reset();
  const thread = await app.inject({ url: '/api/threads/T0/artifacts?view=works', headers });
  assert.equal(thread.statusCode, 200, thread.body);
  assert.equal(thread.json().artifacts.length, 5);
  assert.ok(counter.stats().stateReads <= 2 * 35 + 3 * 5);
  // A later HTTP request cannot reuse the first request's owner snapshot.
  const added = await f.create('new-silent-save', 'T0');
  counter.reset();
  const fresh = await app.inject({ url: '/api/artifacts?view=works', headers });
  assert.equal(fresh.statusCode, 200, fresh.body);
  assert.equal(fresh.json().artifacts.length, 36);
  assert.ok(fresh.json().artifacts.some((item) => item.ref === added.reference.contentRef));
  assert.ok(counter.stats().stateReads >= 2 * 36, 'later HTTP request freshly reads owner manifests');
});
