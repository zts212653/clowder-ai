/**
 * F163 Phase C: Audit routes — contradiction check, flag-review, review-queue, health-report.
 * Extracted from f163-admin.ts to stay under 350-line limit.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ContradictionDetector } from '../domains/memory/f163-contradiction-detector.js';
import { F163ExperimentLogger } from '../domains/memory/f163-experiment-logger.js';
import { generateHealthReport } from '../domains/memory/f163-health-report.js';
import { queryReviewQueue } from '../domains/memory/f163-review-queue.js';
import { computeVariantId, freezeFlags } from '../domains/memory/f163-types.js';
import type { EvidenceItem, SearchOptions } from '../domains/memory/interfaces.js';

function isLocalhost(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

const contradictionCheckSchema = z.object({
  title: z.string().min(1),
  summary: z.string().optional(),
  kind: z.string().min(1),
});

const flagReviewSchema = z.object({
  anchor: z.string().min(1),
  reason: z.string().min(1),
});

interface AuditRoutesOptions {
  evidenceStore: {
    search(query: string, options?: SearchOptions): Promise<EvidenceItem[]>;
    getByAnchor(anchor: string): Promise<EvidenceItem | null>;
    getDb(): {
      prepare(sql: string): {
        run(...args: unknown[]): { changes: number };
        all(...args: unknown[]): unknown[];
        get(...args: unknown[]): unknown;
      };
    };
    runExclusive<T>(fn: () => T | Promise<T>): Promise<T>;
  };
}

export const f163AuditRoutes: FastifyPluginAsync<AuditRoutesOptions> = async (app, opts) => {
  // ── POST /api/f163/contradictions/check (AC-C1) ────────────────────

  app.post('/api/f163/contradictions/check', async (request, reply) => {
    if (!isLocalhost(request.ip)) {
      reply.status(403);
      return { error: 'only allowed from localhost' };
    }

    const flags = freezeFlags();
    if (flags.contradictionDetection === 'off') {
      reply.status(403);
      return { error: 'contradiction detection is disabled (F163_CONTRADICTION_DETECTION=off)' };
    }

    const parsed = contradictionCheckSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const detector = new ContradictionDetector(opts.evidenceStore);
    const hits = await detector.check(parsed.data);

    try {
      const db = opts.evidenceStore.getDb();
      const logger = new F163ExperimentLogger(db as ConstructorParameters<typeof F163ExperimentLogger>[0]);
      const variantId = computeVariantId(flags);
      logger.log('contradiction_check', variantId, flags, { hitsFound: hits.length });
    } catch {
      // fail-open
    }

    return { hits, flags: { contradictionDetection: flags.contradictionDetection } };
  });

  // ── POST /api/f163/flag-review (AC-C2) ─────────────────────────────

  app.post('/api/f163/flag-review', async (request, reply) => {
    if (!isLocalhost(request.ip)) {
      reply.status(403);
      return { error: 'only allowed from localhost' };
    }

    const parsed = flagReviewSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { anchor, reason } = parsed.data;
    const doc = await opts.evidenceStore.getByAnchor(anchor);
    if (!doc) {
      reply.status(404);
      return { error: `Anchor not found: ${anchor}` };
    }

    const now = new Date().toISOString();
    const result = await opts.evidenceStore.runExclusive(() => {
      const db = opts.evidenceStore.getDb();
      return db.prepare("UPDATE evidence_docs SET status = 'review', invalid_at = ? WHERE anchor = ?").run(now, anchor);
    });

    if (result.changes === 0) {
      reply.status(500);
      return { error: 'Update failed' };
    }

    return { ok: true, anchor, previousStatus: doc.status, newStatus: 'review', reason };
  });

  // ── GET /api/f163/review-queue (AC-C3) ─────────────────────────────

  app.get('/api/f163/review-queue', async (request, reply) => {
    if (!isLocalhost(request.ip)) {
      reply.status(403);
      return { error: 'only allowed from localhost' };
    }

    const flags = freezeFlags();
    if (flags.reviewQueue === 'off') {
      reply.status(403);
      return { error: 'review queue is disabled (F163_REVIEW_QUEUE=off)' };
    }

    const db = opts.evidenceStore.getDb();
    const items = queryReviewQueue(db as Parameters<typeof queryReviewQueue>[0]);

    return { items, flags: { reviewQueue: flags.reviewQueue } };
  });

  // ── GET /api/f163/health-report (AC-C4) ────────────────────────────

  app.get('/api/f163/health-report', async (request, reply) => {
    if (!isLocalhost(request.ip)) {
      reply.status(403);
      return { error: 'only allowed from localhost' };
    }

    const db = opts.evidenceStore.getDb();
    const report = generateHealthReport(db as Parameters<typeof generateHealthReport>[0]);

    return report;
  });
};
