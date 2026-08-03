import type Database from 'better-sqlite3';
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

interface ExistingAliasRow {
  alias: string;
  alias_norm: string;
}

interface StoredEntityRecord extends EntityRecord {
  stance: string;
  visibilityScope: string;
  status: string;
  createdAt: string;
}

interface MutationStatements {
  entity: Database.Statement;
  existingEntity: Database.Statement;
  existingAliases: Database.Statement;
  deleteAliases: Database.Statement;
  alias: Database.Statement;
  activeEntities: Database.Statement;
  activeAliases: Database.Statement;
  revision: Database.Statement;
}

export type EntitySurfaceConflictReason = 'existing-entity-change' | 'surface-collision';

export interface EntitySurfaceConflictDetails {
  incomingEntityId: string;
  conflictingEntityIds: string[];
  conflictingSurfaces: string[];
  reason: EntitySurfaceConflictReason;
}

export class EntitySurfaceConflictError extends Error {
  readonly code = 'ENTITY_SURFACE_CONFLICT' as const;
  readonly incomingEntityId: string;
  readonly conflictingEntityIds: string[];
  readonly conflictingSurfaces: string[];
  readonly reason: EntitySurfaceConflictReason;

  constructor(details: EntitySurfaceConflictDetails) {
    super(`Entity ${details.incomingEntityId} conflicts with current workspace registry truth`);
    this.name = 'EntitySurfaceConflictError';
    this.incomingEntityId = details.incomingEntityId;
    this.conflictingEntityIds = [...details.conflictingEntityIds].sort();
    this.conflictingSurfaces = [...details.conflictingSurfaces].sort();
    this.reason = details.reason;
  }
}

