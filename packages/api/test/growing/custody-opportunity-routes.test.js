import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import '../helpers/setup-cat-registry.js';

const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
const { TaskStore } = await import('../../dist/domains/cats/services/stores/ports/TaskStore.js');
const { CustodyOpportunityCohortStore } = await import('../../dist/domains/growing/CustodyOpportunityCohortStore.js');
const { CustodyOpportunityRuntime } = await import('../../dist/domains/growing/CustodyOpportunityRuntime.js');
const { registerCustodyOpportunityRoutes } = await import('../../dist/routes/custody-opportunity-routes.js');

function fixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  return {
    runtime: new CustodyOpportunityRuntime({
      cohorts: new CustodyOpportunityCohortStore(db),
      messages: new MessageStore(),
      tasks: new TaskStore(),
      policyVersion: 'test-policy-v1',
      now: () => 1_789_000_000_000,
    }),
  };
}

test('evidence routes require owner identity, reject hand-filled sources and scope frozen receipts', async (t) => {
  const f = fixture(t);
  const app = Fastify();
  t.after(() => app.close());
  registerCustodyOpportunityRoutes(app, f.runtime);
  const base = '/api/entrusted-work/recognition-evidence';
  assert.equal((await app.inject({ method: 'GET', url: base })).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `${base}/snapshots`,
        headers: { 'x-cat-cafe-user': 'owner' },
        payload: { sourceRefs: ['message:chosen-after-outcome'] },
      })
    ).statusCode,
    400,
  );
  const captured = await app.inject({
    method: 'POST',
    url: `${base}/snapshots`,
    headers: { 'x-cat-cafe-user': 'owner' },
    payload: {},
  });
  assert.equal(captured.statusCode, 200, captured.body);
  const ref = captured.json().snapshotRef;
  const own = await app.inject({
    method: 'GET',
    url: `${base}/snapshots/${ref}`,
    headers: { 'x-cat-cafe-user': 'owner' },
  });
  assert.equal(own.statusCode, 200);
  assert.deepEqual(own.json(), captured.json().snapshot);
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: `${base}/snapshots/${ref}`,
        headers: { 'x-cat-cafe-user': 'other-owner' },
      })
    ).statusCode,
    404,
  );
});

test('an unavailable observer is explicit and cannot interfere with product writes', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  registerCustodyOpportunityRoutes(app, null);
  app.post('/unrelated-task-owner', async () => ({ status: 'updated' }));
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: '/api/entrusted-work/recognition-evidence',
        headers: { 'x-cat-cafe-user': 'owner' },
      })
    ).statusCode,
    503,
  );
  assert.equal((await app.inject({ method: 'POST', url: '/unrelated-task-owner' })).statusCode, 200);
});
