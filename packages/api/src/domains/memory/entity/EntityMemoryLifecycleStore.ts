import type { EntityMemoryCorrectionPatch } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import { EntityRegistryStore, entitySourceRevision, type StoredEntityRecord } from '../EntityRegistry.js';

export type EntityMemoryMutationResult =
  | { outcome: 'applied'; entity: StoredEntityRecord }
  | { outcome: 'forgotten' }
  | { outcome: 'not_available' | 'stale_revision' };

export interface EntityMemoryOwnerActionEvidence {
  action: 'correct' | 'retire' | 'hard_forget';
  revision?: string;
  status?: 'active' | 'retired';
}

export class EntityMemoryLifecycleStore {
  private readonly registry: EntityRegistryStore;

  constructor(private readonly db: Database.Database) {
    this.registry = new EntityRegistryStore(db);
  }

  get(entityId: string): StoredEntityRecord | null {
    return this.registry.get(entityId);
  }

  list(): StoredEntityRecord[] {
    const ids = this.db
      .prepare('SELECT entity_id FROM entity_registry ORDER BY updated_at DESC, entity_id')
      .all() as Array<{ entity_id: string }>;
    return ids.flatMap(({ entity_id }) => {
      const entity = this.registry.get(entity_id);
      return entity ? [entity] : [];
    });
  }

  correct(input: {
    ownerUserId: string;
    entityId: string;
    expectedRevision: string;
    requestId: string;
    patch: EntityMemoryCorrectionPatch;
    updatedAt: number;
  }): EntityMemoryMutationResult {
    return this.mutateAtRevision(input, (current) => {
      const next: StoredEntityRecord = {
        ...current,
        type: input.patch.entityType ?? current.type,
        canonicalName: input.patch.canonicalName ?? current.canonicalName,
        aliases: input.patch.aliases ?? current.aliases,
        stance: input.patch.stance ?? current.stance,
        visibilityScope: input.patch.visibilityScope ?? current.visibilityScope,
        updatedAt: nextIsoTimestamp(current.updatedAt, input.updatedAt),
      };
      this.registry.upsert([next], {
        source: 'owner-action',
        actorId: input.ownerUserId,
        reason: `owner correction ${input.requestId}`,
        conflictPolicy: 'owner-correction',
      });
      this.registry.refreshMentionsForEntities([input.entityId]);
      this.recordEvidence(input, 'correct', next);
      return { outcome: 'applied', entity: next };
    });
  }

  retire(input: {
    ownerUserId: string;
    entityId: string;
    expectedRevision: string;
    requestId: string;
    updatedAt: number;
  }): EntityMemoryMutationResult {
    return this.mutateAtRevision(input, (current) => {
      if (current.status !== 'active') return { outcome: 'not_available' };
      const next: StoredEntityRecord = {
        ...current,
        status: 'retired',
        updatedAt: nextIsoTimestamp(current.updatedAt, input.updatedAt),
      };
      this.registry.upsert([next], {
        source: 'owner-action',
        actorId: input.ownerUserId,
        reason: `owner retirement ${input.requestId}`,
        conflictPolicy: 'allow-update',
      });
      this.registry.refreshMentionsForEntities([input.entityId]);
      this.recordEvidence(input, 'retire', next);
      return { outcome: 'applied', entity: next };
    });
  }

  hardForget(input: {
    ownerUserId: string;
    entityId: string;
    expectedRevision: string;
    requestId: string;
    updatedAt: number;
  }): EntityMemoryMutationResult {
    return this.mutateAtRevision(input, () => {
      const forgottenAt = new Date(input.updatedAt).toISOString();
      this.db
        .prepare(
          `INSERT OR REPLACE INTO entity_memory_forget_tombstones
             (entity_id, owner_user_id, forgotten_at)
           VALUES (?, ?, ?)`,
        )
        .run(input.entityId, input.ownerUserId, forgottenAt);
      this.db.prepare('DELETE FROM entity_registry WHERE entity_id = ?').run(input.entityId);
      this.recordEvidence(input, 'hard_forget');
      return { outcome: 'forgotten' };
    });
  }

  getOwnerActionEvidence(
    entityId: string,
    ownerUserId: string,
    requestId: string,
  ): EntityMemoryOwnerActionEvidence | null {
    const row = this.db
      .prepare(
        `SELECT action, result_revision, result_status
         FROM entity_memory_owner_action_evidence
         WHERE entity_id = ? AND owner_user_id = ? AND request_id = ? LIMIT 1`,
      )
      .get(entityId, ownerUserId, requestId) as
      | {
          action: EntityMemoryOwnerActionEvidence['action'];
          result_revision: string | null;
          result_status: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      action: row.action,
      ...(row.result_revision ? { revision: row.result_revision } : {}),
      ...(row.result_status ? { status: row.result_status as 'active' | 'retired' } : {}),
    };
  }

  private mutateAtRevision(
    input: { entityId: string; expectedRevision: string },
    mutation: (current: StoredEntityRecord) => EntityMemoryMutationResult,
  ): EntityMemoryMutationResult {
    return this.db.transaction(() => {
      const current = this.registry.get(input.entityId);
      if (!current) return { outcome: 'not_available' };
      if (entitySourceRevision(current) !== input.expectedRevision) return { outcome: 'stale_revision' };
      return mutation(current);
    })() as EntityMemoryMutationResult;
  }

  private recordEvidence(
    input: { entityId: string; ownerUserId: string; requestId: string; updatedAt: number },
    action: EntityMemoryOwnerActionEvidence['action'],
    entity?: StoredEntityRecord,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO entity_memory_owner_action_evidence
           (owner_user_id, entity_id, request_id, action, result_revision, result_status, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.ownerUserId,
        input.entityId,
        input.requestId,
        action,
        entity ? entitySourceRevision(entity) : null,
        entity?.status ?? null,
        new Date(input.updatedAt).toISOString(),
      );
  }
}

function nextIsoTimestamp(current: string, requestedAt: number): string {
  const currentMs = Date.parse(current);
  const nextMs = Number.isFinite(currentMs) ? Math.max(requestedAt, currentMs + 1) : requestedAt;
  return new Date(nextMs).toISOString();
}
