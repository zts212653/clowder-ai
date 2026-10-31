import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { companionDecisionRoutes } from '../../src/routes/companion-decision-routes.js';
import { receipt, work } from './unified-attention-fixtures.js';

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = 'owner';
  t.after(async () => {
    if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
  });
  const app = Fastify();
  t.after(() => app.close());
  const reads: string[] = [];
  app.addHook('preHandler', async (request) => {
    if (request.headers['x-test-session']) request.sessionUserId = String(request.headers['x-test-session']);
  });
  app.get('/api/approval-hub/pending', async (request) => {
    reads.push(String(request.headers['x-cat-cafe-user']));
    return { items: [], coverage: { state: 'complete' } };
  });
  app.get('/api/entrusted-work/needs-me', async () => ({ ownerReads: [], coverage: { state: 'complete' } }));
  await app.register(companionDecisionRoutes, { ownerUserId: 'owner' });
  return { app, reads };
}

test('read is registered without Live; session wins over forged header and unauthorized callers never read source', async (t) => {
  const { app, reads } = await fixture(t);
  const url = '/api/concierge/work/decisions';
  assert.equal((await app.inject({ url, headers: { 'x-cat-cafe-user': 'owner' } })).statusCode, 401);
  assert.equal((await app.inject({ url, headers: { 'x-test-session': 'other' } })).statusCode, 403);
  assert.equal(
    (await app.inject({ url, remoteAddress: '192.0.2.1', headers: { 'x-test-session': 'owner' } })).statusCode,
    403,
  );
  assert.equal(
    (await app.inject({ url, headers: { 'x-test-session': 'owner', origin: 'https://untrusted.example' } })).statusCode,
    403,
  );
  assert.deepEqual(reads, []);
  const result = await app.inject({ url, headers: { 'x-test-session': 'owner', 'x-cat-cafe-user': 'other' } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.json().identity.ownerUserId, 'owner');
  assert.equal(result.json().totalCount, 0);
  assert.equal(result.json().readWindow.consistency, 'independent_source_reads');
  assert.deepEqual(reads, ['owner']);
});

test('page rejects private selectors and invalid bounds before any source read', async (t) => {
  const { app, reads } = await fixture(t);
  for (const query of ['userId=other', 'limit=21', 'offset=-1', 'limit=0', 'offset=1.5']) {
    assert.equal(
      (await app.inject({ url: `/api/concierge/work/decisions?${query}`, headers: { 'x-test-session': 'owner' } }))
        .statusCode,
      400,
    );
  }
  assert.deepEqual(reads, []);
});

test('unified view preserves partial data while the original F317 reader retains its default wire contract', async (t) => {
  const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = 'owner';
  t.after(() => {
    if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
  });
  const app = Fastify();
  t.after(() => app.close());
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = 'owner';
  });
  let offline = false;
  app.get('/api/approval-hub/pending', async (_request, reply) =>
    offline ? reply.code(503).send({ error: 'offline' }) : { items: [], coverage: { state: 'complete' } },
  );
  app.get('/api/entrusted-work/needs-me', async () => ({
    ownerReads: [work([receipt('surviving')])],
    coverage: { state: 'complete' },
  }));
  await app.register(companionDecisionRoutes, { ownerUserId: 'owner' });
  const { readCompanionDecisions } = await import('../../src/domains/concierge/live/companion-decision-read.js');
  const client = {
    request: async (url: string) => {
      const response = await app.inject(url);
      if (response.statusCode !== 200) throw new Error(`Host unavailable: ${response.statusCode}`);
      return response.json();
    },
  };
  const complete = await readCompanionDecisions(client as Parameters<typeof readCompanionDecisions>[0], 0, 20);
  assert.equal(complete.kind, 'decisions');
  offline = true;
  assert.equal((await app.inject('/api/concierge/work/decisions')).statusCode, 503);
  await assert.rejects(
    () => readCompanionDecisions(client as Parameters<typeof readCompanionDecisions>[0], 0, 20),
    /Host unavailable: 503/,
  );
  const unified = await app.inject('/api/concierge/work/decisions?view=unified');
  assert.equal(unified.statusCode, 200);
  assert.equal(unified.json().status, 'partial');
  assert.equal(unified.json().items.length, 1);
  assert.equal(unified.json().items[0].summary, 'Choose surviving');
  assert.equal(unified.json().sources.needsMe.status, 'available');
  assert.equal(unified.json().totalCount, undefined);
});
