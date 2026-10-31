import type { EvidenceItem } from './interfaces.js';
import type { SqliteEvidenceStore } from './SqliteEvidenceStore.js';

export const DOCUMENT_SOURCE_CLAIMS_KEY = 'document_source_claims';

/** Derived scanner bookkeeping, not an identity or permission authority. Includes collision losers. */
export function readDocumentSourceClaims(store: SqliteEvidenceStore): Map<string, string> | null {
  const row = store.getDb().prepare('SELECT value FROM embedding_meta WHERE key = ?').get(DOCUMENT_SOURCE_CLAIMS_KEY) as
    | { value: string }
    | undefined;
  if (!row) return null;
  const entries: unknown = JSON.parse(row.value);
  if (
    !Array.isArray(entries) ||
    entries.some(
      (entry) =>
        !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string',
    )
  ) {
    throw new Error('Invalid document source projection metadata');
  }
  return new Map(entries as Array<[string, string]>);
}

export function documentSourceClaims(
  sources: readonly Pick<EvidenceItem, 'anchor' | 'sourcePath'>[],
): Map<string, string> {
  const claims = new Map<string, string>();
  for (const { anchor, sourcePath } of sources) if (sourcePath) claims.set(sourcePath, anchor);
  return claims;
}

export async function publishDocumentSourceClaims(
  store: SqliteEvidenceStore,
  claims: ReadonlyMap<string, string>,
): Promise<void> {
  const value = JSON.stringify([...claims]);
  await store.runExclusive(() =>
    store
      .getDb()
      .prepare('INSERT OR REPLACE INTO embedding_meta (key, value) VALUES (?, ?)')
      .run(DOCUMENT_SOURCE_CLAIMS_KEY, value),
  );
}
