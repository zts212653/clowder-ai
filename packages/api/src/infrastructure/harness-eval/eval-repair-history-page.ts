import type { RedisClient } from '@cat-cafe/shared/utils';
import { SettledIndexPreparingError } from '../../utils/redis-settled-index.js';
import { readRedisSettledPage } from '../../utils/redis-settled-page.js';
import { requireHistoryIndexTime, type SettledHistoryPageOptions } from '../../utils/settled-history-page.js';
import { EvalRepairHistoryKeys as keys } from './eval-repair-history-keys.js';
import { evalRepairHistoryPrepared, prepareEvalRepairHistory } from './eval-repair-history-prepare.js';
import { evalRepairHistoryTime, readEvalRepairHistoryRecord } from './eval-repair-history-read.js';

/** A page remains a canonical event projection, with refs replacing a whole-log scan. */
export async function pageEvalRepairHistory(redis: RedisClient, owner: string, options: SettledHistoryPageOptions) {
  if (!(await prepareEvalRepairHistory(redis))) throw new SettledIndexPreparingError();
  const version = await redis.get(keys.version);
  const expected = Number((await redis.hget(keys.ownerCounts, owner)) ?? 0);
  if (!Number.isSafeInteger(expected) || expected < 0 || expected !== (await redis.zcard(keys.owner(owner))))
    throw new Error('F266 history index coverage mismatch');
  const page = await readRedisSettledPage(redis, keys.owner(owner), options, async (id, time) => {
    const read = await readEvalRepairHistoryRecord(redis, id);
    if (!read) throw new Error('F266 indexed history record missing');
    const record = read.record;
    if (
      record.proposal.requestOrigin.ownerUserId !== owner ||
      record.publication.state !== 'anchored' ||
      record.lifecycle.resolution === 'open'
    )
      throw new Error('F266 indexed history identity mismatch');
    requireHistoryIndexTime(time, evalRepairHistoryTime(record));
    return record;
  });
  if (version !== (await redis.get(keys.version)) || !(await evalRepairHistoryPrepared(redis)))
    throw new SettledIndexPreparingError();
  return page;
}
