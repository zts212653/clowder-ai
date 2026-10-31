import type Database from 'better-sqlite3';

interface MigrationDetail {
  anchor: string;
  kind: string;
  sourcePath: string | null;
  authority: string | null;
  currentStatus: string | null;
  newStatus: 'trusted_legacy' | 'needs_review' | null;
}

export interface VerificationMigrationReport {
  total: number;
  trustedLegacy: number;
  needsReview: number;
  observedNull: number;
  alreadyVerified: number;
  details: MigrationDetail[];
}

const TRUSTED_WHITELIST: Array<{ kind: string; pathPatterns: RegExp[] }> = [
  { kind: 'lesson', pathPatterns: [/\blessons\//i, /lessons-learned\.md$/i] },
  { kind: 'feature', pathPatterns: [/\bfeatures\//i] },
  { kind: 'decision', pathPatterns: [/\bdecisions\//i] },
];

function matchesTrustedWhitelist(kind: string, sourcePath: string | null): boolean {
  if (!sourcePath) return false;
  const entry = TRUSTED_WHITELIST.find((w) => w.kind === kind);
  if (!entry) return false;
  return entry.pathPatterns.some((p) => p.test(sourcePath));
}

export function dryRunVerificationMigration(db: Database.Database): VerificationMigrationReport {
  const rows = db
    .prepare(
      `SELECT anchor, kind, source_path, authority, review_status, verified_at
       FROM evidence_docs`,
    )
    .all() as Array<{
    anchor: string;
    kind: string;
    source_path: string | null;
    authority: string | null;
    review_status: string | null;
    verified_at: string | null;
  }>;

  let trustedLegacy = 0;
  let needsReview = 0;
  let observedNull = 0;
  let alreadyVerified = 0;
  const details: MigrationDetail[] = [];

  for (const row of rows) {
    if (row.review_status != null || row.verified_at) {
      alreadyVerified++;
      details.push({
        anchor: row.anchor,
        kind: row.kind,
        sourcePath: row.source_path,
        authority: row.authority,
        currentStatus: row.review_status,
        newStatus: null,
      });
      continue;
    }

    if (row.authority === 'observed') {
      observedNull++;
      details.push({
        anchor: row.anchor,
        kind: row.kind,
        sourcePath: row.source_path,
        authority: row.authority,
        currentStatus: row.review_status,
        newStatus: null,
      });
      continue;
    }

    if (matchesTrustedWhitelist(row.kind, row.source_path)) {
      trustedLegacy++;
      details.push({
        anchor: row.anchor,
        kind: row.kind,
        sourcePath: row.source_path,
        authority: row.authority,
        currentStatus: row.review_status,
        newStatus: 'trusted_legacy',
      });
    } else {
      needsReview++;
      details.push({
        anchor: row.anchor,
        kind: row.kind,
        sourcePath: row.source_path,
        authority: row.authority,
        currentStatus: row.review_status,
        newStatus: 'needs_review',
      });
    }
  }

  return {
    total: rows.length,
    trustedLegacy,
    needsReview,
    observedNull,
    alreadyVerified,
    details,
  };
}

export function applyVerificationMigration(db: Database.Database): VerificationMigrationReport {
  const report = dryRunVerificationMigration(db);

  const updateStmt = db.prepare('UPDATE evidence_docs SET review_status = ? WHERE anchor = ?');

  const txn = db.transaction(() => {
    for (const d of report.details) {
      if (d.newStatus) {
        updateStmt.run(d.newStatus, d.anchor);
      }
    }
  });
  txn();

  return report;
}
