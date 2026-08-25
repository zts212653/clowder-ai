import type { CatId, SessionRecord } from '@cat-cafe/shared';
import type { RouteStrategyDeps } from './route-helpers.js';
import { assembleIncrementalContext } from './route-helpers.js';

export interface PostCompactEpochDecision {
  readonly contextEpoch: number;
  readonly contextMode: 'cold';
  readonly transition: 'context_compacted' | 'context_compaction_replay';
}

export interface PostCompactContextProjection {
  readonly contextPacket: string;
  readonly projectedMessageIds: readonly string[];
  readonly exposedMessageIds: readonly string[];
  readonly boundaryId?: string;
}

export type PostCompactContextProjector = (input: {
  readonly record: Pick<SessionRecord, 'userId' | 'catId' | 'threadId'>;
  readonly decision: PostCompactEpochDecision;
}) => Promise<PostCompactContextProjection>;

/**
 * Reuse the same canonical cold assembler as serial/parallel routing. This is
 * deliberately read-only with respect to delivery/seen cursors: the hook is a
 * recovery presentation, not a second message-delivery acknowledgement path.
 */
export function createPostCompactContextProjector(deps: RouteStrategyDeps): PostCompactContextProjector {
  return async ({ record, decision }) => {
    const result = await assembleIncrementalContext(
      deps,
      record.userId,
      record.threadId,
      record.catId as CatId,
      undefined,
      'play',
      {
        contextProjection: {
          coordinate: {
            providerCarrier: { provider: 'claude', carrier: 'print_sdk' },
            invocationOrigin: 'unknown',
            routeTopology: 'independent',
          },
          contextEpoch: decision.contextEpoch,
          contextMode: 'cold',
          transition: decision.transition,
          reason: 'authoritative_compaction',
        },
      },
    );
    return {
      contextPacket: result.contextText,
      projectedMessageIds: result.projectedMessageIds,
      exposedMessageIds: result.exposedMessageIds,
      ...(result.boundaryId ? { boundaryId: result.boundaryId } : {}),
    };
  };
}
