import type { ListenRetention } from '@cat-cafe/shared';
import Database from 'better-sqlite3';

export interface ListenAssetPolicy {
  assetId: string;
  lastUsedAt: number;
  expiresAt: number | null;
  referenceCount: number;
}

interface AssetRetentionRow {
  asset_id: string;
  last_used_at: number;
  asset_retention: ListenRetention;
  retention: ListenRetention | null;
}

const RETENTION_MS: Record<Exclude<ListenRetention, 'forever'>, number> = {
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export function syncAssetRetentions(db: Database.Database, assetIds: string[], fallback: ListenRetention): void {
  const liveRetentions = db.prepare(
    `SELECT documents.retention
     FROM listen_sentence_assets sentences
     JOIN listen_documents documents ON documents.id = sentences.document_id
     WHERE sentences.asset_id = ?`,
  );
  const update = db.prepare('UPDATE listen_assets SET retention = ? WHERE asset_id = ?');
  for (const assetId of assetIds) {
    const rows = liveRetentions.all(assetId) as Array<{ retention: ListenRetention }>;
    update.run(
      strongestRetention(
        rows.map(({ retention }) => retention),
        fallback,
      ),
      assetId,
    );
  }
}

export function listAssetPolicies(db: Database.Database): ListenAssetPolicy[] {
  const rows = db
    .prepare(
      `SELECT assets.asset_id, assets.last_used_at, assets.retention AS asset_retention, documents.retention
       FROM listen_assets assets
       LEFT JOIN listen_sentence_assets sentences ON sentences.asset_id = assets.asset_id
       LEFT JOIN listen_documents documents ON documents.id = sentences.document_id
       ORDER BY assets.asset_id`,
    )
    .all() as AssetRetentionRow[];
  const grouped = new Map<
    string,
    { lastUsedAt: number; assetRetention: ListenRetention; retentions: ListenRetention[] }
  >();
  for (const row of rows) {
    const entry = grouped.get(row.asset_id) ?? {
      lastUsedAt: row.last_used_at,
      assetRetention: row.asset_retention,
      retentions: [],
    };
    if (row.retention) entry.retentions.push(row.retention);
    grouped.set(row.asset_id, entry);
  }
  return [...grouped].map(([assetId, entry]) => ({
    assetId,
    lastUsedAt: entry.lastUsedAt,
    expiresAt: expirationFor(entry.lastUsedAt, entry.retentions.length > 0 ? entry.retentions : [entry.assetRetention]),
    referenceCount: entry.retentions.length,
  }));
}

function strongestRetention(retentions: ListenRetention[], fallback: ListenRetention): ListenRetention {
  if (retentions.includes('forever')) return 'forever';
  if (retentions.includes('30d')) return '30d';
  if (retentions.includes('7d')) return '7d';
  return fallback;
}

function expirationFor(lastUsedAt: number, retentions: ListenRetention[]): number | null {
  if (retentions.includes('forever')) return null;
  const retentionMs = retentions.reduce(
    (maximum, retention) => Math.max(maximum, retention === 'forever' ? 0 : RETENTION_MS[retention]),
    0,
  );
  return lastUsedAt + retentionMs;
}
