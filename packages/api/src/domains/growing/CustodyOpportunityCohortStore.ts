import { createHash } from 'node:crypto';
import type { CustodyOpportunityCohortSnapshotV1 } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';

const DAY = 86_400_000;
export const CUSTODY_SILENCE_DELAY_MS = 3_600_000;
export const CUSTODY_OUTCOME_DELAY_MS = 7 * DAY;

export interface CustodyOpportunityCohort {
  readonly cohortRef: string;
  readonly ownerUserId: string;
  readonly policyVersion: string;
  readonly startedAt: number;
  readonly reviewAt: number;
  readonly samplingPolicy: 'sha256-10-percent-plus-time-signal-v1';
}

export interface CustodyOpportunityRead {
  readonly cohort: CustodyOpportunityCohort;
  readonly capturedAt: number;
  readonly observationCutoff: number;
  readonly reviewSnapshotRef: string | null;
  readonly coverageGaps: readonly { readonly sourceRef: string; readonly reason: string }[];
  readonly measurement: CustodyOpportunityCohortSnapshotV1;
  readonly readiness: 'collecting' | 'needs_calibration' | 'insufficient_evidence';
  readonly actionability: 'requires_independent_calibration_and_cvo_outcome';
}

interface CohortRow {
  cohort_json: string;
  review_snapshot_ref: string | null;
}
interface SnapshotRow {
  snapshot_ref: string;
  snapshot_json: string;
}

/** Only prospective registration and immutable refs-only measurement receipts. No product lifecycle writes. */
export class CustodyOpportunityCohortStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS f310_custody_cohorts (
        cohort_ref TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, policy_version TEXT NOT NULL,
        cohort_json TEXT NOT NULL, review_snapshot_ref TEXT,
        UNIQUE(owner_user_id, policy_version)
      );
      CREATE TABLE IF NOT EXISTS f310_custody_cohort_snapshots (
        snapshot_ref TEXT PRIMARY KEY, cohort_ref TEXT NOT NULL, owner_user_id TEXT NOT NULL,
        snapshot_json TEXT NOT NULL
      );
    `);
  }

  ensure(ownerUserId: string, policyVersion: string, startedAt: number): CustodyOpportunityCohort {
    const cohortRef = `f310_cohort_${digest([ownerUserId, policyVersion])}`;
    const cohort: CustodyOpportunityCohort = {
      cohortRef,
      ownerUserId,
      policyVersion,
      startedAt,
      reviewAt: startedAt + 30 * DAY,
      samplingPolicy: 'sha256-10-percent-plus-time-signal-v1',
    };
    this.db
      .prepare(`INSERT OR IGNORE INTO f310_custody_cohorts
      (cohort_ref, owner_user_id, policy_version, cohort_json) VALUES (?, ?, ?, ?)`)
      .run(cohortRef, ownerUserId, policyVersion, JSON.stringify(cohort));
    const row = this.db
      .prepare('SELECT cohort_json FROM f310_custody_cohorts WHERE cohort_ref = ?')
      .get(cohortRef) as CohortRow;
    return JSON.parse(row.cohort_json) as CustodyOpportunityCohort;
  }

  save(snapshot: CustodyOpportunityRead): string {
    const body = JSON.stringify(snapshot);
    const ref = `f310_snapshot_${digest([body])}`;
    this.db
      .prepare(`INSERT OR IGNORE INTO f310_custody_cohort_snapshots
      (snapshot_ref, cohort_ref, owner_user_id, snapshot_json) VALUES (?, ?, ?, ?)`)
      .run(ref, snapshot.cohort.cohortRef, snapshot.cohort.ownerUserId, body);
    return ref;
  }

  captureReviewOnce(snapshot: CustodyOpportunityRead): string {
    return this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT review_snapshot_ref FROM f310_custody_cohorts WHERE cohort_ref = ?')
        .get(snapshot.cohort.cohortRef) as CohortRow;
      if (row.review_snapshot_ref) return row.review_snapshot_ref;
      const ref = this.save(snapshot);
      this.db
        .prepare('UPDATE f310_custody_cohorts SET review_snapshot_ref = ? WHERE cohort_ref = ?')
        .run(ref, snapshot.cohort.cohortRef);
      return ref;
    })();
  }

  readSnapshot(ownerUserId: string, snapshotRef: string): CustodyOpportunityRead | null {
    const row = this.db
      .prepare('SELECT snapshot_json FROM f310_custody_cohort_snapshots WHERE snapshot_ref = ? AND owner_user_id = ?')
      .get(snapshotRef, ownerUserId) as SnapshotRow | undefined;
    return row ? (JSON.parse(row.snapshot_json) as CustodyOpportunityRead) : null;
  }

  reviewRef(cohortRef: string): string | null {
    const row = this.db
      .prepare('SELECT review_snapshot_ref FROM f310_custody_cohorts WHERE cohort_ref = ?')
      .get(cohortRef) as CohortRow | undefined;
    return row?.review_snapshot_ref ?? null;
  }
}

export function custodyOpportunitySample(sourceRef: string, policyVersion: string): boolean {
  return Number.parseInt(digest([sourceRef, policyVersion]).slice(0, 8), 16) % 10 === 0;
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}
