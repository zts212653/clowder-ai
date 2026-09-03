import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 1_000) / 1_000;
}

function opaqueEtag(serialized: string): string {
  const digest = createHash('sha256').update(serialized).digest('base64url');
  return `"${digest}"`;
}

function ifNoneMatchIncludes(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const value = Array.isArray(header) ? header.join(',') : header;
  return value.split(',').some((candidate) => {
    const trimmed = candidate.trim();
    if (trimmed === '*') return true;
    return (trimmed.startsWith('W/') ? trimmed.slice(2) : trimmed) === etag;
  });
}

function traceSidebarSnapshotStage(
  request: FastifyRequest,
  stage: 'composition' | 'serialize' | 'response',
  fields: {
    durationMs?: number;
    responseStatus?: 200 | 304;
    responseBytes?: number;
    serializedBytes?: number;
  },
): void {
  request.log.info(
    {
      feature: 'F297',
      measurement: 'sidebar_snapshot',
      resourceScope: 'user',
      stage,
      ...fields,
    },
    '[F297] Sidebar snapshot stage completed',
  );
}

/**
 * Serialize the complete canonical representation once, then use those exact
 * bytes for both the response body and its conditional validator.
 *
 * This deliberately does not cache composition: a 304 saves transfer and
 * client churn while every request still observes current owner truth.
 */
export function sendCanonicalSidebarSnapshot(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
  compositionStartedAt: number,
): FastifyReply {
  const compositionDurationMs = elapsedMs(compositionStartedAt);
  traceSidebarSnapshotStage(request, 'composition', { durationMs: compositionDurationMs });

  const serializeStartedAt = performance.now();
  const serialized = JSON.stringify(payload);
  const serializeDurationMs = elapsedMs(serializeStartedAt);
  const serializedBytes = Buffer.byteLength(serialized);
  const etag = opaqueEtag(serialized);
  traceSidebarSnapshotStage(request, 'serialize', { durationMs: serializeDurationMs, serializedBytes });

  const notModified = ifNoneMatchIncludes(request.headers['if-none-match'], etag);
  const responseStatus = notModified ? 304 : 200;
  traceSidebarSnapshotStage(request, 'response', {
    responseStatus,
    responseBytes: notModified ? 0 : serializedBytes,
    serializedBytes,
  });

  reply.header('etag', etag);
  reply.header('cache-control', 'private, no-cache');
  reply.header(
    'server-timing',
    `sidebar-compose;dur=${compositionDurationMs}, sidebar-serialize;dur=${serializeDurationMs}`,
  );
  if (notModified) return reply.code(304).send();
  return reply.type('application/json; charset=utf-8').send(serialized);
}
