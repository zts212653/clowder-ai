/**
 * Memory API Routes
 * POST /api/memory - Write memory entry
 * GET /api/memory - Read memory entry or list all
 * DELETE /api/memory - Delete memory entry
 */

import { catIdSchema, createCatId, type MemoryEntry, type MemoryInput } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { MemoryProviderCallError } from '../domains/plugin/host-surface/memory/memory-plugin-host.js';
import { resolveUserId } from '../utils/request-identity.js';

export interface MemoryRoutesOptions {
  memoryStore(scope: { userId: string; threadId: string; request: FastifyRequest; reply: FastifyReply }): {
    set(input: MemoryInput): Promise<MemoryEntry>;
    get(threadId: string, key: string): Promise<MemoryEntry | null>;
    list(threadId: string): Promise<MemoryEntry[]>;
    delete(threadId: string, key: string): Promise<boolean>;
  };
  /** Optional thread ownership guard (enabled in production wiring). */
  threadStore?: IThreadStore;
  deploymentOwnerUserId?: string;
}

const writeSchema = z.object({
  threadId: z.string().min(1).max(100),
  key: z.string().min(1).max(100),
  value: z.string().min(1).max(10000),
  updatedBy: z.union([catIdSchema(), z.literal('user')]),
});

const readSchema = z.object({
  threadId: z.string().min(1).max(100),
  key: z.string().min(1).max(100).optional(),
});

const deleteSchema = z.object({
  threadId: z.string().min(1).max(100),
  key: z.string().min(1).max(100),
});

export const memoryRoutes: FastifyPluginAsync<MemoryRoutesOptions> = async (app, opts) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof MemoryProviderCallError) {
      void reply.code(503).send({ error: error.message, effect: error.effect });
      return;
    }
    throw error;
  });
  async function authorizeThread(threadId: string, userId: string, reply: FastifyReply): Promise<boolean> {
    if (threadId === 'default') {
      if (opts.deploymentOwnerUserId === undefined || opts.deploymentOwnerUserId === userId) return true;
      reply.status(403);
      return false;
    }
    if (!opts.threadStore) return true;
    const thread = await opts.threadStore.get(threadId);
    if (!thread) {
      reply.status(404);
      return false;
    }
    if (thread.createdBy !== userId) {
      reply.status(403);
      return false;
    }
    return true;
  }

  // POST /api/memory — write entry
  app.post('/api/memory', async (request, reply) => {
    const parseResult = writeSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parseResult.error.issues };
    }

    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }

    const { threadId, key, value, updatedBy } = parseResult.data;
    if (!(await authorizeThread(threadId, userId, reply))) {
      const status = reply.statusCode;
      if (status === 404) return { error: 'Thread not found' };
      return { error: 'Access denied' };
    }

    const resolvedUpdatedBy = updatedBy === 'user' ? ('user' as const) : createCatId(updatedBy);
    const store = opts.memoryStore({ userId, threadId, request, reply });
    const entry = await store.set({ threadId, key, value, updatedBy: resolvedUpdatedBy });

    reply.status(201);
    return entry;
  });

  // GET /api/memory — read single key or list all
  app.get('/api/memory', async (request, reply) => {
    const parseResult = readSchema.safeParse(request.query);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid query parameters', details: parseResult.error.issues };
    }

    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }

    const { threadId, key } = parseResult.data;
    if (!(await authorizeThread(threadId, userId, reply))) {
      const status = reply.statusCode;
      if (status === 404) return { error: 'Thread not found' };
      return { error: 'Access denied' };
    }

    const store = opts.memoryStore({ userId, threadId, request, reply });
    if (key) {
      // Single key lookup
      const entry = await store.get(threadId, key);
      if (!entry) {
        reply.status(404);
        return { error: 'Memory entry not found' };
      }
      return entry;
    }

    // List all keys for thread
    const entries = await store.list(threadId);
    return { entries };
  });

  // DELETE /api/memory — delete single key
  app.delete('/api/memory', async (request, reply) => {
    const parseResult = deleteSchema.safeParse(request.query);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid query parameters', details: parseResult.error.issues };
    }

    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }

    const { threadId, key } = parseResult.data;
    if (!(await authorizeThread(threadId, userId, reply))) {
      const status = reply.statusCode;
      if (status === 404) return { error: 'Thread not found' };
      return { error: 'Access denied' };
    }

    const deleted = await opts.memoryStore({ userId, threadId, request, reply }).delete(threadId, key);

    if (!deleted) {
      reply.status(404);
      return { error: 'Memory entry not found' };
    }

    reply.status(204);
    return;
  });
};
