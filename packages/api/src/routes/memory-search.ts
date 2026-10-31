import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { readWorkspaceFilePreview } from '../domains/workspace/workspace-file-read.js';
import { resolveDirectLocalAuthorizationUserId } from '../utils/request-identity.js';
import { visibleMemoryCollections } from './memory-library-read.js';
import { memoryDocumentPath } from './memory-search-document-source.js';
import { searchMemoryDocuments } from './memory-search-documents.js';
import {
  checkMemorySearchExecution,
  type MemorySearchGroup,
  type MemorySearchOptions,
  type MemorySearchQuery,
  type SearchExecution,
} from './memory-search-types.js';
import { projectTasteMemory, visibleTasteMemories } from './taste-browse-model.js';

const querySchema = z
  .object({
    q: z.string().trim().min(1).max(2000),
    type: z.enum(['all', 'memory', 'documents', 'conversations']).default('all'),
    depth: z.enum(['summary', 'raw']).default('summary'),
    limit: z.coerce.number().int().min(1).max(20).default(10),
  })
  .strict();
const documentSchema = z
  .object({ collection: z.string().min(1).max(160), anchor: z.string().min(1).max(256) })
  .strict();
const absent = (type: MemorySearchGroup['type']): MemorySearchGroup => ({
  type,
  status: 'unavailable',
  results: [],
  hasMore: false,
});

async function searchTaste(
  opts: MemorySearchOptions,
  privateAccess: boolean,
  query: MemorySearchQuery,
  execution: SearchExecution,
): Promise<MemorySearchGroup> {
  if (!opts.tasteRepository) throw new Error('Taste reader unavailable');
  const terms = query.q.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const memories = await visibleTasteMemories(opts.tasteRepository, opts.ownerUserId, privateAccess);
  checkMemorySearchExecution(execution);
  const matches = memories.filter(({ payload }) =>
    terms.every((term) =>
      [payload.takeaway, payload.scene, ...payload.quotes, ...payload.tags]
        .filter(Boolean)
        .join('\n')
        .toLocaleLowerCase()
        .includes(term),
    ),
  );
  return {
    type: 'memory',
    status: 'ready',
    hasMore: matches.length > query.limit,
    results: matches.slice(0, query.limit).map((memory) => {
      const entry = projectTasteMemory(memory, null);
      return {
        id: entry.id,
        title: entry.title,
        snippet: (query.depth === 'raw' ? entry.quotes.join('\n') : entry.scene).slice(0, 480),
        displayType: '品味',
        authority: null,
        updatedAt: entry.when,
        destination: { kind: 'taste' as const, id: entry.id, revision: entry.revision },
        graph: null,
      };
    }),
  };
}

async function searchMessages(
  opts: MemorySearchOptions,
  query: MemorySearchQuery,
  execution: SearchExecution,
): Promise<MemorySearchGroup> {
  if (!opts.messageSearchService) throw new Error('Message reader unavailable');
  const response = await opts.messageSearchService.search(
    { query: query.q, sort: 'relevance', mode: 'hybrid', limit: query.limit },
    { userId: opts.ownerUserId, viewer: { type: 'user' } },
    execution,
  );
  checkMemorySearchExecution(execution);
  if (!Array.isArray(response.results)) throw new Error('Invalid message search');
  return {
    type: 'conversations',
    status: response.meta.partial || response.meta.degraded ? 'partial' : 'ready',
    hasMore: response.meta.hasMore,
    degraded: response.meta.degraded,
    results: response.results.map((row) => ({
      id: `${row.threadId}:${row.messageId}`,
      title: row.threadTitle.slice(0, 180),
      snippet: row.snippet.text.slice(0, 480),
      displayType: '对话',
      authority: null,
      updatedAt: row.timestamp,
      destination: {
        kind: 'message',
        threadId: row.threadId,
        messageId: row.messageId,
        contentRevision: row.contentRevision,
      },
      graph: null,
    })),
  };
}

/** Registered inside memoryPageReadRoutes' session-owner scope. No agent/header grant. */
export function registerMemorySearchRoutes(app: FastifyInstance, opts: MemorySearchOptions) {
  const principal = (request: FastifyRequest) =>
    resolveDirectLocalAuthorizationUserId(request) === opts.ownerUserId ? opts.ownerUserId : null;
  app.get('/api/memory/search', async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid memory search query' });
    const query = parsed.data;
    const controller = new AbortController();
    const execution = { signal: controller.signal, deadlineAt: Date.now() + 15_000 };
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const disconnect = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    request.raw.once('aborted', disconnect);
    reply.raw.once('close', disconnect);
    try {
      const readers = [
        ['memory', () => searchTaste(opts, principal(request) !== null, query, execution)],
        ['documents', () => searchMemoryDocuments(opts, principal(request), query, execution)],
        ['conversations', () => searchMessages(opts, query, execution)],
      ] as const;
      const groups = await Promise.all(
        readers
          .filter(([type]) => query.type === 'all' || query.type === type)
          .map(async ([type, read]) => {
            try {
              return await read();
            } catch {
              return absent(type);
            }
          }),
      );
      return {
        query: query.q,
        readStatus: groups.every((g) => g.status === 'unavailable')
          ? 'unavailable'
          : groups.some((g) => g.status !== 'ready')
            ? 'partial'
            : 'ready',
        groups,
      };
    } finally {
      clearTimeout(timeout);
      request.raw.removeListener('aborted', disconnect);
      reply.raw.removeListener('close', disconnect);
    }
  });

  app.get('/api/memory/search/document', async (request, reply) => {
    const parsed = documentSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid document query' });
    const manifests = opts.catalog.list();
    const manifest = visibleMemoryCollections(manifests, principal(request)).find(
      (m) => m.id === parsed.data.collection && m.status !== 'archived' && m.status !== 'blocked',
    );
    if (!manifest) return reply.code(404).send({ error: 'Unavailable' });
    try {
      const item = await opts.stores.get(manifest.id)?.getByAnchor(parsed.data.anchor);
      if (!item) return reply.code(404).send({ error: 'Unavailable' });
      const path = await memoryDocumentPath(manifest, item, manifests);
      if (!path) return reply.code(404).send({ error: 'Unavailable' });
      const preview = await readWorkspaceFilePreview(path, { maxBytes: 131_072 });
      if (preview.binary) return reply.code(404).send({ error: 'Unavailable' });
      return { title: item.title, content: preview.content, truncated: preview.truncated };
    } catch {
      return reply.code(404).send({ error: 'Unavailable' });
    }
  });
}
