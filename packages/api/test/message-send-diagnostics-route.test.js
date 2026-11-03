import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { messagesRoutes } from '../dist/routes/messages.js';

// A real socket close, after atomic memory admission, must identify the pending
// await without cancelling the accepted source or changing its replay receipt.
for (const stage of ['participants', 'projectImport']) {
  test(`POST disconnect reports the committed source while ${stage} is pending`, { timeout: 10000 }, async (t) => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const closed = Promise.withResolvers();
    const settled = Promise.withResolvers();
    const rows = [];
    const store = new MessageStore();
    const participants = [];
    let block = true;
    const pause = async () => {
      if (!block) return;
      entered.resolve();
      await release.promise;
    };
    const app = Fastify({
      logger: {
        stream: {
          write(line) {
            const row = JSON.parse(line);
            if (row.msg !== '[Task229] message send diagnostic') return;
            rows.push(row);
            if (row.event === 'client_closed') closed.resolve(row);
            if (row.event === 'handler_settled') settled.resolve(row);
          },
        },
      },
    });
    t.after(async () => {
      release.resolve();
      await app.close();
    });
    await app.register(messagesRoutes, {
      registry: new InvocationRegistry(),
      messageStore: store,
      invocationQueue: new InvocationQueue(undefined, { resolveTargets: async () => ['opus'] }),
      socketManager: { emitToUser() {}, broadcastToRoom() {} },
      router: {
        previewTargets: async () => ({ targetCats: [], reason: { kind: 'default_cat' } }),
        resolveTargetsAndIntent: async () => ({ targetCats: ['opus'], intent: { intent: 'execute' } }),
      },
      threadStore: {
        get: async () => ({ id: 'diagnostic-thread', title: 'Diagnostic', createdBy: 'default-user', participants }),
        ...(stage === 'participants'
          ? {
              addParticipants: async (_id, cats) => {
                await pause();
                participants.splice(0, participants.length, ...cats);
              },
            }
          : {}),
      },
      ...(stage === 'projectImport' ? { onStoredProjectMessage: pause } : {}),
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const payload = {
      threadId: 'diagnostic-thread',
      content: 'private-body-canary',
      idempotencyKey: randomUUID(),
    };
    let responseReceived = false;
    const client = httpRequest(`${app.listeningOrigin}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    client.on('error', () => {}); // Expected local socket destruction below.
    client.on('response', (response) => {
      responseReceived = true;
      entered.reject(new Error(`Unexpected response before the post-commit barrier: ${response.statusCode}`));
      response.resume();
    });
    t.after(() => client.destroy());
    client.end(JSON.stringify(payload));
    try {
      await entered.promise;
      const source = store.getByIdempotencyKey('default-user', payload.threadId, payload.idempotencyKey);
      assert.ok(source, 'atomic admission must already be readable before the blocked post-commit await');
      assert.equal(responseReceived, false, 'observation cannot move HTTP acknowledgement before the existing await');
      client.destroy();
      const disconnected = await closed.promise;
      assert.equal(disconnected.activePhase, stage);
      assert.equal(disconnected.committedSourceMessageId, source.id);
      assert.ok(disconnected.reqId, 'the original request logger must supply the physical request ID');
      assert.equal(rows.length, 1);
      block = false;
      release.resolve();
      const finished = await settled.promise;
      assert.equal(finished.outcome, 'resolved');
      assert.equal(finished.reqId, disconnected.reqId);
      assert.equal(finished.committedSourceMessageId, source.id);
      assert.equal(rows.length, 2);
      assert.doesNotMatch(JSON.stringify(rows), /private-body-canary/);
      assert.equal(JSON.stringify(rows).includes(payload.idempotencyKey), false);
      const replay = await app.inject({ method: 'POST', url: '/api/messages', payload });
      assert.equal(replay.statusCode, 202, replay.body);
      assert.equal(replay.json().userMessageId, source.id);
      assert.equal(
        (await store.getByThread(payload.threadId, 100, 'default-user', { includeQueuedUserMessages: true })).length,
        1,
      );
    } finally {
      block = false;
      release.resolve();
      client.destroy();
    }
  });
}
