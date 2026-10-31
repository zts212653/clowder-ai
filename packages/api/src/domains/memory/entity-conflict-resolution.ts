import { createHash } from 'node:crypto';
import type { EntityConflictContext, EntityConflictRecord } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import { normalizeEntityAlias } from './entity-registry-mutation.js';
import type { EntityRecord, EntityType } from './interfaces.js';

interface EntityRow {
  entity_id: string;
  entity_type: string;
  canonical_name: string;
  provenance_json: string;
  stance: string;
  visibility_scope: string;
  status: string;
  updated_at: string;
}

interface AliasRow {
  entity_id: string;
  alias: string;
  alias_norm: string;
}

export function inspectEntityConflict(
  db: Database.Database,
  incoming: EntityRecord,
  viewerUserId?: string,
): EntityConflictContext | null {
  const current = loadEntity(db, incoming.entityId);
  if (current) {
    if (sameStoredEntity(current.record, current.provenanceJson, incoming)) return null;
    const visible = isEntityVisibleToUser(current.record.visibilityScope, viewerUserId);
    return buildContext({
      reason: 'existing-entity-change',
      incoming,
      candidates: visible ? [current.record] : [],
      conflictingSurfaces: sharedSurfaces(current.record, incoming),
      canonicalReplacementRequiredFor: [],
      allowedActions: visible ? ['merge-aliases', 'replace', 'reject'] : ['reject'],
    });
  }

  const incomingSurfaces = surfaceNorms(incoming);
  const allCandidates = loadActiveEntities(db)
    .filter((candidate) => surfaceNorms(candidate).some((surface) => incomingSurfaces.includes(surface)))
    .sort((left, right) => left.entityId.localeCompare(right.entityId));
  if (allCandidates.length === 0) return null;

  const candidates = allCandidates.filter((candidate) =>
    isEntityVisibleToUser(candidate.visibilityScope, viewerUserId),
  );
  const hasHiddenCandidates = candidates.length !== allCandidates.length;
  const candidateSurfaces = new Set(allCandidates.flatMap((candidate) => surfaceNorms(candidate)));
  const conflictingSurfaces = incomingSurfaces.filter((surface) => candidateSurfaces.has(surface)).sort();
  const conflictSet = new Set(conflictingSurfaces);
  const canonicalReplacementRequiredFor = hasHiddenCandidates
    ? []
    : candidates
        .filter((candidate) => conflictSet.has(normalizeEntityAlias(candidate.canonicalName)))
        .map((candidate) => candidate.entityId)
        .sort();

  return buildContext({
    reason: 'surface-collision',
    incoming,
    candidates,
    conflictingSurfaces,
    canonicalReplacementRequiredFor,
    allowedActions: hasHiddenCandidates ? ['reject'] : ['correct', 'transfer', 'polysemy', 'reject'],
  });
}

export function isEntityVisibleToUser(visibilityScope: string, viewerUserId?: string): boolean {
  return visibilityScope === 'workspace' || Boolean(viewerUserId && visibilityScope === `private:${viewerUserId}`);
}

function loadEntity(
  db: Database.Database,
  entityId: string,
): { record: EntityConflictRecord; provenanceJson: string } | null {
  const row = db.prepare('SELECT * FROM entity_registry WHERE entity_id = ?').get(entityId) as EntityRow | undefined;
  if (!row) return null;
  return {
    record: rowToRecord(row, loadAliases(db, entityId)),
    provenanceJson: row.provenance_json,
  };
}

function loadActiveEntities(db: Database.Database): EntityConflictRecord[] {
  const rows = db
    .prepare("SELECT * FROM entity_registry WHERE status = 'active' ORDER BY entity_id")
    .all() as EntityRow[];
  return rows.map((row) => rowToRecord(row, loadAliases(db, row.entity_id)));
}

function loadAliases(db: Database.Database, entityId: string): string[] {
  const rows = db
    .prepare('SELECT entity_id, alias, alias_norm FROM entity_aliases WHERE entity_id = ? ORDER BY alias')
    .all(entityId) as AliasRow[];
  return rows.map((row) => row.alias);
}

function rowToRecord(row: EntityRow, aliases: string[]): EntityConflictRecord {
  return {
    entityId: row.entity_id,
    entityType: row.entity_type as EntityType,
    canonicalName: row.canonical_name,
    aliases,
    stance: row.stance,
    visibilityScope: row.visibility_scope,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

function incomingRecord(incoming: EntityRecord): EntityConflictRecord {
  return {
    entityId: incoming.entityId,
    entityType: incoming.type,
    canonicalName: incoming.canonicalName,
    aliases: uniqueAliases(incoming.aliases),
    stance: incoming.stance ?? 'unknown',
    visibilityScope: incoming.visibilityScope ?? 'workspace',
    status: incoming.status ?? 'active',
  };
}

function sameStoredEntity(
  current: EntityConflictRecord,
  currentProvenanceJson: string,
  incoming: EntityRecord,
): boolean {
  const next = incomingRecord(incoming);
  return (
    current.entityType === next.entityType &&
    current.canonicalName === next.canonicalName &&
    currentProvenanceJson === JSON.stringify(incoming.provenance) &&
    current.stance === next.stance &&
    current.visibilityScope === next.visibilityScope &&
    current.status === next.status &&
    aliasKeys(current.aliases).join('\u0001') === aliasKeys(next.aliases).join('\u0001')
  );
}

function buildContext(
  input: Omit<EntityConflictContext, 'version' | 'fingerprint' | 'incoming'> & { incoming: EntityRecord },
): EntityConflictContext {
  const withoutFingerprint = {
    version: 1 as const,
    reason: input.reason,
    incoming: incomingRecord(input.incoming),
    candidates: input.candidates,
    conflictingSurfaces: input.conflictingSurfaces,
    canonicalReplacementRequiredFor: input.canonicalReplacementRequiredFor,
    allowedActions: input.allowedActions,
  };
  return {
    ...withoutFingerprint,
    fingerprint: createHash('sha256').update(JSON.stringify(withoutFingerprint)).digest('hex'),
  };
}

function sharedSurfaces(current: EntityConflictRecord, incoming: EntityRecord): string[] {
  const currentSurfaces = new Set(surfaceNorms(current));
  const shared = surfaceNorms(incoming).filter((surface) => currentSurfaces.has(surface));
  return (shared.length > 0 ? shared : surfaceNorms(incoming)).sort();
}

function surfaceNorms(entity: Pick<EntityConflictRecord, 'canonicalName' | 'aliases'>): string[] {
  return [...new Set([entity.canonicalName, ...entity.aliases].map(normalizeEntityAlias).filter(Boolean))];
}

function uniqueAliases(aliases: string[]): string[] {
  const byNorm = new Map<string, string>();
  for (const alias of aliases) {
    const normalized = normalizeEntityAlias(alias);
    if (normalized && !byNorm.has(normalized)) byNorm.set(normalized, alias);
  }
  return [...byNorm.values()];
}

function aliasKeys(aliases: string[]): string[] {
  return aliases.map((alias) => `${normalizeEntityAlias(alias)}\u0000${alias}`).sort();
}
