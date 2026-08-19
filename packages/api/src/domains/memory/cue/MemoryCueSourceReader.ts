import type { RecallScopeV1 } from '@cat-cafe/shared';
import type { MemoryCueDrillCoordinate } from './MemoryCueDrillHandleService.js';
import type { MemoryCueInvalidationReason } from './MemoryCueEpisodeStore.js';

export interface MemoryCueSourceReader {
  read(input: {
    family: MemoryCueDrillCoordinate['family'];
    anchor: string;
    expectedRevision: string;
    scope: RecallScopeV1;
  }): Promise<
    { status: 'ok'; payload: unknown } | { status: 'not_available'; invalidationReason?: MemoryCueInvalidationReason }
  >;
}