export function normalizeEntityAlias(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export class EntityRegistryMutationWriter {
  constructor(private readonly db: Database.Database) {}

  upsert(entities: EntityRecord[], context: EntityMutationContext): boolean {
    const statements = this.prepareStatements();
    return this.db.transaction((records: EntityRecord[]) => {
      let changed = false;
      for (const entity of records) {
        if (mutateEntity(statements, entity, context)) changed = true;
      }
      return changed;
    })(entities) as boolean;
  }

  private prepareStatements(): MutationStatements {
    return {
      entity: this.db.prepare(`
      INSERT INTO entity_registry
      (entity_id, entity_type, canonical_name, provenance_json, stance, visibility_scope, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_id) DO UPDATE SET
        entity_type = excluded.entity_type,
        canonical_name = excluded.canonical_name,
        provenance_json = excluded.provenance_json,
        stance = excluded.stance,
        visibility_scope = excluded.visibility_scope,
        status = excluded.status,
        updated_at = excluded.updated_at
    `),
      existingEntity: this.db.prepare('SELECT * FROM entity_registry WHERE entity_id = ?'),
      existingAliases: this.db.prepare(
        'SELECT alias, alias_norm FROM entity_aliases WHERE entity_id = ? ORDER BY alias_norm, alias',
      ),
      deleteAliases: this.db.prepare('DELETE FROM entity_aliases WHERE entity_id = ?'),
      alias: this.db.prepare(`
      INSERT OR REPLACE INTO entity_aliases
      (entity_id, alias, alias_norm, provenance_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
      activeEntities: this.db.prepare(
        "SELECT entity_id, canonical_name FROM entity_registry WHERE status = 'active' AND entity_id != ?",
      ),
      activeAliases: this.db.prepare(`
      SELECT a.entity_id, a.alias
      FROM entity_aliases a
      JOIN entity_registry r ON r.entity_id = a.entity_id
      WHERE r.status = 'active' AND a.entity_id != ?
    `),
      revision: this.db.prepare(`
      INSERT INTO entity_revision_events
      (entity_id, operation, before_json, after_json, source, actor_id, proposal_id, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    };
  }
}

function mutateEntity(statements: MutationStatements, entity: EntityRecord, context: EntityMutationContext): boolean {
  const existing = statements.existingEntity.get(entity.entityId) as EntityRow | undefined;
  const aliases = uniqueAliases(entity.aliases);
  const after = incomingStoredRecord(entity, aliases, resolveCreatedAt(existing, entity));
  const provenanceJson = JSON.stringify(after.provenance);
  const existingAliases = statements.existingAliases.all(entity.entityId) as ExistingAliasRow[];
  if (entityUnchanged(existing, existingAliases, after, provenanceJson)) return false;

  if (context.conflictPolicy === 'reject-conflict') {
    assertNoRejectedConflict(
      entity,
      after.aliases,
      existing,
      existingAliases,
      statements.activeEntities.all(entity.entityId) as Array<{ entity_id: string; canonical_name: string }>,
      statements.activeAliases.all(entity.entityId) as Array<{ entity_id: string; alias: string }>,
    );
  }

  const before = existing
    ? entityRowToRecord(
        existing,
        existingAliases.map((row) => row.alias),
      )
    : null;
  writeProjection(statements, after, provenanceJson);
  writeRevision(statements.revision, entity, before, after, context);
  return true;
}

function writeProjection(statements: MutationStatements, entity: StoredEntityRecord, provenanceJson: string): void {
  statements.entity.run(
    entity.entityId,
    entity.type,
    entity.canonicalName,
    provenanceJson,
    entity.stance,
    entity.visibilityScope,
    entity.status,
    entity.createdAt,
    entity.updatedAt,
  );
  statements.deleteAliases.run(entity.entityId);
  for (const alias of entity.aliases) {
    statements.alias.run(
      entity.entityId,
      alias,
      normalizeEntityAlias(alias),
      provenanceJson,
      entity.createdAt,
      entity.updatedAt,
    );
  }
}

function writeRevision(
  statement: Database.Statement,
  entity: EntityRecord,
  before: EntityRecord | null,
  after: EntityRecord,
  context: EntityMutationContext,
): void {
  statement.run(
    entity.entityId,
    before ? 'update' : 'create',
    before ? JSON.stringify(before) : null,
    JSON.stringify(after),
    context.source,
    nullable(context.actorId),
    nullable(context.proposalId),
    nullable(context.reason),
    new Date().toISOString(),
  );
}

function entitySurfaceMap(entity: Pick<EntityRecord, 'canonicalName' | 'aliases'>): Map<string, string> {
  const surfaces = new Map<string, string>();
  for (const surface of [entity.canonicalName, ...entity.aliases]) {
    const normalized = normalizeEntityAlias(surface);
    if (normalized && !surfaces.has(normalized)) surfaces.set(normalized, surface);
  }
  return surfaces;
}

function assertNoRejectedConflict(
  entity: EntityRecord,
  aliases: string[],
  existing: EntityRow | undefined,
  existingAliases: Array<{ alias: string; alias_norm: string }>,
  activeEntities: Array<{ entity_id: string; canonical_name: string }>,
  activeAliases: Array<{ entity_id: string; alias: string }>,
): void {
  const incomingSurfaces = entitySurfaceMap({ canonicalName: entity.canonicalName, aliases });
  if (existing) {
    const existingSurfaces = entitySurfaceMap({
      canonicalName: existing.canonical_name,
      aliases: existingAliases.map((row) => row.alias),
    });
    const shared = [...incomingSurfaces.keys()].filter((surface) => existingSurfaces.has(surface));
    throw new EntitySurfaceConflictError({
      incomingEntityId: entity.entityId,
      conflictingEntityIds: [entity.entityId],
      conflictingSurfaces: shared.length > 0 ? shared : [...incomingSurfaces.keys()],
      reason: 'existing-entity-change',
    });
  }

  const conflicts = new Map<string, Set<string>>();
  const recordConflict = (entityId: string, surface: string) => {
    const normalized = normalizeEntityAlias(surface);
    if (!incomingSurfaces.has(normalized)) return;
    let entitySurfaces = conflicts.get(entityId);
    if (!entitySurfaces) entitySurfaces = new Set<string>();
    entitySurfaces.add(normalized);
    conflicts.set(entityId, entitySurfaces);
  };
  for (const row of activeEntities) recordConflict(row.entity_id, row.canonical_name);
  for (const row of activeAliases) recordConflict(row.entity_id, row.alias);
  if (conflicts.size === 0) return;

  throw new EntitySurfaceConflictError({
    incomingEntityId: entity.entityId,
    conflictingEntityIds: [...conflicts.keys()],
    conflictingSurfaces: [...new Set([...conflicts.values()].flatMap((surfaces) => [...surfaces]))],
    reason: 'surface-collision',
  });
}

function uniqueAliases(aliases: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const alias of aliases) {
    const normalized = normalizeEntityAlias(alias);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(alias);
  }
  return unique;
}

function entityUnchanged(
  existing: EntityRow | undefined,
  existingAliases: Array<{ alias: string; alias_norm: string }>,
  entity: StoredEntityRecord,
  provenanceJson: string,
): boolean {
  if (!existing) return false;
  if (existing.entity_type !== entity.type) return false;
  if (existing.canonical_name !== entity.canonicalName) return false;
  if (existing.provenance_json !== provenanceJson) return false;
  if (existing.stance !== entity.stance) return false;
  if (existing.visibility_scope !== entity.visibilityScope) return false;
  if (existing.status !== entity.status) return false;
  const currentAliases = existingAliases.map((row) => `${row.alias_norm}\u0000${row.alias}`).sort();
  const nextAliases = entity.aliases.map((alias) => `${normalizeEntityAlias(alias)}\u0000${alias}`).sort();
  return (
    currentAliases.length === nextAliases.length && currentAliases.every((alias, index) => alias === nextAliases[index])
  );
}

function entityRowToRecord(row: EntityRow, aliases: string[]): EntityRecord {
  return {
    entityId: row.entity_id,
    type: row.entity_type as EntityType,
    canonicalName: row.canonical_name,
    aliases,
    provenance: parseProvenance(row.provenance_json),
    stance: row.stance,
    visibilityScope: row.visibility_scope,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function incomingStoredRecord(entity: EntityRecord, aliases: string[], createdAt: string): StoredEntityRecord {
  const { stance = 'unknown', visibilityScope = 'workspace', status = 'active' } = entity;
  return {
    ...entity,
    aliases,
    stance,
    visibilityScope,
    status,
    createdAt,
  };
}

function resolveCreatedAt(existing: EntityRow | undefined, entity: EntityRecord): string {
  if (existing) return existing.created_at;
  if (entity.createdAt && entity.createdAt.length > 0) return entity.createdAt;
  return entity.updatedAt;
}

function nullable(value: string | undefined): string | null {
  return value === undefined ? null : value;
}

function parseProvenance(raw: string): EntityProvenance[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (value): value is EntityProvenance =>
        typeof value === 'object' && value !== null && typeof (value as { source?: unknown }).source === 'string',
    );
  } catch {
    return [];
  }
}
