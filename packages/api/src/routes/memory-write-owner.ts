import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IMarkerQueue } from '../domains/memory/interfaces.js';
import type { LibraryCatalog } from '../domains/memory/LibraryCatalog.js';
import { isDirectLoopbackRequest } from '../utils/loopback-request.js';
import { resolveDirectLocalAuthorizationUserId, resolveSessionUserId } from '../utils/request-identity.js';
import { visibleMemoryCollections } from './memory-library-read.js';

/** Production memory writers bind the same configured owner as the read projections. */
export function memoryWriteOwner(ownerUserId: string | undefined, localOnly = false) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    // Preserve the existing contract for legacy embedders; the application supplies its configured owner.
    if (ownerUserId === undefined) return;
    if (localOnly && !isDirectLoopbackRequest(request))
      return reply.code(403).send({ error: 'Direct localhost required' });
    const userId = localOnly ? resolveDirectLocalAuthorizationUserId(request) : resolveSessionUserId(request);
    if (!userId) return reply.code(401).send({ error: 'Session required' });
    if (!ownerUserId.trim() || userId !== ownerUserId) return reply.code(403).send({ error: 'Owner required' });
  };
}

export function knowledgeWriteOwner(opts: {
  ownerUserId?: string;
  markerQueue: Pick<IMarkerQueue, 'list'>;
  catalog?: LibraryCatalog;
}) {
  const requireOwner = memoryWriteOwner(opts.ownerUserId);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    await requireOwner(request, reply);
    if (reply.sent || opts.ownerUserId === undefined) return;
    const body = request.body as { markerId?: string; targetCollectionId?: string } | undefined;
    if (!body?.markerId) return; // Existing handler owns input validation.
    const visible = visibleMemoryCollections(
      opts.catalog?.list() ?? [],
      resolveDirectLocalAuthorizationUserId(request),
    );
    const ids = new Set(visible.map((m) => m.id));
    const marker = (await opts.markerQueue.list()).find((m) => m.id === body.markerId);
    const allowed =
      marker &&
      (marker.sourceCollectionId
        ? ids.has(marker.sourceCollectionId)
        : !marker.sourceSensitivity ||
          marker.sourceSensitivity === 'public' ||
          marker.sourceSensitivity === 'internal');
    if (!allowed || (body.targetCollectionId && !ids.has(body.targetCollectionId))) {
      return reply.code(404).send({ error: 'Candidate or target unavailable' });
    }
  };
}
