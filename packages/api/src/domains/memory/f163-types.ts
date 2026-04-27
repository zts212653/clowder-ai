// F163: Knowledge lifecycle types + experiment framework types

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

export type F163Authority = 'constitutional' | 'validated' | 'candidate' | 'observed';
export type F163Activation = 'always_on' | 'scoped' | 'query' | 'backstop';

/** Boost source attribution (search-path, not injection) */
export type BoostSource = 'authority_boost' | 'retrieval_rerank' | 'compression_summary' | 'legacy';

export interface F163FlagSnapshot {
  authorityBoost: 'off' | 'shadow' | 'on';
  alwaysOnInjection: 'off' | 'shadow' | 'on';
  retrievalRerank: 'off' | 'shadow' | 'on';
  compression: 'off' | 'suggest' | 'apply';
  promotionGate: 'off' | 'suggest' | 'apply';
  contradictionDetection: 'off' | 'suggest' | 'apply';
  reviewQueue: 'off' | 'suggest' | 'apply';
}

/** Freeze current F163 flag values from env vars — immutable per request */
export function freezeFlags(): F163FlagSnapshot {
  return Object.freeze({
    authorityBoost: (process.env.F163_AUTHORITY_BOOST as 'off' | 'shadow' | 'on') ?? 'off',
    alwaysOnInjection: (process.env.F163_ALWAYS_ON_INJECTION as 'off' | 'shadow' | 'on') ?? 'off',
    retrievalRerank: (process.env.F163_RETRIEVAL_RERANK as 'off' | 'shadow' | 'on') ?? 'off',
    compression: (process.env.F163_COMPRESSION as 'off' | 'suggest' | 'apply') ?? 'off',
    promotionGate: (process.env.F163_PROMOTION_GATE as 'off' | 'suggest' | 'apply') ?? 'off',
    contradictionDetection: (process.env.F163_CONTRADICTION_DETECTION as 'off' | 'suggest' | 'apply') ?? 'off',
    reviewQueue: (process.env.F163_REVIEW_QUEUE as 'off' | 'suggest' | 'apply') ?? 'off',
  });
}

/** Deterministic variant ID from frozen flag snapshot — SHA-256, 12 hex chars */
export function computeVariantId(flags: F163FlagSnapshot): string {
  const sorted = Object.entries(flags).sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 12);
}

/** Phase D: derive authority from doc path — no manual promotion needed */
export function pathToAuthority(sourcePath: string): F163Authority {
  const p = sourcePath.replace(/^doc:/, '').replace(/^docs\//, '');
  if (/^(lessons-learned|SOP)\.md$/i.test(p) || /shared-rules\.md$/i.test(p)) return 'constitutional';
  if (/^(decisions|features)\//i.test(p)) return 'validated';
  if (/^(discussions|plans|research|reflections)\//i.test(p)) return 'candidate';
  return 'observed';
}

/** Phase D (kept for backward compat, but no longer used in search route) */
export function authorityToConfidence(authority: F163Authority | undefined): 'high' | 'mid' | 'low' {
  switch (authority) {
    case 'constitutional':
    case 'validated':
      return 'high';
    case 'candidate':
      return 'mid';
    case 'observed':
      return 'low';
    default:
      return 'mid';
  }
}

/** Phase E: confidence = f(rank) — reflects search match quality, not document authority */
export function rankToConfidence(rank: number): 'high' | 'mid' | 'low' {
  if (rank <= 1) return 'high';
  if (rank <= 4) return 'mid';
  return 'low';
}

// ── Phase F: Task-scoped Salience Gating ────────────────────────────

export interface SalienceTaskContext {
  activeFeatureIds: string[];
  truthSourceRef: string | null;
  recentArtifactRefs: string[];
}

interface SalienceDoc {
  anchor: string;
  authority?: F163Authority;
  activation?: F163Activation;
  keywords?: string[];
}

/** Phase F: task-scoped salience — 0.0 (irrelevant) to 1.0 (fully relevant / exempt) */
export function salience(doc: SalienceDoc, ctx: SalienceTaskContext): number {
  if (doc.activation === 'always_on') return 1.0;
  const truthRef = ctx.truthSourceRef?.trim() || null;
  const hasCtx = ctx.activeFeatureIds.length > 0 || truthRef != null || ctx.recentArtifactRefs.length > 0;
  if (!hasCtx) return 1.0;

  let score = 0.2;
  const anchor = doc.anchor.toLowerCase();
  const kws = (doc.keywords ?? []).map((k) => k.toLowerCase());

  for (const fid of ctx.activeFeatureIds) {
    const f = fid.toLowerCase();
    if (anchor.includes(f) || kws.some((k) => k.includes(f))) {
      score += 0.4;
      break;
    }
  }

  if (truthRef) {
    const ref = truthRef.toLowerCase();
    if (anchor === ref || anchor.includes(ref) || ref.includes(anchor)) {
      score += 0.25;
    }
  }

  for (const ref of ctx.recentArtifactRefs) {
    const r = ref.toLowerCase();
    if (anchor.includes(r) || r.includes(anchor)) {
      score += 0.15;
      break;
    }
  }

  if (doc.authority === 'constitutional' || doc.authority === 'validated') {
    score += 0.05;
  }

  return Math.min(score, 1.0);
}

/** Phase F: rerank items by salience score. Stable sort — equal scores preserve input order. */
export function applySalienceRerank<T extends SalienceDoc>(
  items: T[],
  ctx: SalienceTaskContext,
): { items: T[]; scores: number[] } {
  const indexed = items.map((item, i) => ({ item, score: salience(item, ctx), i }));
  indexed.sort((a, b) => b.score - a.score || a.i - b.i);
  return {
    items: indexed.map((e) => e.item),
    scores: indexed.map((e) => e.score),
  };
}

/**
 * Cohort sticky routing: assigns a thread to a variant on first encounter,
 * then returns the same variant on subsequent requests regardless of flag changes.
 */
export function getOrAssignCohort(db: Database.Database, threadId: string, currentVariantId: string): string {
  const existing = db.prepare('SELECT variant_id FROM f163_cohorts WHERE thread_id = ?').get(threadId) as
    | { variant_id: string }
    | undefined;
  if (existing) return existing.variant_id;

  db.prepare('INSERT INTO f163_cohorts (thread_id, variant_id, assigned_at) VALUES (?, ?, ?)').run(
    threadId,
    currentVariantId,
    new Date().toISOString(),
  );
  return currentVariantId;
}
