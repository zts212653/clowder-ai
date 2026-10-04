import type { MessageSearchInput } from '@cat-cafe/shared';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  MessageSearchAccessError,
  type MessageSearchPrincipal,
  type MessageSearchService,
} from '../domains/memory/MessageSearchService.js';

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value, {
    message: 'Expected a valid ISO date, e.g. 2026-10-02',
  });
const dateFilter = z.string().datetime({ offset: true }).or(dateOnly).optional();

export const messageSearchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(2000),
    resultUnit: z.enum(['document', 'message']).optional(),
    messageSort: z.enum(['time', 'relevance']).optional(),
    limit: z.coerce.number().int().min(1).max(20).optional(),
    threadId: z.string().min(1).max(256).optional(),
    scope: z.enum(['docs', 'memory', 'threads', 'sessions', 'all']).optional(),
    mode: z.enum(['lexical', 'semantic', 'hybrid']).optional(),
    dimension: z.enum(['project', 'global', 'library', 'collection', 'all']).optional(),
    intent: z.enum(['topk', 'coverage']).optional(),
    dateFrom: dateFilter,
    dateTo: dateFilter,
  })
  .refine(
    (input) =>
      input.resultUnit !== 'message' ||
      ((!input.scope || input.scope === 'threads') &&
        (!input.dimension || input.dimension === 'project') &&
        input.intent !== 'coverage'),
    { message: 'Message search requires scope=threads, project data and topk intent' },
  );

export function toMessageSearchInput(query: z.infer<typeof messageSearchQuerySchema>): MessageSearchInput {
  return {
    query: query.q,
    threadId: query.threadId,
    sort: query.messageSort ?? 'time',
    mode: query.mode ?? 'hybrid',
    limit: query.limit ?? 20,
    ...(query.dateFrom ? { dateFrom: query.dateFrom } : {}),
    ...(query.dateTo ? { dateTo: query.dateTo } : {}),
  };
}

export async function executeMessageSearch(
  service: MessageSearchService | undefined,
  input: MessageSearchInput,
  principal: MessageSearchPrincipal,
  reply: FastifyReply,
) {
  if (!service) {
    reply.status(503);
    return { error: 'Message search unavailable', degraded: true, degradeReason: 'message_search_unavailable' };
  }
  const controller = new AbortController();
  const deadlineAt = Date.now() + 15_000;
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Message search deadline exceeded', 'TimeoutError')),
    15_000,
  );
  const disconnect = () => {
    if (!reply.raw.writableEnded)
      controller.abort(new DOMException('Message search client disconnected', 'AbortError'));
  };
  reply.raw.once('close', disconnect);
  try {
    return await service.search(input, principal, { signal: controller.signal, deadlineAt });
  } catch (error) {
    if (error instanceof MessageSearchAccessError) {
      reply.status(error.statusCode);
      return { error: error.message, code: 'MESSAGE_SEARCH_ACCESS_DENIED' };
    }
    reply.log.warn({ err: error }, 'Message search unavailable');
    reply.status(503);
    return { error: 'Message search unavailable', degraded: true, degradeReason: 'message_search_unavailable' };
  } finally {
    clearTimeout(timeout);
    reply.raw.removeListener('close', disconnect);
  }
}
