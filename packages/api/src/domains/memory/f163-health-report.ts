/**
 * F163 Phase C (AC-C4): Harness health report — aggregated knowledge quality metrics.
 */

import type Database from 'better-sqlite3';

export interface HarnessHealthReport {
  totalDocs: number;
  byKind: Record<string, number>;
  byAuthority: Record<string, number>;
  contradictions: { total: number; unresolved: number };
  staleReview: { warning: number; overdue: number };
  unverified: number;
  backstopRatio: number;
  compressionRatio: number;
  generatedAt: string;
}

export function generateHealthReport(db: Database.Database, opts?: { now?: string }): HarnessHealthReport {
  const nowValue = opts?.now ?? new Date().toISOString();

  const totalDocs = (db.prepare('SELECT COUNT(*) as c FROM evidence_docs').get() as { c: number }).c;

  const kindRows = db.prepare('SELECT kind, COUNT(*) as c FROM evidence_docs GROUP BY kind').all() as Array<{
    kind: string;
    c: number;
  }>;
  const byKind: Record<string, number> = {};
  for (const r of kindRows) byKind[r.kind] = r.c;

  const authRows = db
    .prepare("SELECT COALESCE(authority, 'observed') as auth, COUNT(*) as c FROM evidence_docs GROUP BY auth")
    .all() as Array<{ auth: string; c: number }>;
  const byAuthority: Record<string, number> = {};
  for (const r of authRows) byAuthority[r.auth] = r.c;

  const contradictionTotal = (
    db.prepare('SELECT COUNT(*) as c FROM evidence_docs WHERE contradicts IS NOT NULL').get() as {
      c: number;
    }
  ).c;
  const contradictionUnresolved = (
    db
      .prepare("SELECT COUNT(*) as c FROM evidence_docs WHERE contradicts IS NOT NULL AND status != 'invalidated'")
      .get() as { c: number }
  ).c;

  const staleWarning = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM evidence_docs
       WHERE status = 'active' AND verified_at IS NOT NULL AND review_cycle_days IS NOT NULL
         AND julianday(?) - julianday(verified_at) > review_cycle_days * 0.8
         AND julianday(?) - julianday(verified_at) < review_cycle_days`,
      )
      .get(nowValue, nowValue) as { c: number }
  ).c;
  const staleOverdue = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM evidence_docs
       WHERE status = 'active' AND verified_at IS NOT NULL AND review_cycle_days IS NOT NULL
         AND julianday(?) - julianday(verified_at) >= review_cycle_days`,
      )
      .get(nowValue) as { c: number }
  ).c;

  const unverified = (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM evidence_docs WHERE verified_at IS NULL AND COALESCE(authority, 'observed') != 'observed'",
      )
      .get() as { c: number }
  ).c;

  const backstopCount = (
    db.prepare("SELECT COUNT(*) as c FROM evidence_docs WHERE activation = 'backstop'").get() as { c: number }
  ).c;
  const backstopRatio = totalDocs > 0 ? backstopCount / totalDocs : 0;

  const summaryCount = (
    db.prepare('SELECT COUNT(*) as c FROM evidence_docs WHERE summary_of_anchor IS NOT NULL').get() as { c: number }
  ).c;
  const compressionRatio = totalDocs > 0 ? summaryCount / totalDocs : 0;

  return {
    totalDocs,
    byKind,
    byAuthority,
    contradictions: { total: contradictionTotal, unresolved: contradictionUnresolved },
    staleReview: { warning: staleWarning, overdue: staleOverdue },
    unverified,
    backstopRatio: Math.round(backstopRatio * 1000) / 1000,
    compressionRatio: Math.round(compressionRatio * 1000) / 1000,
    generatedAt: new Date().toISOString(),
  };
}
