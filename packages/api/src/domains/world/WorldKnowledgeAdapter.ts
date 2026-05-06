import type { CanonPromotionRecord, WorldRecallResult } from '@cat-cafe/shared';
import type { IEvidenceStore } from '../memory/interfaces.js';

export class WorldKnowledgeAdapter {
  constructor(private readonly evidenceStore: IEvidenceStore) {}

  async indexCanon(record: CanonPromotionRecord, worldName: string): Promise<void> {
    if (record.status !== 'accepted') return;

    await this.evidenceStore.upsert([
      {
        anchor: `world-canon-${record.recordId}`,
        kind: 'decision',
        status: 'active',
        title: `[${worldName}] ${record.summary}`,
        summary: record.summary,
        keywords: [record.category ?? 'canon', record.worldId].filter(Boolean) as string[],
        updatedAt: record.decidedAt ?? record.createdAt,
        worldId: record.worldId,
        sceneId: record.sceneId,
      },
    ]);
  }

  async searchWorld(
    query: string,
    options: { worldId: string; sceneId?: string; limit?: number },
  ): Promise<WorldRecallResult> {
    const results = await this.evidenceStore.search(query, {
      worldId: options.worldId,
      sceneId: options.sceneId,
      limit: options.limit ?? 10,
      mode: 'hybrid',
    });

    return {
      canonMatches: results.map((r) => ({
        anchor: r.anchor,
        title: r.title,
        summary: r.summary ?? '',
        confidence: 1.0,
      })),
      eventMatches: [],
    };
  }
}
