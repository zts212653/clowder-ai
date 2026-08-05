import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import Fastify from 'fastify';

function makeMessageStore() {
  return {
    append: mock.fn(async (message) => ({ id: 'msg-disabled-route', ...message })),
    updateStatus: mock.fn(async () => {}),
  };
}

describe('POST /api/messages disabled explicit routing', () => {
  it('returns the routing warning before failing closed with no targets', async () => {
    const { messagesRoutes } = await import('../dist/routes/messages.js');
    const messageStore = makeMessageStore();
    const broadcasts = [];
    const app = Fastify();

    await app.register(messagesRoutes, {
      registry: { active: () => new Set() },
      messageStore,
      socketManager: {
        broadcastAgentMessage: (message, threadId) => broadcasts.push({ message, threadId }),
      },
      router: {
        resolveTargetsAndIntent: async () => ({
          targetCats: [],
          intent: { intent: 'execute', explicit: false, promptTags: [] },
          hasMentions: true,
          routing_warnings: [
            {
              kind: 'cat_disabled',
              catId: 'opus',
              displayName: '布偶猫',
              alternatives: [{ catId: 'opus-5', mention: '@opus-5', displayName: '布偶猫 Opus 5', family: 'ragdoll' }],
            },
          ],
        }),
      },
    });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: { content: '@opus 请确认架构方案', threadId: 'thread-disabled-route' },
    });

    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.equal(body.code, 'NO_TARGETS');
    assert.equal(body.routing_warnings[0].kind, 'cat_disabled');
    assert.equal(body.routing_warnings[0].alternatives[0].catId, 'opus-5');

    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].threadId, 'thread-disabled-route');
    assert.equal(broadcasts[0].message.type, 'system_info');
    assert.match(JSON.parse(broadcasts[0].message.content).message, /@opus-5/);

    await app.close();
  });
});
