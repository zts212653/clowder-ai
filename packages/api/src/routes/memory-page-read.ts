/** F321 S2a: owner-facing read projections. Admin/writer endpoints retain their authority. */
import type Database from 'better-sqlite3';
import type { FastifyPluginAsync } from 'fastify';
import { CollectionReadModel } from '../domains/memory/CollectionReadModel.js';
import { generateHealthReport } from '../domains/memory/f163-health-report.js';
import { computeLibraryHealth } from '../domains/memory/f188-library-health.js';
import type { IEvidenceStore, IMarkerQueue } from '../domains/memory/interfaces.js';
import type { LibraryCatalog } from '../domains/memory/LibraryCatalog.js';
import { resolveDirectLocalAuthorizationUserId, resolveSessionUserId } from '../utils/request-identity.js';
import { type BrakeSourceReaders, readBrakeSource } from './memory-brake-source.js';
import { memoryLibraryFeed, visibleMemoryCollections } from './memory-library-read.js';

export interface MemoryPageReadOptions {
  ownerUserId: string;
  catalog: Pick<LibraryCatalog, 'list'>;
  stores: ReadonlyMap<string, IEvidenceStore>;
  evidenceDb: Database.Database;
  markerQueue: Pick<IMarkerQueue, 'list'>;
  repoRoot?: string;
  docsRoot?: string;
  brakeSources?: BrakeSourceReaders;
}

export const memoryPageReadRoutes: FastifyPluginAsync<MemoryPageReadOptions> = async (app, opts) => {
  app.addHook('preHandler', async (request, reply) => {
    const user = resolveSessionUserId(request);
    if (!user) return reply.code(401).send({ error: 'Session required' });
    if (user !== opts.ownerUserId) return reply.code(403).send({ error: 'Owner required' });
  });

  app.get('/api/memory/catalog', async (request) => {
    // Reuse the sensitive-read principal. A remote default-user session cannot grant private titles.
    const visible = visibleMemoryCollections(opts.catalog.list(), resolveDirectLocalAuthorizationUserId(request));
    return {
      collections: visible.map((manifest) => {
        const base = {
          id: manifest.id,
          name: manifest.displayName,
          kind: manifest.kind,
          visibility: manifest.sensitivity,
          status: manifest.status ?? 'active',
        };
        try {
          const store = opts.stores.get(manifest.id) as
            | (IEvidenceStore & { getDb?: () => Database.Database })
            | undefined;
          const db = store?.getDb?.();
          if (!db) return { ...base, readStatus: 'unavailable', docCount: null, lastDocumentUpdatedAt: null };
          const overview = CollectionReadModel.computeOverview(
            manifest.id,
            manifest.displayName,
            manifest.sensitivity,
            db,
          );
          const updated = db.prepare('SELECT max(updated_at) AS t FROM evidence_docs').get() as { t: string | null };
          return { ...base, readStatus: 'ready', docCount: overview.docCount, lastDocumentUpdatedAt: updated.t };
        } catch {
          return { ...base, readStatus: 'unavailable', docCount: null, lastDocumentUpdatedAt: null };
        }
      }),
    };
  });

  app.get('/api/memory/library-feed', async (request) => {
    const visible = visibleMemoryCollections(opts.catalog.list(), resolveDirectLocalAuthorizationUserId(request));
    return memoryLibraryFeed(await opts.markerQueue.list(), visible);
  });

  app.get<{ Params: { eventId: string } }>('/api/memory/brakes/:eventId/source', async (request, reply) => {
    if (!opts.brakeSources) return reply.code(503).send({ error: 'Source reader unavailable' });
    return readBrakeSource(request.params.eventId, opts.ownerUserId, opts.brakeSources);
  });

  app.get('/api/memory/maintenance', async () => {
    const report = generateHealthReport(opts.evidenceDb);
    const health = computeLibraryHealth(opts.evidenceDb, {
      repoRoot: opts.repoRoot,
      docsRoot: opts.docsRoot,
      markers: [],
    });
    const checks = [
      {
        key: 'constitutional',
        label: '核心规则播种',
        count: report.totalDocs > 0 && !report.byAuthority.constitutional ? 1 : 0,
      },
      { key: 'contradictions', label: '待核对的矛盾', count: report.contradictions.unresolved },
      { key: 'overdue', label: '审核已逾期的文档', count: report.staleReview.overdue },
      { key: 'unverified', label: '没有验证记录的文档', count: report.unverified },
      { key: 'stale', label: '源文件已不在的文档', count: health.staleAnchors.count },
      { key: 'orphan', label: '指向不存在文档的关系', count: health.orphanEdges.count },
    ];
    // Count check categories, not documents+edges. Pending candidates have their own section.
    return {
      checks,
      pendingChecks: checks.filter((c) => c.count > 0).length,
      passedChecks: checks.filter((c) => c.count === 0).length,
      generatedAt: report.generatedAt,
    };
  });
};
