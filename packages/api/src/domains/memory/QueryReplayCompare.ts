import type Database from 'better-sqlite3';
import type { IKnowledgeResolver } from './interfaces.js';

interface PerCollectionDiff {
  collectionId: string;
  captured: number;
  replayed: number;
  overlap: string[];
  added: string[];
  removed: string[];
}

interface QueryReplayResult {
  captureId: number;
  capturedAt: string;
  query: string;
  params: { scope?: string; dimension?: string; collections?: string[] };
  perCollection: PerCollectionDiff[];
  aggregated: {
    capturedAnchors: string[];
    replayedAnchors: string[];
    jaccardSimilarity: number;
  };
}

export class QueryReplayCompare {
  constructor(private db: Database.Database) {}

  async replay(captureId: number, resolver: IKnowledgeResolver): Promise<QueryReplayResult> {
    const row = this.db.prepare('SELECT * FROM f163_logs WHERE id = ? AND log_type = ?').get(captureId, 'search') as
      | { payload: string; created_at: string }
      | undefined;
    if (!row) throw new Error(`Capture ${captureId} not found`);

    const payload = JSON.parse(row.payload);
    const { query, scope, dimension, collections, topKPerCollection, limit } = payload;

    if (!topKPerCollection || typeof topKPerCollection !== 'object' || Object.keys(topKPerCollection).length === 0) {
      throw new Error(`Unsupported capture format: missing or empty topKPerCollection (captureId=${captureId})`);
    }
    const hasAnchors = Object.values(topKPerCollection).every(
      (v) => v && typeof v === 'object' && Array.isArray((v as { anchors?: unknown }).anchors),
    );
    if (!hasAnchors) {
      throw new Error(
        `Unsupported capture format: topKPerCollection entries must have anchors array (captureId=${captureId})`,
      );
    }

    const result = await resolver.resolve(query, { scope, dimension, collections, limit });
    const replayGroups = result.collectionGroups ?? [];

    const allCapturedAnchors: string[] = [];
    const allReplayedAnchors: string[] = [];
    const perCollection: PerCollectionDiff[] = [];

    const allCollectionIds = new Set<string>([
      ...Object.keys(topKPerCollection ?? {}),
      ...replayGroups.map((g) => g.collectionId),
    ]);

    for (const collectionId of allCollectionIds) {
      const capturedEntry = topKPerCollection?.[collectionId];
      const capturedAnchors: string[] = capturedEntry?.anchors ?? [];
      const replayGroup = replayGroups.find((g) => g.collectionId === collectionId);
      const replayedAnchors: string[] = replayGroup?.items.map((i) => i.anchor) ?? [];

      const capturedSet = new Set(capturedAnchors);
      const replayedSet = new Set(replayedAnchors);

      const overlap = capturedAnchors.filter((a) => replayedSet.has(a));
      const added = replayedAnchors.filter((a) => !capturedSet.has(a));
      const removed = capturedAnchors.filter((a) => !replayedSet.has(a));

      perCollection.push({
        collectionId,
        captured: capturedAnchors.length,
        replayed: replayedAnchors.length,
        overlap,
        added,
        removed,
      });

      allCapturedAnchors.push(...capturedAnchors);
      allReplayedAnchors.push(...replayedAnchors);
    }

    const capturedSet = new Set(allCapturedAnchors);
    const replayedSet = new Set(allReplayedAnchors);
    const union = new Set([...capturedSet, ...replayedSet]);
    const intersection = [...capturedSet].filter((a) => replayedSet.has(a));
    const jaccardSimilarity = union.size === 0 ? 1 : intersection.length / union.size;

    return {
      captureId,
      capturedAt: row.created_at,
      query,
      params: { scope, dimension, collections },
      perCollection,
      aggregated: {
        capturedAnchors: allCapturedAnchors,
        replayedAnchors: allReplayedAnchors,
        jaccardSimilarity,
      },
    };
  }
}
