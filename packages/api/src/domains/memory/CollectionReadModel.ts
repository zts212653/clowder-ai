import type Database from 'better-sqlite3';
import type { CollectionSensitivity } from './collection-types.js';
import type { EvidenceKind } from './interfaces.js';

export interface CollectionOverview {
  collectionId: string;
  displayName: string;
  sensitivity: CollectionSensitivity;
  docCount: number;
  topKinds: Array<{ kind: EvidenceKind; count: number }>;
  recentAnchors: Array<{ anchor: string; title: string; updatedAt: string }>;
  indexable: false;
  sourceAnchors: string[];
}

export interface CollectionHealth {
  collectionId: string;
  indexFreshness: string;
  pendingReviewCount: number;
  secretFindingsCount: number;
  orphanedAnchorCount: number;
  indexable: false;
  sourceAnchors: string[];
}

export class CollectionReadModel {
  static computeOverview(
    collectionId: string,
    displayName: string,
    sensitivity: CollectionSensitivity,
    db: Database.Database,
  ): CollectionOverview {
    const docCount = (db.prepare('SELECT count(*) AS c FROM evidence_docs').get() as { c: number })?.c ?? 0;

    const topKinds = db
      .prepare('SELECT kind, count(*) AS count FROM evidence_docs GROUP BY kind ORDER BY count DESC LIMIT 5')
      .all() as Array<{ kind: EvidenceKind; count: number }>;

    const recentAnchors = db
      .prepare('SELECT anchor, title, updated_at AS updatedAt FROM evidence_docs ORDER BY updated_at DESC LIMIT 5')
      .all() as Array<{ anchor: string; title: string; updatedAt: string }>;

    return {
      collectionId,
      displayName,
      sensitivity,
      docCount,
      topKinds,
      recentAnchors,
      indexable: false,
      sourceAnchors: recentAnchors.map((r) => r.anchor),
    };
  }

  static computeDocumentGroups(
    _collectionId: string,
    db: Database.Database,
    limit = 20,
  ): Array<{
    kind: string;
    count: number;
    hasMore: boolean;
    documents: Array<{ anchor: string; title: string; updatedAt: string; status: string }>;
  }> {
    const countRows = db
      .prepare('SELECT kind, count(*) AS count FROM evidence_docs GROUP BY kind ORDER BY count DESC')
      .all() as Array<{ kind: string; count: number }>;

    const rows = db
      .prepare(
        'SELECT anchor, title, kind, status, updated_at AS updatedAt FROM evidence_docs ORDER BY kind, updated_at DESC',
      )
      .all() as Array<{ anchor: string; title: string; kind: string; status: string; updatedAt: string }>;

    const groupMap = new Map<string, { anchor: string; title: string; updatedAt: string; status: string }[]>();
    for (const row of rows) {
      const kind = row.kind || 'unknown';
      let list = groupMap.get(kind);
      if (!list) {
        list = [];
        groupMap.set(kind, list);
      }
      list.push({ anchor: row.anchor, title: row.title, updatedAt: row.updatedAt, status: row.status });
    }

    const countByKind = new Map(countRows.map((r) => [r.kind || 'unknown', r.count]));

    return Array.from(groupMap.entries()).map(([kind, documents]) => {
      const total = countByKind.get(kind) ?? documents.length;
      return {
        kind,
        count: total,
        hasMore: documents.length > limit,
        documents: documents.slice(0, limit),
      };
    });
  }

  static computeHealth(collectionId: string, db: Database.Database): CollectionHealth {
    const lastUpdated =
      (db.prepare('SELECT max(updated_at) AS t FROM evidence_docs').get() as { t: string | null })?.t ?? '';

    // Phase A stub: markers live in YAML (MarkerQueue), not SQLite — wire to MarkerQueue in Phase B
    const pendingReviewCount = 0;

    let orphanedAnchorCount = 0;
    try {
      orphanedAnchorCount =
        (
          db
            .prepare(
              'SELECT count(*) AS c FROM edges WHERE from_anchor NOT IN (SELECT anchor FROM evidence_docs) OR to_anchor NOT IN (SELECT anchor FROM evidence_docs)',
            )
            .get() as { c: number }
        )?.c ?? 0;
    } catch {
      /* edges table may not exist */
    }

    return {
      collectionId,
      indexFreshness: lastUpdated,
      pendingReviewCount,
      secretFindingsCount: 0,
      orphanedAnchorCount,
      indexable: false,
      sourceAnchors: [],
    };
  }
}
