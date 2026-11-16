import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InMemoryFrustrationIssueStore } from '../dist/domains/cats/services/stores/memory/InMemoryFrustrationIssueStore.js';
import { frustrationIssueRoutes } from '../dist/routes/frustration-issue-routes.js';

test('public report keeps Chinese question sentences in both title and body', async (t) => {
  const app = Fastify();
  await app.register(frustrationIssueRoutes, { frustrationIssueStore: new InMemoryFrustrationIssueStore() });
  t.after(() => app.close());
  const payload = {
    title: '为什么不行？明明昨天还可以！',
    bodyMarkdown: '这是怎么回事？我不知道为什么会这样，重试了三次还是失败。\n你怎么又不对?我再说一遍',
  };
  const result = await app.inject({
    method: 'POST',
    url: '/api/feedback/report-preview',
    headers: { 'x-cat-cafe-user': 'fixture' },
    payload,
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json(), {
    title: payload.title.normalize('NFKC'),
    bodyMarkdown: payload.bodyMarkdown.normalize('NFKC'),
  });
});

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
