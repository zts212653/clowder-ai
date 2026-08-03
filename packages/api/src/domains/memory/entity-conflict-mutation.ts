import type { EntityConflictContext, EntityConflictResolutionRequest } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import { inspectEntityConflict, isEntityVisibleToUser } from './entity-conflict-resolution.js';
import { EntityRegistryMutationWriter, normalizeEntityAlias } from './entity-registry-mutation.js';
import type { EntityMutationContext, EntityProvenance, EntityRecord, EntityType } from './interfaces.js';

interface EntityRow {
  entity_id: string;
  entity_type: string;
  canonical_name: string;
  provenance_json: string;
  stance: string;
  visibility_scope: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export class EntityConflictStaleError extends Error {
  readonly code = 'ENTITY_CONFLICT_STALE' as const;

  constructor(readonly conflict: EntityConflictContext | null) {
    super('Entity conflict context changed; review the current registry truth and retry');
    this.name = 'EntityConflictStaleError';
  }
}

export class EntityConflictInvalidResolutionError extends Error {
  readonly code = 'ENTITY_CONFLICT_INVALID_RESOLUTION' as const;

  constructor(
    message: string,
    readonly conflict: EntityConflictContext,
  ) {
    super(message);
    this.name = 'EntityConflictInvalidResolutionError';
  }
}

export interface EntityConflictMutationResult {
  changed: boolean;
  affectedEntityIds: string[];
}

export function resolveEntityConflict(
  db: Database.Database,
  incoming: EntityRecord,
  resolution: EntityConflictResolutionRequest,
  context: EntityMutationContext,
): EntityConflictMutationResult {
  return db.transaction(() => {
    const viewerUserId = context.actorId;
    const conflict = inspectEntityConflict(db, incoming, viewerUserId);
    if (!conflict || conflict.fingerprint !== resolution.fingerprint) {
      throw new EntityConflictStaleError(conflict);
    }
    if (!conflict.allowedActions.includes(resolution.action)) {
      throw new EntityConflictInvalidResolutionError(
        `Action ${resolution.action} is not valid for ${conflict.reason}`,
        conflict,
      );
    }

    if (conflict.reason === 'existing-entity-change') {
      return resolveSameEntity(db, incoming, resolution, context, conflict, viewerUserId);
    }
    return resolveSurfaceCollision(db, incoming, resolution, context, conflict, viewerUserId);
  })() as EntityConflictMutationResult;
}

function resolveSameEntity(
  db: Database.Database,
  incoming: EntityRecord,
  resolution: EntityConflictResolutionRequest,
  context: EntityMutationContext,
  conflict: EntityConflictContext,
  viewerUserId?: string,
): EntityConflictMutationResult {
  const current = loadFullEntity(db, incoming.entityId);
  if (!current) throw new EntityConflictStaleError(inspectEntityConflict(db, incoming, viewerUserId));
  const next =
    resolution.action === 'merge-aliases'
      ? mergeEntityRecords(current, incoming)
      : resolution.action === 'replace'
        ? incoming
        : null;
  if (!next) {
    throw new EntityConflictInvalidResolutionError(
      `Action ${resolution.action} cannot resolve a same-entity change`,
      conflict,
    );
  }
  const foreignOwners = findForeignSurfaceOwners(db, next, new Set([incoming.entityId]), viewerUserId);
  if (foreignOwners.visible.length > 0 || foreignOwners.hidden) {
    throw new EntityConflictInvalidResolutionError(
      foreignOwners.hidden
        ? 'Resolution conflicts with an entity outside the current visibility scope'
        : `Resolution would steal surfaces from ${foreignOwners.visible.join(', ')}`,
      conflict,
    );
  }
  return writeEntities(db, [next], context, resolution.action);
}

function resolveSurfaceCollision(
  db: Database.Database,
  incoming: EntityRecord,
  resolution: EntityConflictResolutionRequest,
  context: EntityMutationContext,
  conflict: EntityConflictContext,
  viewerUserId?: string,
): EntityConflictMutationResult {
  if (resolution.action === 'polysemy') {
    return writeEntities(db, [incoming], context, 'polysemy');
  }
  if (resolution.action !== 'correct' && resolution.action !== 'transfer') {
    throw new EntityConflictInvalidResolutionError(
      `Action ${resolution.action} cannot resolve a surface collision`,
      conflict,
    );
  }

  const conflictSurfaces = new Set(conflict.conflictingSurfaces);
  const incomingSurfaces = new Set(surfaceNorms(incoming));
  validateDistinctReplacements(resolution.replacementCanonicalNames, conflict);
  const changedCandidates = conflict.candidates.map((candidate) => {
    const current = loadFullEntity(db, candidate.entityId);
    if (!current) throw new EntityConflictStaleError(inspectEntityConflict(db, incoming, viewerUserId));
    const canonicalCollides = conflictSurfaces.has(normalizeEntityAlias(current.canonicalName));
    const replacement = resolution.replacementCanonicalNames?.[current.entityId]?.trim();
    const canonicalName = canonicalCollides
      ? validateReplacement(db, current, replacement, conflictSurfaces, incomingSurfaces, conflict, viewerUserId)
      : current.canonicalName;
    return {
      ...current,
      canonicalName,
      aliases: current.aliases.filter((alias) => !conflictSurfaces.has(normalizeEntityAlias(alias))),
      updatedAt: incoming.updatedAt,
    };
  });
  const reason = resolution.action === 'correct' ? 'correction' : 'transfer';
  return writeEntities(db, [...changedCandidates, incoming], context, reason);
}

function validateDistinctReplacements(
  replacements: Record<string, string> | undefined,
  conflict: EntityConflictContext,
): void {
  const ownerBySurface = new Map<string, string>();
  for (const entityId of conflict.canonicalReplacementRequiredFor) {
    const normalized = normalizeEntityAlias(replacements?.[entityId] ?? '');
    if (!normalized) continue;
    const owner = ownerBySurface.get(normalized);
    if (owner) {
      throw new EntityConflictInvalidResolutionError(
        `Replacement canonical name is shared by ${owner} and ${entityId}`,
        conflict,
      );
    }
    ownerBySurface.set(normalized, entityId);
  }
}

function validateReplacement(
  db: Database.Database,
  current: EntityRecord,
  replacement: string | undefined,
  conflictSurfaces: Set<string>,
  incomingSurfaces: Set<string>,
  conflict: EntityConflictContext,
  viewerUserId?: string,
): string {
  const canonicalName = replacement?.trim();
  const normalized = normalizeEntityAlias(canonicalName ?? '');
  if (!canonicalName || !normalized) {
    throw new EntityConflictInvalidResolutionError(
      `Replacement canonical name is required for ${current.entityId}`,
      conflict,
    );
  }
  if (conflictSurfaces.has(normalized) || incomingSurfaces.has(normalized)) {
    throw new EntityConflictInvalidResolutionError(
      `Replacement canonical name for ${current.entityId} still collides with the incoming entity`,
      conflict,
    );
  }
  const owners = findForeignSurfaceOwners(
    db,
    { canonicalName, aliases: [] },
    new Set([current.entityId]),
    viewerUserId,
  );
  if (owners.visible.length > 0 || owners.hidden) {
    throw new EntityConflictInvalidResolutionError(
      owners.hidden
        ? `Replacement canonical name for ${current.entityId} conflicts outside the current visibility scope`
        : `Replacement canonical name for ${current.entityId} belongs to ${owners.visible.join(', ')}`,
      conflict,
    );
  }
  return canonicalName;
}

function mergeEntityRecords(current: EntityRecord, incoming: EntityRecord): EntityRecord {
  const canonicalAlias =
    normalizeEntityAlias(current.canonicalName) === normalizeEntityAlias(incoming.canonicalName)
      ? []
      : [incoming.canonicalName];
  return {
    ...current,
    aliases: uniqueSurfaces([...current.aliases, ...incoming.aliases, ...canonicalAlias]),
    provenance: uniqueProvenance([...current.provenance, ...incoming.provenance]),
    updatedAt: incoming.updatedAt,
  };
}

function findForeignSurfaceOwners(
  db: Database.Database,
  entity: Pick<EntityRecord, 'canonicalName' | 'aliases'>,
  excludedEntityIds: Set<string>,
  viewerUserId?: string,
): { visible: string[]; hidden: boolean } {
  const target = new Set(surfaceNorms(entity));
  const rows = db.prepare("SELECT * FROM entity_registry WHERE status = 'active'").all() as EntityRow[];
  const owners = rows
    .filter((row) => !excludedEntityIds.has(row.entity_id))
    .flatMap((row) => {
      const current = loadFullEntity(db, row.entity_id);
      return current && surfaceNorms(current).some((surface) => target.has(surface)) ? [row] : [];
    });
  return {
    visible: [
      ...new Set(
        owners.filter((row) => isEntityVisibleToUser(row.visibility_scope, viewerUserId)).map((row) => row.entity_id),
      ),
    ].sort(),
    hidden: owners.some((row) => !isEntityVisibleToUser(row.visibility_scope, viewerUserId)),
  };
}

function loadFullEntity(db: Database.Database, entityId: string): EntityRecord | null {
  const row = db.prepare('SELECT * FROM entity_registry WHERE entity_id = ?').get(entityId) as EntityRow | undefined;
  if (!row) return null;
  const aliases = db
    .prepare('SELECT alias FROM entity_aliases WHERE entity_id = ? ORDER BY alias')
    .all(entityId) as Array<{ alias: string }>;
  return {
    entityId: row.entity_id,
    type: row.entity_type as EntityType,
    canonicalName: row.canonical_name,
    aliases: aliases.map(({ alias }) => alias),
    provenance: parseProvenance(row.provenance_json),
    stance: row.stance,
    visibilityScope: row.visibility_scope,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function writeEntities(
  db: Database.Database,
  entities: EntityRecord[],
  context: EntityMutationContext,
  reason: string,
): EntityConflictMutationResult {
  const changed = new EntityRegistryMutationWriter(db).upsert(entities, {
    source: context.source,
    actorId: context.actorId,
    proposalId: context.proposalId,
    reason: `conflict-resolution:${reason}`,
  });
  return {
    changed,
    affectedEntityIds: changed ? [...new Set(entities.map(({ entityId }) => entityId))] : [],
  };
}

function surfaceNorms(entity: Pick<EntityRecord, 'canonicalName' | 'aliases'>): string[] {
  return [...new Set([entity.canonicalName, ...entity.aliases].map(normalizeEntityAlias).filter(Boolean))];
}

function uniqueSurfaces(surfaces: string[]): string[] {
  const byNorm = new Map<string, string>();
  for (const surface of surfaces) {
    const normalized = normalizeEntityAlias(surface);
    if (normalized && !byNorm.has(normalized)) byNorm.set(normalized, surface);
  }
  return [...byNorm.values()];
}

function uniqueProvenance(provenance: EntityProvenance[]): EntityProvenance[] {
  const seen = new Set<string>();
  return provenance.filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseProvenance(raw: string): EntityProvenance[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? (value as EntityProvenance[]) : [];
  } catch {
    return [];
  }
}
