import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { registerCallbackMeetingArtifactRoutes } from '../../dist/routes/callback-meeting-artifact-routes.js';

describe('F292 callback meeting artifact boundary', () => {
  const apps = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createApp(principal, reader) {
    const app = Fastify();
    apps.push(app);
    app.decorateRequest('callbackPrincipal', null);
    app.addHook('onRequest', async (request) => {
      request.callbackPrincipal = principal;
    });
    registerCallbackMeetingArtifactRoutes(app, {
      readerHolder: { current: reader },
      threadStore: {
        get: async (threadId) =>
          threadId === 'thread-1' ? { id: 'thread-1', createdBy: 'owner-1', deletedAt: null } : null,
        list: async () => [{ id: 'thread-1', createdBy: 'owner-1', deletedAt: null }],
      },
    });
    await app.ready();
    return app;
  }

  it('derives owner, cat, and invocation thread from callback provenance', async () => {
    const calls = [];
    const app = await createApp(
      { kind: 'invocation', invocationId: 'inv-1', userId: 'owner-1', catId: 'codex-sol', threadId: 'thread-1' },
      { read: async (input) => (calls.push(input), { content: 'bounded', nextCursor: null }) },
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/meeting-artifacts/read',
      payload: {
        resourceRef: `meeting-artifact://intakes/intake-1?revision=sha256:${'a'.repeat(64)}`,
        view: 'content',
        maxChars: 400,
        maxTokens: 100,
      },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls[0], {
      ownerId: 'owner-1',
      threadId: 'thread-1',
      catId: 'codex-sol',
      resourceRef: `meeting-artifact://intakes/intake-1?revision=sha256:${'a'.repeat(64)}`,
      view: 'content',
      maxChars: 400,
      maxTokens: 100,
    });
  });

  it('requires an explicit authorized thread for persistent agent-key reads', async () => {
    const app = await createApp(
      { kind: 'agent_key', agentKeyId: 'key-1', userId: 'owner-1', catId: 'gpt-pro', scope: 'owner' },
      { read: async () => assert.fail('must not read without a thread scope') },
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/meeting-artifacts/read',
      payload: {
        resourceRef: `meeting-artifact://intakes/intake-1?revision=sha256:${'a'.repeat(64)}`,
        view: 'overview',
        maxChars: 400,
        maxTokens: 100,
      },
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.body, /threadId required/);
  });
});
