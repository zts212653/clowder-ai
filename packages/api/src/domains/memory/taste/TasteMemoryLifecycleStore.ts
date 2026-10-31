import type { MemoryLifecycleStatus, TasteMemoryOwnerAction, TasteTakeawayCandidate } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import { validTasteSourcePath } from './taste-memory-identity.js';
import {
  type TasteEvidenceRow,
  type TasteLifecycleRow,
  type TasteOwnerActionEvidence,
  tasteCandidateRevision,
  tasteOwnerCommandDigest,
} from './taste-memory-lifecycle-records.js';

export type { TasteOwnerActionEvidence } from './taste-memory-lifecycle-records.js';

export class TasteMemoryLifecycleStore {
  private readonly now: () => number;

  constructor(
    private readonly db: Database.Database,
    now: () => number = Date.now,
  ) {
    this.now = now;
  }

  commandDigest(command: TasteMemoryOwnerAction): string {
    return tasteOwnerCommandDigest(command);
  }

  sourcePathForMemoryId(ownerUserId: string, memoryId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT source_path FROM taste_memory_lifecycle
         WHERE owner_user_id = ? AND memory_id = ? LIMIT 1`,
      )
      .get(ownerUserId, memoryId) as { source_path: string } | undefined;
    return row?.source_path ?? null;
  }

  lifecycleStatus(
    ownerUserId: string,
    sourcePath: string,
    revision: string,
    fileStatus: MemoryLifecycleStatus,
  ): MemoryLifecycleStatus | null {
    const row = this.readLifecycle(ownerUserId, sourcePath);
    if (!row) return fileStatus;
    if (row.status === 'forgotten' || row.status === 'mutating') return null;
    if (row.projected_revision && row.projected_revision !== revision) return null;
    return row.status;
  }

  isReadable(ownerUserId: string, sourcePath: string, revision: string, includeRetired = false): boolean {
    const status = this.lifecycleStatus(ownerUserId, sourcePath, revision, 'active');
    return status === 'active' || (includeRetired && status === 'retired');
  }

  importCandidate(input: {
    ownerUserId: string;
    sourcePath: string;
    sourceRevision: string;
    takeaway: string;
    sourceRef: string;
  }): TasteTakeawayCandidate | null {
    if (!validTasteSourcePath(input.sourcePath) || !input.takeaway.trim()) return null;
    if (this.readLifecycle(input.ownerUserId, input.sourcePath)?.status === 'forgotten') return null;
    const candidateRevision = tasteCandidateRevision(input);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO taste_takeaway_candidates
           (owner_user_id, source_path, based_on_revision, candidate_revision, takeaway,
            status, source_ref, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL)`,
      )
      .run(
        input.ownerUserId,
        input.sourcePath,
        input.sourceRevision,
        candidateRevision,
        input.takeaway.trim(),
        input.sourceRef,
        new Date(this.now()).toISOString(),
      );
    return {
      status: 'pending_owner_confirmation',
      takeaway: input.takeaway.trim(),
      basedOnRevision: input.sourceRevision,
      candidateRevision,
    };
  }

  candidateFor(ownerUserId: string, sourcePath: string, currentRevision: string): TasteTakeawayCandidate | null {
    const row = this.db
      .prepare(
        `SELECT takeaway, based_on_revision, candidate_revision
         FROM taste_takeaway_candidates
         WHERE owner_user_id = ? AND source_path = ? AND based_on_revision = ? AND status = 'pending'
         ORDER BY created_at DESC, candidate_revision DESC LIMIT 1`,
      )
      .get(ownerUserId, sourcePath, currentRevision) as
      | { takeaway: string; based_on_revision: string; candidate_revision: string }
      | undefined;
    return row
      ? {
          status: 'pending_owner_confirmation',
          takeaway: row.takeaway,
          basedOnRevision: row.based_on_revision,
          candidateRevision: row.candidate_revision,
        }
      : null;
  }

  prepareAction(input: {
    ownerUserId: string;
    sourcePath: string;
    memoryId: string;
    command: TasteMemoryOwnerAction;
    currentStatus: MemoryLifecycleStatus;
    currentRevision: string;
  }):
    | TasteOwnerActionEvidence
    | { error: 'idempotency_conflict' | 'not_available' | 'stale_revision' | 'mutation_unavailable' } {
    const commandDigest = this.commandDigest(input.command);
    const existing = this.getOwnerActionEvidence(input.ownerUserId, input.sourcePath, input.command.requestId);
    if (existing) {
      return existing.commandDigest === commandDigest ? existing : { error: 'idempotency_conflict' };
    }
    const previous = this.readLifecycle(input.ownerUserId, input.sourcePath);
    if (previous?.status === 'forgotten') return { error: 'not_available' };
    if (previous?.status === 'mutating') return { error: 'mutation_unavailable' };
    if (previous?.projected_revision && previous.projected_revision !== input.currentRevision) {
      return { error: 'stale_revision' };
    }
    if (previous?.status === 'retired' && input.command.action !== 'hard_forget') {
      return { error: 'not_available' };
    }
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO taste_memory_owner_action_evidence
             (owner_user_id, source_path, memory_id, request_id, action, command_digest,
              expected_revision, target_revision, result_status, previous_row_exists,
              previous_status, previous_revision, prepared_at, applied_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL)`,
        )
        .run(
          input.ownerUserId,
          input.sourcePath,
          input.memoryId,
          input.command.requestId,
          input.command.action,
          commandDigest,
          input.command.expectedRevision,
          previous ? 1 : 0,
          previous?.status ?? null,
          previous?.projected_revision ?? null,
          new Date(this.now()).toISOString(),
        );
      this.db
        .prepare(
          `INSERT INTO taste_memory_lifecycle
             (owner_user_id, source_path, memory_id, status, projected_revision, last_request_id, updated_at)
           VALUES (?, ?, ?, 'mutating', ?, ?, ?)
           ON CONFLICT(owner_user_id, source_path) DO UPDATE SET
             memory_id = excluded.memory_id,
             status = 'mutating',
             projected_revision = excluded.projected_revision,
             last_request_id = excluded.last_request_id,
             updated_at = excluded.updated_at`,
        )
        .run(
          input.ownerUserId,
          input.sourcePath,
          input.memoryId,
          input.currentRevision,
          input.command.requestId,
          new Date(this.now()).toISOString(),
        );
    })();
    return { action: input.command.action, commandDigest, applied: false };
  }

  recordTargetRevision(input: {
    ownerUserId: string;
    sourcePath: string;
    requestId: string;
    commandDigest: string;
    targetRevision: string | null;
  }): void {
    const result = this.db
      .prepare(
        `UPDATE taste_memory_owner_action_evidence SET target_revision = ?
         WHERE owner_user_id = ? AND source_path = ? AND request_id = ?
           AND command_digest = ? AND applied_at IS NULL`,
      )
      .run(input.targetRevision, input.ownerUserId, input.sourcePath, input.requestId, input.commandDigest);
    if (result.changes !== 1) throw new Error('Taste action target revision lost its request fence');
  }

  completeAction(input: {
    ownerUserId: string;
    sourcePath: string;
    memoryId: string;
    command: TasteMemoryOwnerAction;
    resultRevision: string | null;
    resultStatus: MemoryLifecycleStatus | 'forgotten';
  }): void {
    const commandDigest = this.commandDigest(input.command);
    const now = new Date(this.now()).toISOString();
    this.db.transaction(() => {
      const evidence = this.db
        .prepare(
          `UPDATE taste_memory_owner_action_evidence
           SET target_revision = ?, result_status = ?, applied_at = ?
           WHERE owner_user_id = ? AND source_path = ? AND request_id = ?
             AND command_digest = ? AND applied_at IS NULL`,
        )
        .run(
          input.resultRevision,
          input.resultStatus,
          now,
          input.ownerUserId,
          input.sourcePath,
          input.command.requestId,
          commandDigest,
        );
      if (evidence.changes !== 1) throw new Error('Taste action evidence lost its request fence');
      this.db
        .prepare(
          `UPDATE taste_memory_lifecycle
           SET status = ?, projected_revision = ?, last_request_id = ?, updated_at = ?
           WHERE owner_user_id = ? AND source_path = ? AND memory_id = ?`,
        )
        .run(
          input.resultStatus,
          input.resultRevision,
          input.command.requestId,
          now,
          input.ownerUserId,
          input.sourcePath,
          input.memoryId,
        );
      if (input.command.action === 'confirm_takeaway') {
        this.db
          .prepare(
            `UPDATE taste_takeaway_candidates SET status = 'confirmed', decided_at = ?
             WHERE owner_user_id = ? AND source_path = ? AND candidate_revision = ? AND status = 'pending'`,
          )
          .run(now, input.ownerUserId, input.sourcePath, input.command.candidateRevision);
      }
      if (input.resultRevision) {
        this.db
          .prepare(
            `UPDATE taste_takeaway_candidates SET status = 'stale', decided_at = ?
             WHERE owner_user_id = ? AND source_path = ? AND status = 'pending'
               AND based_on_revision <> ?`,
          )
          .run(now, input.ownerUserId, input.sourcePath, input.resultRevision);
      } else if (input.resultStatus === 'forgotten') {
        this.db
          .prepare(
            `UPDATE taste_takeaway_candidates SET status = 'stale', decided_at = ?
             WHERE owner_user_id = ? AND source_path = ? AND status = 'pending'`,
          )
          .run(now, input.ownerUserId, input.sourcePath);
      }
    })();
  }

  rollbackPrepared(ownerUserId: string, sourcePath: string, requestId: string, commandDigest: string): void {
    const row = this.readEvidenceRow(ownerUserId, sourcePath, requestId);
    if (!row || row.command_digest !== commandDigest || row.applied_at) return;
    this.db.transaction(() => {
      if (row.previous_row_exists) {
        this.db
          .prepare(
            `UPDATE taste_memory_lifecycle SET status = ?, projected_revision = ?, last_request_id = NULL, updated_at = ?
             WHERE owner_user_id = ? AND source_path = ?`,
          )
          .run(row.previous_status, row.previous_revision, new Date(this.now()).toISOString(), ownerUserId, sourcePath);
      } else {
        this.db
          .prepare('DELETE FROM taste_memory_lifecycle WHERE owner_user_id = ? AND source_path = ?')
          .run(ownerUserId, sourcePath);
      }
      this.db
        .prepare(
          `DELETE FROM taste_memory_owner_action_evidence
           WHERE owner_user_id = ? AND source_path = ? AND request_id = ? AND applied_at IS NULL`,
        )
        .run(ownerUserId, sourcePath, requestId);
    })();
  }

  getOwnerActionEvidence(ownerUserId: string, sourcePath: string, requestId: string): TasteOwnerActionEvidence | null {
    const row = this.readEvidenceRow(ownerUserId, sourcePath, requestId);
    if (!row) return null;
    return {
      action: row.action,
      commandDigest: row.command_digest,
      applied: row.applied_at !== null,
      ...(row.target_revision ? { revision: row.target_revision } : {}),
      ...(row.result_status === 'active' || row.result_status === 'retired' ? { status: row.result_status } : {}),
    };
  }

  private readLifecycle(ownerUserId: string, sourcePath: string): TasteLifecycleRow | null {
    return (
      (this.db
        .prepare(
          `SELECT memory_id, status, projected_revision, last_request_id
           FROM taste_memory_lifecycle WHERE owner_user_id = ? AND source_path = ? LIMIT 1`,
        )
        .get(ownerUserId, sourcePath) as TasteLifecycleRow | undefined) ?? null
    );
  }

  private readEvidenceRow(ownerUserId: string, sourcePath: string, requestId: string): TasteEvidenceRow | null {
    return (
      (this.db
        .prepare(
          `SELECT action, command_digest, target_revision, result_status, applied_at,
                  previous_row_exists, previous_status, previous_revision
           FROM taste_memory_owner_action_evidence
           WHERE owner_user_id = ? AND source_path = ? AND request_id = ? LIMIT 1`,
        )
        .get(ownerUserId, sourcePath, requestId) as TasteEvidenceRow | undefined) ?? null
    );
  }
}
