import { RECALL_RESOLVER_FAMILIES, type RecallResolverFamily } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import type { FastifyPluginAsync } from 'fastify';
import { MemoryCueSourceSummaryReader } from '../domains/memory/cue/MemoryCueSourceSummaryReader.js';
import { resolveDirectLocalAuthorizationUserId } from '../utils/request-identity.js';

export interface MemoryCueSourceSummaryOptions {
  evidenceDb: Database.Database;
}

/** F321 A1b: owner-local, content-free source-anchor read model. */
export const memoryCueSourceSummaryRoutes: FastifyPluginAsync<MemoryCueSourceSummaryOptions> = async (app, opts) => {
  const reader = new MemoryCueSourceSummaryReader(opts.evidenceDb);
  app.get<{ Querystring: { resolverFamily?: string; sourceAnchor?: string } }>(
    '/api/memory/cues/source-summary',
    async (request, reply) => {
      const ownerUserId = resolveDirectLocalAuthorizationUserId(request);
      if (!ownerUserId) return reply.status(401).send({ error: 'Owner authentication required' });

      const { resolverFamily, sourceAnchor } = request.query;
      if (!resolverFamily || !RECALL_RESOLVER_FAMILIES.includes(resolverFamily as RecallResolverFamily)) {
        return reply.status(400).send({ error: 'Invalid resolverFamily' });
      }
      if (typeof sourceAnchor !== 'string' || !sourceAnchor.trim() || sourceAnchor.length > 500) {
        return reply.status(400).send({ error: 'Invalid sourceAnchor' });
      }
      return reader.summarize(ownerUserId, resolverFamily as RecallResolverFamily, sourceAnchor.trim());
    },
  );
};
