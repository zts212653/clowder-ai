import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { AcpClient } from '../../dist/domains/cats/services/agents/providers/acp/AcpClient.js';
import { AcpHttpStreamClient } from '../../dist/domains/cats/services/agents/providers/acp/AcpHttpStreamClient.js';
import { createAcpPermissionHandler } from '../../dist/domains/cats/services/agents/providers/acp/permissions/acp-permission-interaction.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { MessageRuntimeInteractionCardPublisher } from '../../dist/domains/runtime-interaction/RuntimeInteractionCardPublisher.js';
import { RuntimeInteractionService } from '../../dist/domains/runtime-interaction/RuntimeInteractionService.js';
import { InMemoryRuntimeInteractionStore } from '../../dist/domains/runtime-interaction/stores/InMemoryRuntimeInteractionStore.js';
import { runtimeInteractionRoutes } from '../../dist/routes/runtime-interaction-routes.js';

const owner = { userId: 'owner-a', threadId: 'thread-a', catId: 'codex', invocationId: 'invoke-a' };
const request = {
  jsonrpc: '2.0',
  id: 12,
  method: 'session/request_permission',
  params: {
    sessionId: 'session-a',
    toolCall: { toolCallId: 'tool-a', title: 'Write the report', rawInput: { path: 'report.md' } },
    options: [
      { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ],
  },
};

for (const Client of [AcpClient, AcpHttpStreamClient]) {
  for (const answer of ['yes', 'no', 'cancel', 'abort', 'expired']) {
    test(`${Client.name}: ask user → canonical card → ${answer} → original ACP response`, async (t) => {
      const app = Fastify();
      t.after(() => app.close());
      const messages = new MessageStore();
      const broadcasts = [];
      const store = new InMemoryRuntimeInteractionStore();
      const service = new RuntimeInteractionService({
        store,
        hostEpoch: 'host-a',
        cardPublisher: new MessageRuntimeInteractionCardPublisher({
          messageStore: messages,
          socketManager: { broadcastToRoom: (...args) => broadcasts.push(args) },
        }),
      });
      await app.register(runtimeInteractionRoutes, { service });
      const controller = new AbortController();
      const handler = createAcpPermissionHandler({
        mode: 'ask_user',
        owner,
        port: service,
        sessionId: 'session-a',
        signal: controller.signal,
        isActive: () => true,
      });
      const client = new Client({ command: 'unused', args: [], cwd: process.cwd() });
      const replies = [];
      if (Client === AcpClient) client.child = { stdin: { write: (line) => replies.push(JSON.parse(line)) } };
      else
        client.sendAgentResponse = async (value) => {
          replies.push(value);
        };
      client.setSessionPermissionHandler('session-a', handler);
      const handled = client.handleAgentRequest(request);
      let pending;
      for (let attempt = 0; attempt < 50; attempt++) {
        const records = await store.listPendingByUser(owner.userId);
        pending = records.find((entry) => entry.status === 'pending');
        if (pending) break;
        await new Promise(setImmediate);
      }
      assert.ok(pending, 'a real pending interaction must exist');
      assert.deepEqual(pending.request.owner, owner);
      assert.equal(pending.request.provider.threadId, 'session-a');
      assert.equal(pending.request.provider.requestId, 12);
      const card = await messages.getById(pending.cardRef.messageId);
      assert.equal(card.threadId, owner.threadId);
      assert.equal(card.extra.runtimeInteractionCard.interactionId, pending.request.interactionId);
      assert.equal(broadcasts.length, 1);
      const respond = (user, decisionId) =>
        app.inject({
          method: 'POST',
          url: `/api/runtime-interactions/${pending.request.interactionId}/respond`,
          headers: { 'x-cat-cafe-user': user },
          payload: { cardRef: pending.cardRef, response: { kind: 'decision', decisionId } },
        });
      assert.equal((await respond('other-owner', 'option-0')).statusCode, 404);
      assert.equal(replies.length, 0);
      if (answer === 'abort') controller.abort('provider_cancelled');
      else if (answer === 'expired') await service.invalidateInvocation(owner.invocationId, 'expired');
      else
        assert.equal(
          (await respond(owner.userId, answer === 'yes' ? 'option-0' : answer === 'no' ? 'option-1' : 'cancel'))
            .statusCode,
          200,
        );
      await handled;
      for (let attempt = 0; attempt < 50 && !replies.length; attempt++) await new Promise(setImmediate);
      assert.equal(replies.length, 1);
      assert.equal(replies[0].id, request.id);
      assert.deepEqual(
        replies[0].result.outcome,
        ['yes', 'no'].includes(answer) ? { outcome: 'selected', optionId: answer } : { outcome: 'cancelled' },
      );
      assert.equal((await respond(owner.userId, 'option-0')).statusCode, 409);
      assert.equal(replies.length, 1);
    });
  }
}

test('explicit rejection, guard denials and ended turns cannot be approved by ask user', async () => {
  for (const extra of [
    { defaultDecision: 'reject' },
    { guard: async (_req, reply) => reply({ optionId: 'no' }) },
    { isActive: () => false },
  ]) {
    const results = [];
    const handler = createAcpPermissionHandler({
      mode: 'ask_user',
      sessionId: 'session-a',
      isActive: () => true,
      port: {
        request: async () => {
          throw new Error('must not ask');
        },
      },
      ...extra,
    });
    await handler(request, (result) => results.push(result));
    assert.ok(results[0].cancelled || results[0].optionId === 'no');
  }
});
