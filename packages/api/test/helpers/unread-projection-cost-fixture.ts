import type { RedisClient } from '@cat-cafe/shared/utils';
import { MessageKeys } from '../../src/domains/cats/services/stores/redis-keys/message-keys.js';

export function unreadProjectionFixture(count: number, failBatch?: number) {
  const threadId = 'reader-cost';
  const cursor = '0000000000001-000000-c0ffee00';
  const ids = Array.from({ length: count }, (_, i) => `${String(i + 2).padStart(13, '0')}-000000-c0ffee00`);
  const rawExtra = JSON.stringify({ scheduler: { hiddenTrigger: false }, fixture: 'x'.repeat(4096) });
  const bytesPerRow = Buffer.byteLength(rawExtra);
  let outstandingBytes = 0;
  let maxOutstandingBytes = 0;
  let batches = 0;
  let foldedRows = 0;
  const foldedBeforeBatch: number[] = [];
  const indexByKey = new Map(ids.map((id, i) => [MessageKeys.detail(id), i]));
  function readFields(key: string): Array<string | null> {
    const index = indexByKey.get(key);
    if (index === undefined) throw new Error('Unexpected fixture field read');
    const fields: Array<string | null> = [
      'owner',
      'codex61-sol',
      null,
      null,
      index % 333 === 0 ? '1' : '0',
      'delivered',
      null,
      threadId,
      rawExtra,
      null,
    ];
    outstandingBytes += bytesPerRow;
    maxOutstandingBytes = Math.max(maxOutstandingBytes, outstandingBytes);
    let consumed = false;
    Object.defineProperty(fields, 8, {
      get() {
        if (!consumed) {
          consumed = true;
          foldedRows++;
          outstandingBytes -= bytesPerRow;
        }
        return rawExtra;
      },
    });
    return fields;
  }
  const redis = {
    pipeline() {
      const commands: Array<{ kind: string; key: string; min?: string | number; max?: string | number }> = [];
      const pipeline = {
        hget(key: string) {
          commands.push({ kind: 'position', key });
          return pipeline;
        },
        zscore(key: string) {
          commands.push({ kind: 'position', key });
          return pipeline;
        },
        zrangebyscore(key: string, min: string | number, max: string | number) {
          commands.push({ kind: 'range', key, min, max });
          return pipeline;
        },
        hmget(key: string) {
          commands.push({ kind: 'fields', key });
          return pipeline;
        },
        async exec() {
          if (commands[0]?.kind === 'fields') {
            batches++;
            foldedBeforeBatch.push(foldedRows);
            if (batches === failBatch) return null;
          }
          return commands.map((command): [null, unknown] => {
            if (command.kind === 'position') return [null, '0'];
            if (command.kind === 'range') return [null, command.max === '+inf' ? ids : []];
            return [null, readFields(command.key)];
          });
        },
      };
      return pipeline;
    },
  } as unknown as RedisClient;
  return {
    redis,
    cursors: [{ threadId, afterId: cursor }],
    bytesPerRow,
    stats: () => ({ batches, foldedRows, maxOutstandingBytes, outstandingBytes, foldedBeforeBatch }),
  };
}
