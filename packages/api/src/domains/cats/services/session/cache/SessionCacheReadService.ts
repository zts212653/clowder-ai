import type { CatConfig, SessionCacheWarmth, SessionRecord } from '@cat-cafe/shared';
import { createCatId } from '@cat-cafe/shared';
import type { ISessionChainStore } from '../../stores/ports/SessionChainStore.js';
import type { CacheRetentionWarmProof } from './cache-retention-proof.js';
import { sessionCacheRuntimeKey } from './session-cache-runtime.js';
import { projectSessionCacheWarmth } from './session-cache-warmth.js';

export interface SessionCacheExecutionBinding {
  catId: string;
  runtime: string;
  model: string;
}

export interface SessionCacheReadInput {
  ownerId: string;
  threadId: string;
  catIds: readonly string[];
  observedAt?: number;
  /** Trusted actual-send binding takes precedence over the catalog's defaults. */
  executionBindings?: readonly SessionCacheExecutionBinding[];
}
export interface SessionCacheReadPort {
  read(
    input: SessionCacheReadInput,
  ): Promise<readonly { catId: string; warmth: SessionCacheWarmth; exists: boolean }[]>;
}

/** Reads only canonical active sessions. Observation failure never blocks a dispatch. */
export class SessionCacheReadService implements SessionCacheReadPort {
  constructor(
    private readonly sessions: Pick<ISessionChainStore, 'getActive'>,
    private readonly readBudgetMs = 100,
    private readonly getConfig?: (
      catId: string,
    ) => Pick<CatConfig, 'clientId' | 'carrier' | 'defaultModel'> | undefined,
    private readonly readRetentionProof?: (record: SessionRecord) => Promise<CacheRetentionWarmProof | undefined>,
  ) {}

  async read(input: SessionCacheReadInput) {
    const now = input.observedAt ?? Date.now();
    const catIds = [...new Set(input.catIds)].slice(0, 64);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unavailable = catIds.map((catId) => ({
      catId,
      exists: false,
      warmth: {
        status: 'unknown',
        estimated: true,
        source: 'unavailable',
        reason: 'read_unavailable',
      } as SessionCacheWarmth,
    }));
    try {
      return await Promise.race([
        Promise.all(
          catIds.map(async (catId) => {
            const record = await this.sessions.getActive(createCatId(catId), input.threadId, input.ownerId);
            const owned =
              !!record &&
              record.userId === input.ownerId &&
              record.threadId === input.threadId &&
              record.catId === catId;
            const config = this.getConfig?.(catId);
            const binding = input.executionBindings?.find((entry) => entry.catId === catId);
            return {
              catId,
              exists: owned,
              warmth: {
                ...projectSessionCacheWarmth(
                  owned ? record : null,
                  now,
                  binding ??
                    (config
                      ? { runtime: sessionCacheRuntimeKey(config) ?? '', model: config.defaultModel }
                      : undefined),
                  owned && this.readRetentionProof ? await this.readRetentionProof(record) : undefined,
                ),
                bindingSource: binding
                  ? ('frozen_execution' as const)
                  : config
                    ? ('catalog_default' as const)
                    : ('observed_session' as const),
              },
            };
          }),
        ),
        new Promise<typeof unavailable>((resolve) => {
          timer = setTimeout(() => resolve(unavailable), this.readBudgetMs);
        }),
      ]);
    } catch {
      return unavailable;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
