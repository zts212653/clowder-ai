import { normalizeEntityAlias } from '../entity-registry-mutation.js';
import type { EntityRecord, IEvidenceStore } from '../interfaces.js';

export type WorkspacePersonResolution =
  | { status: 'resolved'; entityRef: string; canonicalName: string }
  | { status: 'not_found' }
  | { status: 'ambiguous' }
  | { status: 'unavailable' };

export type WorkspacePersonAliasSetResolution = WorkspacePersonResolution | { status: 'conflict' };

export interface WorkspacePersonResolver {
  resolve(alias: string): Promise<WorkspacePersonResolution>;
}

type WorkspacePersonReadPort = Pick<IEvidenceStore, 'getEntity' | 'resolveEntityAliases'>;

function isActiveWorkspacePerson(record: EntityRecord | null): record is EntityRecord {
  return (
    record !== null &&
    record.type === 'person' &&
    (record.status ?? 'active') === 'active' &&
    (record.visibilityScope ?? 'workspace') === 'workspace'
  );
}

export async function resolveWorkspacePersonAliasSet(
  resolver: WorkspacePersonResolver,
  aliases: readonly string[],
): Promise<WorkspacePersonAliasSetResolution> {
  const uniqueAliases = new Map<string, string>();
  for (const alias of aliases) {
    const normalized = normalizeEntityAlias(alias);
    if (normalized && !uniqueAliases.has(normalized)) uniqueAliases.set(normalized, alias);
  }
  if (uniqueAliases.size === 0) return { status: 'unavailable' };

  const resolutions = await Promise.all(
    [...uniqueAliases.values()].map(async (alias): Promise<WorkspacePersonResolution> => {
      try {
        return await resolver.resolve(alias);
      } catch {
        return { status: 'unavailable' };
      }
    }),
  );
  if (resolutions.some((resolution) => resolution.status === 'unavailable')) {
    return { status: 'unavailable' };
  }
  if (resolutions.some((resolution) => resolution.status === 'ambiguous')) {
    return { status: 'ambiguous' };
  }

  const resolved = resolutions.filter(
    (resolution): resolution is Extract<WorkspacePersonResolution, { status: 'resolved' }> =>
      resolution.status === 'resolved',
  );
  const entityRefs = new Set(resolved.map((resolution) => resolution.entityRef));
  if (entityRefs.size > 1) return { status: 'conflict' };
  return resolved[0] ?? { status: 'not_found' };
}

export class EvidenceStoreWorkspacePersonResolver implements WorkspacePersonResolver {
  constructor(private readonly store: WorkspacePersonReadPort) {}

  async resolve(alias: string): Promise<WorkspacePersonResolution> {
    const normalizedAlias = normalizeEntityAlias(alias);
    if (!normalizedAlias || !this.store.resolveEntityAliases || !this.store.getEntity) {
      return { status: 'unavailable' };
    }

    try {
      const matches = await this.store.resolveEntityAliases(alias);
      if (matches.length === 0) return { status: 'not_found' };

      const exactMatches = matches.filter(
        (candidate) => normalizeEntityAlias(candidate.matchedAlias) === normalizedAlias,
      );
      if (exactMatches.length === 0) return { status: 'unavailable' };

      const records = new Map<string, { status: 'resolved'; entityRef: string; canonicalName: string }>();
      for (const candidate of exactMatches) {
        const record = await this.store.getEntity(candidate.entityId);
        if (!isActiveWorkspacePerson(record) || record.entityId !== candidate.entityId) {
          return { status: 'unavailable' };
        }
        records.set(record.entityId, {
          status: 'resolved',
          entityRef: record.entityId,
          canonicalName: record.canonicalName,
        });
      }

      if (records.size === 1) return [...records.values()][0];
      return { status: 'ambiguous' };
    } catch {
      return { status: 'unavailable' };
    }
  }
}
