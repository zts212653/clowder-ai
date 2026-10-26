import './setup-cat-registry.js';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { AgentKeyRegistry } from '../../src/domains/cats/services/agents/agent-key/AgentKeyRegistry.js';
import { InvocationRegistry } from '../../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../../src/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../../src/domains/cats/services/stores/ports/ThreadStore.js';
import { callbacksRoutes } from '../../src/routes/callbacks.js';

export async function fixture(t: TestContext, options: { sourceDown?: boolean; sourceDelayMs?: number } = {}) {
  const threadStore = new ThreadStore();
  const taskStore = new TaskStore();
  const messageStore = new MessageStore();
  const registry = new InvocationRegistry();
  const agentKeyRegistry = new AgentKeyRegistry();
  const auth = await registry.create('owner', createCatId('codex61-sol'));
  const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  const app = Fastify();
  const sourceLifetime = new AbortController();
  const executions: Array<{
    threadId: string;
    threadTitle: string;
    catId: string;
    kind: string;
    startedAt: number;
    cancelability: { state: string };
  }> = [];
  app.get('/api/executions/active', async () => {
    if (options.sourceDelayMs)
      await delay(options.sourceDelayMs, undefined, { signal: sourceLifetime.signal }).catch(() => {});
    return options.sourceDown ? {} : { projectPath: process.cwd(), executions };
  });
  await app.register(callbacksRoutes, {
    registry,
    threadStore,
    taskStore,
    messageStore,
    agentKeyRegistry,
    companionProjectPath: process.cwd(),
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} } as never,
  });
  t.after(async () => {
    sourceLifetime.abort();
    await app.close();
  });
  return { app, headers, registry, threadStore, taskStore, messageStore, executions, agentKeyRegistry };
}
