import type { CallbackPrincipal } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  MemoryDirectReadConflict,
  type MemoryReadItem,
  recordMemoryDirectRead,
} from '../domains/memory/read-usage/MemoryDirectReadEvidence.js';

function withoutReadId(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { readRequestId: _readRequestId, ...parameters } = value as Record<string, unknown>;
  return parameters;
}

/** The read accepts its observation before committing delivery-dependent effects such as drill budget. */
export async function deliverMemoryDirectRead<T extends object>(
  request: FastifyRequest,
  reply: FastifyReply,
  db: Database.Database | undefined,
  principal: CallbackPrincipal,
  requestId: string | undefined,
  read: (record: (items: readonly MemoryReadItem[]) => void) => Promise<T>,
) {
  let observation: { readRequestId?: string; usageRecorded: boolean } | undefined;
  const record = (items: readonly MemoryReadItem[]) => {
    observation = { ...(requestId ? { readRequestId: requestId } : {}), usageRecorded: false };
    if (!requestId || !db) return;
    try {
      recordMemoryDirectRead(db, principal, requestId, items, {
        method: request.method,
        route: request.routeOptions.url,
        params: request.params,
        body: withoutReadId(request.body),
        query: withoutReadId(request.query),
      });
      observation.usageRecorded = true;
    } catch (error) {
      if (error instanceof MemoryDirectReadConflict) throw error;
      request.log.warn({ err: error }, 'Memory read observation unavailable');
    }
  };
  try {
    const result = await read(record);
    // An empty result retains retry identity without counting a successful item.
    if (!observation) record([]);
    return { ...result, ...observation };
  } catch (error) {
    if (error instanceof MemoryDirectReadConflict)
      return reply.code(409).send({ error: error.message, readRequestId: requestId });
    throw error;
  }
}

export function finishMemoryDirectRead<T extends object>(
  request: FastifyRequest,
  reply: FastifyReply,
  db: Database.Database | undefined,
  principal: CallbackPrincipal,
  requestId: string | undefined,
  result: T,
  items: readonly MemoryReadItem[],
) {
  return deliverMemoryDirectRead(request, reply, db, principal, requestId, async (record) => {
    record(items);
    return result;
  });
}
