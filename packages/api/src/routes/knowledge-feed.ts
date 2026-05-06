/**
 * Phase H: Knowledge Emergence Feed API routes.
 *
 * Serves the Hub Knowledge Feed with candidate listing, approval, rejection, and stats.
 * All routes require userId from request (same as evidence routes).
 */

import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { COLLECTION_SENSITIVITY_ORDER } from '../domains/memory/collection-types.js';
import type { IMarkerQueue, IMaterializationService } from '../domains/memory/interfaces.js';
import type { LibraryCatalog } from '../domains/memory/LibraryCatalog.js';

interface KnowledgeFeedDeps {
  markerQueue: IMarkerQueue;
  db: Database.Database;
  materializationService?: IMaterializationService;
  catalog?: LibraryCatalog;
}

export async function knowledgeFeedRoutes(app: FastifyInstance, deps: KnowledgeFeedDeps) {
  const { markerQueue, db, materializationService, catalog } = deps;

  // GET /api/knowledge/feed — List candidates grouped by status
  app.get('/api/knowledge/feed', async (_req, reply) => {
    try {
      const allMarkers = await markerQueue.list();

      // Group by action value (Phase H design: 需要确认 / 已沉淀 / 高频命中 / 值得升级)
      const needsReview = allMarkers.filter(
        (m) => m.status === 'captured' || m.status === 'normalized' || m.status === 'needs_review',
      );
      const settled = allMarkers.filter(
        (m) => m.status === 'approved' || m.status === 'materialized' || m.status === 'indexed',
      );
      const rejected = allMarkers.filter((m) => m.status === 'rejected');

      // Stats from summary_segments
      const stats = { decisions: 0, lessons: 0, methods: 0, total: 0 };
      try {
        const segments = db
          .prepare("SELECT candidates FROM summary_segments WHERE candidates IS NOT NULL AND candidates != 'null'")
          .all() as Array<{ candidates: string }>;
        for (const seg of segments) {
          try {
            const candidates = JSON.parse(seg.candidates);
            if (Array.isArray(candidates)) {
              for (const c of candidates) {
                if (c.kind === 'decision') stats.decisions++;
                else if (c.kind === 'lesson') stats.lessons++;
                else if (c.kind === 'method') stats.methods++;
                stats.total++;
              }
            }
          } catch {
            // skip unparseable
          }
        }
      } catch {
        // fail-open
      }

      return {
        needsReview,
        settled,
        rejected,
        stats,
      };
    } catch (err) {
      reply.status(500).send({ error: 'Failed to fetch knowledge feed' });
    }
  });

  // POST /api/knowledge/approve — Approve a candidate (F186: collection-aware routing)
  app.post<{
    Body: {
      markerId: string;
      targetPath?: string;
      targetCollectionId?: string;
      confirmVisibilityWidening?: boolean;
    };
  }>('/api/knowledge/approve', async (req, reply) => {
    try {
      const { markerId, targetCollectionId, confirmVisibilityWidening } = req.body;
      if (!markerId) return reply.status(400).send({ error: 'markerId required' });

      if (!targetCollectionId) {
        const markers = await markerQueue.list();
        const marker = markers.find((m) => m.id === markerId);
        const srcId = marker?.sourceCollectionId;
        const srcSens = marker?.sourceSensitivity ?? (srcId && catalog ? catalog.get(srcId)?.sensitivity : undefined);
        if (srcSens === 'private' || srcSens === 'restricted') {
          return reply.status(400).send({
            error: 'targetCollectionId required for private/restricted source markers',
          });
        }
      }

      if (targetCollectionId) {
        if (!catalog) {
          return reply.status(400).send({ error: 'Collection catalog unavailable' });
        }
        const target = catalog.get(targetCollectionId);
        if (!target) {
          return reply.status(400).send({ error: `Unknown target collection: ${targetCollectionId}` });
        }
        const markers = await markerQueue.list();
        const marker = markers.find((m) => m.id === markerId);
        const sourceId = marker?.sourceCollectionId;
        const source = sourceId ? catalog.get(sourceId) : undefined;
        const sourceSensitivity = marker?.sourceSensitivity ?? source?.sensitivity;
        if (sourceSensitivity && sourceId !== targetCollectionId) {
          const sourceRank =
            COLLECTION_SENSITIVITY_ORDER[sourceSensitivity as keyof typeof COLLECTION_SENSITIVITY_ORDER];
          const targetRank = COLLECTION_SENSITIVITY_ORDER[target.sensitivity];
          if (sourceRank == null) {
            return reply.status(400).send({
              error: `visibility-widening blocked: unrecognized source sensitivity "${sourceSensitivity}"`,
            });
          }
          if (targetRank > sourceRank && confirmVisibilityWidening !== true) {
            return reply.status(400).send({
              error: 'visibility-widening requires confirmation',
              detail: `Promoting from ${sourceSensitivity} (${sourceId ?? 'unknown source collection'}) to ${target.sensitivity} (${targetCollectionId}) widens visibility. Set confirmVisibilityWidening: true to proceed.`,
            });
          }
        }
      }

      await markerQueue.transition(markerId, 'approved', targetCollectionId ? { targetCollectionId } : undefined);

      let materialized;
      if (materializationService) {
        try {
          materialized = await materializationService.materialize(markerId);
        } catch {
          // Materialize failure is non-fatal — marker stays approved
        }
      }

      return { status: 'approved', markerId, materialized, targetCollectionId };
    } catch (err) {
      reply.status(500).send({ error: 'Failed to approve candidate' });
    }
  });

  // POST /api/knowledge/reject — Reject a candidate
  app.post<{ Body: { markerId: string } }>('/api/knowledge/reject', async (req, reply) => {
    try {
      const { markerId } = req.body;
      if (!markerId) return reply.status(400).send({ error: 'markerId required' });

      await markerQueue.transition(markerId, 'rejected');
      return { status: 'rejected', markerId };
    } catch (err) {
      reply.status(500).send({ error: 'Failed to reject candidate' });
    }
  });

  // POST /api/knowledge/undo — Undo (revert approved to needs_review)
  app.post<{ Body: { markerId: string } }>('/api/knowledge/undo', async (req, reply) => {
    try {
      const { markerId } = req.body;
      if (!markerId) return reply.status(400).send({ error: 'markerId required' });

      await markerQueue.transition(markerId, 'needs_review');
      return { status: 'needs_review', markerId };
    } catch (err) {
      reply.status(500).send({ error: 'Failed to undo approval' });
    }
  });

  // GET /api/knowledge/stats — Quick stats for badge display
  app.get('/api/knowledge/stats', async () => {
    try {
      const allMarkers = await markerQueue.list();
      const pending = allMarkers.filter(
        (m) => m.status === 'captured' || m.status === 'normalized' || m.status === 'needs_review',
      ).length;
      const settled = allMarkers.filter(
        (m) => m.status === 'approved' || m.status === 'materialized' || m.status === 'indexed',
      ).length;

      return { pending, settled, total: allMarkers.length };
    } catch {
      return { pending: 0, settled: 0, total: 0 };
    }
  });
}
