import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Fastify from 'fastify';
import { A2ADispatchDispositionService } from '../dist/domains/ball-custody/A2ADispatchDispositionService.js';
import { DispatchAdoptionAuthority } from '../dist/domains/ball-custody/DispatchAdoptionAuthority.js';
import { DispatchReceiptService } from '../dist/domains/ball-custody/DispatchReceiptService.js';
import { TurnCustodyAdoptionRegistry } from '../dist/domains/ball-custody/TurnCustodyAdoptionRegistry.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import {
  createInitialQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { LiveCompanionSessions } from '../dist/domains/concierge/live/LiveCompanionSessions.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';
import { liveDispatchAdoption } from '../src/domains/concierge/live/live-dispatch-adoption.ts';
import { createA2ADispositionHarness } from './helpers/a2a-dispatch-disposition-harness.js';

for (const transport of ['http', 'mcp'])
  test(`production Host ${transport} requires real full read before exact adopted completion`, async () => {
    const registry = new InvocationRegistry();
    const h = await createA2ADispositionHarness({ registry, deliveryStatus: 'queued' });
    const identity = await registry.create('user-1', 'codex-sol', 'thread-1');
    const queue = new InvocationQueue();
    const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: h.messageStore });
    const entry = queue.enqueue({
      threadId: 'thread-1',
      userId: 'user-1',
      content: h.source.content,
      messageId: h.source.id,
      source: 'agent',
      targetCats: ['codex-sol'],
      intent: 'execute',
      ownerAuthProvenance: 'strict',
    }).entry;
    h.messageStore.initializeQueueCustody(h.source.id, createInitialQueuedMessageCustody(entry));
    const executions = new InMemoryTurnExecutionStore();
    executions.createRunning({
      invocationId: identity.invocationId,
      parentInvocationId: identity.invocationId,
      userId: 'user-1',
      catId: 'codex-sol',
      threadId: 'thread-1',
      executionKind: 'ordinary',
      queueCompletionPolicy: 'explicit_source',
      startedAt: Date.now(),
    });
    const sessions = new LiveCompanionSessions();
    const receipts = new DispatchReceiptService({
      messageStore: h.messageStore,
      queue,
      coordinator,
      eventLog: h.eventLog,
    });
    const adoption = liveDispatchAdoption({ sessions, receipts, messageStore: h.messageStore });
    const service = new A2ADispatchDispositionService({
      registry,
      messageStore: h.messageStore,
      ballCustodyEventLog: h.eventLog,
      ballCustodyProjectionStore: h.projectionStore,
      ballCustody: h.ingest,
      ...adoption,
      adoptionAuthority: new DispatchAdoptionAuthority({
        executions,
        messages: h.messageStore,
        adoptions: new TurnCustodyAdoptionRegistry(),
        live: sessions,
      }),
    });
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore: h.messageStore,
      invocationQueue: queue,
      queueCustodyCoordinator: coordinator,
      turnExecutionStore: executions,
      withLiveCarrierOperation: adoption.withLiveCarrierOperation,
      ballCustodyEventLog: h.eventLog,
      holdBallDeps: { registry, a2aDispatchDispositionService: service },
      socketManager: { broadcastAgentMessage() {}, emitToUser() {}, broadcastToRoom() {} },
    });
    const apiUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    let mcp;
    const call = await sessions.prepare({
      binding: { userId: 'user-1', threadId: 'thread-1', catId: 'codex-sol', callId: 'call' },
      messageStore: h.messageStore,
      mcpDistDir: resolve('../mcp-server/dist'),
      allowedDirectories: [resolve('../../docs')],
      verifyNativeBinding: async () => true,
      publish() {},
    });
    const headers = { 'x-invocation-id': identity.invocationId, 'x-callback-token': identity.callbackToken };
    const complete = (otherHeaders = headers) =>
      app.inject({
        method: 'POST',
        url: '/api/callbacks/complete-a2a-dispatch',
        headers: otherHeaders,
        payload: { disposition: 'completed', adoptSourceMessageId: h.source.id },
      });
    try {
      sessions.claim(call.id, 'user-1', 'thread-1', ['codex-sol']);
      const config = await call.configure({
        CAT_CAFE_API_URL: apiUrl,
        CAT_CAFE_USER_ID: 'user-1',
        CAT_CAFE_THREAD_ID: 'thread-1',
        CAT_CAFE_CAT_ID: 'codex-sol',
        CAT_CAFE_INVOCATION_ID: identity.invocationId,
        CAT_CAFE_CALLBACK_TOKEN: identity.callbackToken,
      });
      await call.ready('native', { request: async () => ({}), submitText: async () => 'unused' });
      if (transport === 'mcp') {
        const server = config.mcp_servers['cat-cafe-collab'];
        mcp = new Client({ name: 'f317-adoption-test', version: '1' });
        await mcp.connect(
          new StdioClientTransport({ command: server.command, args: server.args, env: server.env, stderr: 'pipe' }),
        );
        const names = new Set((await mcp.listTools()).tools.map((tool) => tool.name));
        assert.ok(names.has('cat_cafe_complete_a2a_dispatch'));
        const meta = { threadId: 'native', 'x-codex-turn-metadata': { thread_id: 'native', turn_id: 'native-turn' } };
        await call.observe({ method: 'turn/started', params: { threadId: 'native', turn: { id: 'native-turn' } } });
        const dispatch = {
          name: 'cat_cafe_complete_a2a_dispatch',
          arguments: { disposition: 'completed', adoptSourceMessageId: h.source.id },
          _meta: meta,
        };
        const unread = await mcp.callTool(dispatch);
        assert.equal(unread.isError, true);
        assert.match(JSON.stringify(unread), /adopted_dispatch_not_read/);
        const read = await mcp.callTool({
          name: 'cat_cafe_get_thread_context',
          arguments: { responseMode: 'full' },
          _meta: meta,
        });
        assert.notEqual(read.isError, true, JSON.stringify(read));
        assert.match(JSON.stringify(read), new RegExp(h.source.id));
        assert.deepEqual(h.messageStore.getById(h.source.id).queueCustody.handledByCatIds, []);
        const result = await mcp.callTool(dispatch);
        assert.notEqual(result.isError, true, JSON.stringify(result));
        assert.match(JSON.stringify(result), /applied/);
        assert.deepEqual(queue.list('thread-1', 'user-1'), []);
        assert.equal(
          h.messageStore.getById(h.source.id).queueCustody.targetOutcomeByCatId['codex-sol'].disposition,
          'dispatch_disposition',
        );
        assert.equal(h.eventLog.events.filter((event) => event.kind === 'ball.dispatch_dispositioned').length, 1);
        await call.observe({ method: 'turn/completed', params: { threadId: 'native', turn: { id: 'native-turn' } } });
        assert.equal(
          (await mcp.callTool(dispatch)).isError,
          true,
          'completed native turn cannot reuse its credentials',
        );
        return;
      }
      const unread = await complete();
      assert.equal(unread.statusCode, 412, unread.body);
      const read = await app.inject({ method: 'GET', url: '/api/callbacks/thread-context?responseMode=full', headers });
      assert.equal(read.statusCode, 200, read.body);
      assert.ok(read.json().messages.some((message) => message.id === h.source.id));
      assert.deepEqual(h.messageStore.getById(h.source.id).queueCustody.handledByCatIds, []);
      const result = await complete();
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(result.json().outcome, 'applied');
      assert.equal((await complete()).json().outcome, 'replayed');
      assert.deepEqual(queue.list('thread-1', 'user-1'), []);
      assert.equal(
        h.messageStore.getById(h.source.id).queueCustody.targetOutcomeByCatId['codex-sol'].disposition,
        'dispatch_disposition',
      );
      const ordinary = await registry.create('user-1', 'codex-sol', 'other-thread');
      const rejected = await complete({
        'x-invocation-id': ordinary.invocationId,
        'x-callback-token': ordinary.callbackToken,
      });
      assert.equal(rejected.statusCode, 409, rejected.body);
      await call.stop();
      assert.equal((await complete()).statusCode, 409);
      assert.equal(h.eventLog.events.filter((event) => event.kind === 'ball.dispatch_dispositioned').length, 1);
    } finally {
      await mcp?.close();
      await call.observe({ method: 'turn/completed', params: { threadId: 'native', turn: { id: 'native-turn' } } });
      await sessions.close();
      await app.close();
    }
  });
