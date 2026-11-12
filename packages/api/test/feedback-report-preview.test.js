import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InMemoryFrustrationIssueStore } from '../dist/domains/cats/services/stores/memory/InMemoryFrustrationIssueStore.js';
import { frustrationIssueRoutes } from '../dist/routes/frustration-issue-routes.js';

test('public report preparation redacts credentials/paths without persisting or enabling a publisher', async (t) => {
  const app = Fastify();
  const store = new InMemoryFrustrationIssueStore();
  await app.register(frustrationIssueRoutes, { frustrationIssueStore: store });
  t.after(() => app.close());
  const payload = { title: 'Failure', bodyMarkdown: 'token=private-value C:\\Users\\Alice\\secret.txt' };
  assert.equal((await app.inject({ method: 'POST', url: '/api/feedback/report-preview', payload })).statusCode, 401);
  const result = await app.inject({
    method: 'POST',
    url: '/api/feedback/report-preview',
    headers: { 'x-cat-cafe-user': 'fixture' },
    payload,
  });
  assert.equal(result.statusCode, 200);
  assert.doesNotMatch(result.body, /private-value|Alice/);
  assert.match(result.body, /REDACTED/);
  assert.equal((await store.listAll('fixture')).length, 0);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/feedback/report-preview',
        headers: { 'x-cat-cafe-user': 'fixture' },
        payload: { ...payload, threadId: 'must-not-import' },
      })
    ).statusCode,
    400,
  );
});
