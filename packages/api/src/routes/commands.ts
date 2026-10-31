/**
 * Commands API Routes
 * POST /api/commands/extract-tasks - Extract tasks from conversation
 */

import { type CommandSurface, catRegistry } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { extractTasks, toCreateTaskInputs } from '../domains/cats/services/orchestration/TaskExtractor.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { AgentService } from '../domains/cats/services/types.js';
import type { CommandRegistry } from '../infrastructure/commands/CommandRegistry.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { resolveUserId } from '../utils/request-identity.js';

export interface CommandsRoutesOptions {
  messageStore: IMessageStore;
  taskStore: ITaskStore;
  socketManager: SocketManager;
  /** Opus service for LLM-powered extraction */
  opusService: AgentService;
  /** Optional thread ownership guard (enabled in production wiring). */
  threadStore?: IThreadStore;
  /** F142 Phase B: unified command registry for listing */
  registry?: CommandRegistry;
}

const extractTasksSchema = z.object({
  threadId: z.string().min(1).max(100),
  /** Legacy fallback only; preferred identity source is X-Cat-Cafe-User header. */
  userId: z.string().min(1).max(100).optional(),
  /** Number of recent messages to analyze (default: 50) */
  messageCount: z.number().int().min(1).max(200).optional(),
});

const VALID_SURFACES = new Set<string>(['web', 'connector', 'both']);

export const commandsRoutes: FastifyPluginAsync<CommandsRoutesOptions> = async (app, opts) => {
  // GET /api/commands — F142 Phase B: list commands filtered by surface (AC-B8)
  if (opts.registry) {
    const registry = opts.registry;
    app.get('/api/commands', async (request) => {
      const { surface } = request.query as { surface?: string };
      if (surface && !VALID_SURFACES.has(surface)) {
        return { commands: [], error: 'Invalid surface (web|connector|both)' };
      }
      const commands = surface ? registry.listBySurface(surface as CommandSurface) : registry.getAll();
      return { commands };
    });
  }

  // POST /api/commands/extract-tasks
  app.post('/api/commands/extract-tasks', async (request, reply) => {
    const parseResult = extractTasksSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parseResult.error.issues };
    }

    const { threadId, userId: legacyUserId, messageCount } = parseResult.data;
    const userId = resolveUserId(request, { fallbackUserId: legacyUserId });
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }

    // Ownership guard: default thread is shared; non-default threads are owner-scoped.
    if (opts.threadStore && threadId !== 'default') {
      const thread = await opts.threadStore.get(threadId);
      if (!thread) {
        reply.status(404);
        return { error: 'Thread not found' };
      }
      if (thread.createdBy !== userId) {
        reply.status(403);
        return { error: 'Access denied' };
      }
    }

    // Get thread history
    const messages = await opts.messageStore.getByThread(threadId, messageCount ?? 50, userId);

    if (messages.length === 0 || catRegistry.getAllIds().length === 0) {
      return { tasks: [], degraded: false, count: 0 };
    }

    // Extract tasks using LLM
    const result = await extractTasks(messages, opts.opusService, {
      threadId,
      userId,
      maxMessages: messageCount ?? 50,
    });

    // Convert to CreateTaskInput and store
    const inputs = toCreateTaskInputs(result.tasks, threadId, 'user');
    const createdTasks = [];

    for (const input of inputs) {
      const task = await opts.taskStore.create(input);
      createdTasks.push(task);

      // Broadcast task_created
      opts.socketManager.broadcastToRoom(`thread:${threadId}`, 'task_created', task);
    }

    return {
      tasks: createdTasks,
      degraded: result.degraded,
      ...(result.reason ? { reason: result.reason } : {}),
      count: createdTasks.length,
    };
  });
};
