import type { RuntimeInteractionRecord } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { advanceSettledIndex } from '../../../utils/redis-settled-index.js';

export const runtimeSettledKey = (owner: string) => `runtime-interaction:user:${encodeURIComponent(owner)}:settled`;
export const RUNTIME_HISTORY_BACKFILL_BATCH = 200;
export function advanceRuntimeHistoryIndex(
  redis: RedisClient,
  parse: (value: Record<string, string>) => RuntimeInteractionRecord | null,
) {
  return advanceSettledIndex(redis, {
    progressKey: 'runtime-interaction:history-index:v1',
    prefix: 'runtime-interaction:',
    type: 'hash',
    entry: (raw, key) => {
      const record = parse(raw as Record<string, string>);
      if (!record || key !== `runtime-interaction:${record.request.interactionId}`)
        throw new Error('runtime history backfill source identity mismatch');
      return record.cardRef && record.terminal && record.status !== 'pending' && record.status !== 'staged'
        ? {
            indexKey: runtimeSettledKey(record.request.owner.userId),
            id: record.request.interactionId,
            score: record.terminal.settledAt,
          }
        : null;
    },
  });
}
