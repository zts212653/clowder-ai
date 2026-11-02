import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerMessageSearchAnswerRoute } from '../../dist/routes/message-search-answer-route.js';
import { fixture, post } from '../helpers/message-search-answer-fixture.js';

test('only a direct authenticated read of actual message/block coordinates can resolve a card', async () => {
  const f = fixture(),
    app = Fastify();
  try {
    const prepared = await f.service.prepare(f.request),
      published = await post(f, prepared);
    registerMessageSearchAnswerRoute(app, f.service);
    const blockId = published.published.extra.messageSearchAnswer.blockId;
    const url = `/api/evidence/answer?${new URLSearchParams({ messageId: published.message.id, blockId })}`;
    assert.equal((await app.inject(url)).statusCode, 401);
    assert.equal(
      (await app.inject({ url, headers: { 'x-cat-cafe-user': 'owner', 'x-forwarded-for': '192.0.2.1' } })).statusCode,
      401,
    );
    assert.equal((await app.inject({ url, headers: { 'x-cat-cafe-user': 'another' } })).json().status, 'unavailable');
    const response = await app.inject({
      url: `${url}&userId=another&verified=true&publicationRef=forged`,
      headers: { 'x-cat-cafe-user': 'owner' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().publicationRef, prepared.publicationRef);
    assert.equal(response.json().response.results.length, 3);
    for (const row of f.source) f.messages.getById(row.id).recall = { version: 1, exposure: 'none', recalledAt: 5 };
    const revoked = await app.inject({ url, headers: { 'x-cat-cafe-user': 'owner' } });
    assert.deepEqual(revoked.json(), { status: 'unavailable' });
    assert.equal(f.searches(), 1);
    assert.equal(f.calls(), 0);
  } finally {
    await app.close();
    f.db.close();
  }
});
