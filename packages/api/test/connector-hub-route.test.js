import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

const { connectorHubRoutes } = await import('../dist/routes/connector-hub.js');

const AUTH_HEADERS = { 'x-cat-cafe-user': 'owner-1' };

async function buildApp(overrides = {}) {
  const listCalls = [];
  const threadStore = {
    async list(userId) {
      listCalls.push(userId);
      return (
        overrides.threads ?? [
          {
            id: 'thread-hub-2',
            title: 'Feishu IM Hub',
            connectorHubState: { connectorId: 'feishu', externalChatId: 'chat-2', createdAt: 20 },
          },
          {
            id: 'thread-normal',
            title: 'Regular thread',
            connectorHubState: null,
          },
          {
            id: 'thread-hub-1',
            title: 'Telegram IM Hub',
            connectorHubState: { connectorId: 'telegram', externalChatId: 'chat-1', createdAt: 10 },
          },
        ]
      );
    },
  };

  const app = Fastify();
  await app.register(connectorHubRoutes, { threadStore });
  await app.ready();
  return { app, listCalls };
}

describe('GET /api/connector/hub-threads', () => {
  it('returns 401 when only a spoofed userId query param is provided', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/connector/hub-threads?userId=spoofed',
    });
    assert.equal(res.statusCode, 401);
    assert.match(JSON.parse(res.body).error, /Identity required/i);
  });

  it('uses the trusted header identity and returns hub threads sorted by createdAt desc', async () => {
    const { app, listCalls } = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/connector/hub-threads?userId=spoofed',
      headers: AUTH_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(listCalls, ['owner-1']);

    const body = JSON.parse(res.body);
    assert.deepEqual(
      body.threads.map((thread) => thread.id),
      ['thread-hub-2', 'thread-hub-1'],
    );
    assert.deepEqual(body.threads[0], {
      id: 'thread-hub-2',
      title: 'Feishu IM Hub',
      connectorId: 'feishu',
      externalChatId: 'chat-2',
      createdAt: 20,
    });
  });
});
