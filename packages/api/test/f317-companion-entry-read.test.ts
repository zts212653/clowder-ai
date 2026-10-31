import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { MemoryConciergeConfigStore } from '../dist/domains/concierge/ConciergeConfigStore.js';
import { ConciergeThreadService } from '../dist/domains/concierge/ConciergeThreadService.js';
import { conciergeRoutes } from '../dist/routes/concierge.js';

test('entry discovery reads only its authenticated owner carrier and creates no thread', async (t) => {
  const threadStore = new ThreadStore();
  const conciergeConfigStore = new MemoryConciergeConfigStore();
  const service = new ConciergeThreadService({ threadStore, conciergeConfigStore });
  const app = Fastify();
  t.after(() => app.close());
  await app.register(conciergeRoutes, { conciergeConfigStore, conciergeThreadService: service });
  const own = await service.getOrCreate('owner-a');
  const old = await threadStore.get(own);
  assert.ok(old);
  await threadStore.updateThreadKind(own, null);
  const response = await app.inject({
    method: 'GET',
    url: '/api/concierge/thread',
    headers: { 'x-cat-cafe-user': 'owner-a' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().threadId, own);
  assert.equal((await threadStore.get(own))?.threadKind, undefined, 'discovery must not repair metadata');
  const foreign = await app.inject({
    method: 'GET',
    url: '/api/concierge/thread',
    headers: { 'x-cat-cafe-user': 'owner-b' },
  });
  assert.equal(foreign.statusCode, 200);
  assert.equal(foreign.json().threadId, null);
  assert.equal(await service.findThreadId('owner-b'), null, 'GET must not create a fresh carrier');
  const anonymous = await app.inject({ method: 'GET', url: '/api/concierge/thread' });
  assert.equal(anonymous.statusCode, 401);
  const forgedBrowser = await app.inject({
    method: 'GET',
    url: '/api/concierge/thread',
    headers: {
      origin: 'http://localhost:5456',
      'x-cat-cafe-user': 'owner-a',
    },
  });
  assert.equal(forgedBrowser.statusCode, 401);
  await threadStore.softDelete(own);
  const deleted = await app.inject({
    method: 'GET',
    url: '/api/concierge/thread',
    headers: { 'x-cat-cafe-user': 'owner-a' },
  });
  assert.equal(deleted.statusCode, 200);
  assert.equal(deleted.json().threadId, null);
});
