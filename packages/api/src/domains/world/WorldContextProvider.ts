import type { WorldContextEnvelope } from '@cat-cafe/shared';
import type { IWorldStore } from './interfaces.js';
import type { WorldKnowledgeAdapter } from './WorldKnowledgeAdapter.js';

export class WorldContextProvider {
  constructor(
    private readonly store: IWorldStore,
    private readonly knowledgeAdapter: WorldKnowledgeAdapter,
  ) {}

  async assemble(
    worldId: string,
    sceneId: string,
    options?: { query?: string; careLoopHint?: WorldContextEnvelope['careLoopHint'] },
  ): Promise<WorldContextEnvelope | null> {
    const ctx = await this.store.getContext(worldId, sceneId);
    if (!ctx) return null;

    const relationshipSnapshot = ctx.characters.flatMap((c) => c.relationshipTension?.bonds ?? []);

    const recall = options?.query
      ? await this.knowledgeAdapter.searchWorld(options.query, { worldId, sceneId })
      : { canonMatches: [], eventMatches: [] };

    const canonSummary = ctx.canonSummary.map((cs) => ({
      recordId: cs.recordId,
      summary: cs.summary,
      acceptedAt: cs.acceptedAt,
    }));

    return {
      world: ctx.world,
      scene: ctx.scene,
      characters: ctx.characters,
      recentEvents: ctx.recentEvents,
      relationshipSnapshot,
      canonSummary,
      recall,
      ...(options?.careLoopHint ? { careLoopHint: options.careLoopHint } : {}),
    };
  }
}
