/**
 * F163: Admin routes — promotion (AC-A6) + compression scan/apply (AC-B1/B2)
 * POST /api/f163/promote — upgrade authority level
 * POST /api/f163/compress/scan — run duplicate scanner (AC-B1)
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { DuplicateScanner } from '../domains/memory/f163-duplicate-scanner.js';
import { F163ExperimentLogger } from '../domains/memory/f163-experiment-logger.js';
import type { F163Authority } from '../domains/memory/f163-types.js';
import { computeVariantId, freezeFlags } from '../domains/memory/f163-types.js';

const AUTHORITY_LEVELS: F163Authority[] = ['observed', 'candidate', 'validated', 'constitutional'];

const promoteSchema = z.object({
  anchor: z.string().min(1),
  targetAuthority: z.enum(['observed', 'candidate', 'validated', 'constitutional']),
  reason: z.string().min(1),
});

const scanSchema = z
  .object({
    threshold: z.number().min(0).max(1).optional(),
    kinds: z.array(z.string()).optional(),
  })
  .optional();

interface F163AdminRoutesOptions {
  evidenceStore: {
    getByAnchor(anchor: string): Promise<{ authority?: string } | null>;
    getDb(): {
      prepare(sql: string): { run(...args: unknown[]): { changes: number }; all(...args: unknown[]): unknown[] };
    };
    runExclusive<T>(fn: () => T | Promise<T>): Promise<T>;
    createSummary(params: {
      sourceAnchors: string[];
      title: string;
      summary: string;
      rationale: string;
    }): Promise<string>;
  };
}

const applySchema = z.object({
  sourceAnchors: z.array(z.string().min(1)).min(2),
  summaryTitle: z.string().min(1),
  summarySummary: z.string().min(1),
  rationale: z.string().min(1),
});

export const f163AdminRoutes: FastifyPluginAsync<F163AdminRoutesOptions> = async (app, opts) => {
  app.post('/api/f163/promote', async (request, reply) => {
    // Localhost-only guard
    const remoteIp = request.ip;
    if (remoteIp !== '127.0.0.1' && remoteIp !== '::1' && remoteIp !== '::ffff:127.0.0.1') {
      reply.status(403);
      return { error: 'promote only allowed from localhost' };
    }

    const parsed = promoteSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { anchor, targetAuthority, reason } = parsed.data;

    // Find current item
    const item = await opts.evidenceStore.getByAnchor(anchor);
    if (!item) {
      reply.status(404);
      return { error: `Anchor not found: ${anchor}` };
    }

    const currentAuthority = (item.authority as F163Authority) ?? 'observed';
    const currentLevel = AUTHORITY_LEVELS.indexOf(currentAuthority);
    const targetLevel = AUTHORITY_LEVELS.indexOf(targetAuthority);

    // Constitutional requires CVO-only flag (not implemented yet — block for now)
    if (targetAuthority === 'constitutional') {
      reply.status(403);
      return { error: 'Promotion to constitutional requires CVO approval (not yet available via API)' };
    }

    // Only allow upward promotion
    if (targetLevel <= currentLevel) {
      reply.status(400);
      return { error: `Can only promote upward: ${currentAuthority} → ${targetAuthority} is not an upgrade` };
    }

    // Apply promotion — routed through single-writer queue (F163 AC-A5)
    const now = new Date().toISOString();
    const result = await opts.evidenceStore.runExclusive(() => {
      const db = opts.evidenceStore.getDb();
      return db
        .prepare('UPDATE evidence_docs SET authority = ?, verified_at = ? WHERE anchor = ?')
        .run(targetAuthority, now, anchor);
    });

    if (result.changes === 0) {
      reply.status(500);
      return { error: 'Update failed' };
    }

    return {
      ok: true,
      anchor,
      previousAuthority: currentAuthority,
      newAuthority: targetAuthority,
      reason,
      verifiedAt: now,
    };
  });

  // ── Phase B: Compression scan (AC-B1) ──────────────────────────────

  app.post('/api/f163/compress/scan', async (request, reply) => {
    // Localhost-only guard
    const remoteIp = request.ip;
    if (remoteIp !== '127.0.0.1' && remoteIp !== '::1' && remoteIp !== '::ffff:127.0.0.1') {
      reply.status(403);
      return { error: 'compression scan only allowed from localhost' };
    }

    // Flag gate: compression must not be 'off'
    const flags = freezeFlags();
    if (flags.compression === 'off') {
      reply.status(403);
      return { error: 'compression is disabled (F163_COMPRESSION=off)' };
    }

    const parsed = scanSchema.safeParse(request.body);
    if (parsed !== undefined && !parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const options = parsed?.data;
    const db = opts.evidenceStore.getDb();
    const scanner = new DuplicateScanner();
    const suggestions = scanner.scan(db as Parameters<typeof scanner.scan>[0], {
      threshold: options?.threshold,
      kinds: options?.kinds,
    });

    try {
      const logger = new F163ExperimentLogger(db as ConstructorParameters<typeof F163ExperimentLogger>[0]);
      const variantId = computeVariantId(flags);
      logger.logCompressionScan(variantId, flags, {
        clustersFound: suggestions.length,
        threshold: options?.threshold ?? 0.6,
      });
    } catch {
      // fail-open: logging must not block scan results
    }

    return { suggestions, flags: { compression: flags.compression } };
  });

  // ── Phase B: Compression apply (AC-B2) ─────────────────────────────

  app.post('/api/f163/compress/apply', async (request, reply) => {
    // Localhost-only guard
    const remoteIp = request.ip;
    if (remoteIp !== '127.0.0.1' && remoteIp !== '::1' && remoteIp !== '::ffff:127.0.0.1') {
      reply.status(403);
      return { error: 'compression apply only allowed from localhost' };
    }

    // Flag gate: compression must be 'apply'
    const flags = freezeFlags();
    if (flags.compression !== 'apply') {
      reply.status(403);
      return { error: `compression apply requires F163_COMPRESSION=apply, got '${flags.compression}'` };
    }

    const parsed = applySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { sourceAnchors, summaryTitle, summarySummary, rationale } = parsed.data;

    try {
      const summaryAnchor = await opts.evidenceStore.createSummary({
        sourceAnchors,
        title: summaryTitle,
        summary: summarySummary,
        rationale,
      });

      try {
        const db = opts.evidenceStore.getDb();
        const logger = new F163ExperimentLogger(db as ConstructorParameters<typeof F163ExperimentLogger>[0]);
        const variantId = computeVariantId(flags);
        logger.logCompressionApply(variantId, flags, { summaryAnchor, sourceAnchors });
      } catch {
        // fail-open: logging must not block apply result
      }

      return { ok: true, summaryAnchor };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.status(400);
      return { error: msg };
    }
  });

  // ── Phase B: Source expansion (AC-B3) ──────────────────────────────

  app.get('/api/f163/expand/:anchor', async (request, reply) => {
    const { anchor } = request.params as { anchor: string };

    // Look up the doc
    const doc = await opts.evidenceStore.getByAnchor(anchor);
    if (!doc) {
      reply.status(404);
      return { error: `Anchor not found: ${anchor}` };
    }

    // Must be a summary
    const db = opts.evidenceStore.getDb();
    const row = db.prepare('SELECT source_ids, summary_of_anchor FROM evidence_docs WHERE anchor = ?').all(anchor)[0] as
      | { source_ids: string | null; summary_of_anchor: string | null }
      | undefined;

    if (!row?.summary_of_anchor) {
      reply.status(400);
      return { error: `${anchor} is not a summary (no summary_of_anchor)` };
    }

    const sourceIds: string[] = row.source_ids ? JSON.parse(row.source_ids) : [];
    const sources = [];
    for (const sid of sourceIds) {
      const source = await opts.evidenceStore.getByAnchor(sid);
      if (source) sources.push(source);
    }

    return { summary: doc, sources };
  });
};
