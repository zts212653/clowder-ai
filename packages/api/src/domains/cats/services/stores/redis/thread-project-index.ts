import { createHash } from 'node:crypto';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { ThreadKeys } from '../redis-keys/thread-keys.js';

export const threadProjectIndexKey = (projectPath: string): string =>
  `threads:project:${createHash('sha256').update(projectPath).digest('hex')}`;

const BACKFILL_IF_CURRENT = `
if redis.call('HGET', KEYS[1], 'id') ~= ARGV[1]
  or redis.call('HGET', KEYS[1], 'createdBy') ~= ARGV[2]
  or (redis.call('HGET', KEYS[1], 'projectPath') or 'default') ~= ARGV[3] then return 0 end
redis.call('SADD', KEYS[2], ARGV[1])
return 1
`;

/** Rebuild legacy discovery once per client lifetime, in bounded batches. Writers update membership
 * in the same transaction as canonical truth. Backfill rechecks each snapshot
 * atomically, so a concurrent move/delete cannot put an old member back.
 * A restart must rebuild: an older binary may have written canonical state during rollback. */
const rebuilds = new WeakMap<RedisClient, Map<string, Promise<void>>>();

export function ensureThreadProjectIndex(
  redis: RedisClient,
  userId: string,
  loadIds: () => Promise<string[]>,
): Promise<void> {
  const users = rebuilds.get(redis) ?? new Map<string, Promise<void>>();
  rebuilds.set(redis, users);
  const existing = users.get(userId);
  if (existing) return existing;
  const pending = loadIds()
    .then((ids) => backfillThreadProjectMembers(redis, ids))
    .catch((error: unknown) => {
      users.delete(userId);
      throw error;
    });
  users.set(userId, pending);
  return pending;
}

export async function backfillThreadProjectMembers(redis: RedisClient, ids: readonly string[]): Promise<void> {
  for (let offset = 0; offset < ids.length; offset += 128) {
    const batch = ids.slice(offset, offset + 128);
    const reads = redis.pipeline();
    for (const id of batch) reads.hmget(ThreadKeys.detail(id), 'id', 'createdBy', 'projectPath');
    const replies = await reads.exec();
    const writes = redis.pipeline();
    for (let i = 0; i < batch.length; i++) {
      const reply = replies?.[i];
      if (!reply || reply[0]) throw reply?.[0] ?? new Error('Incomplete thread project index read');
      const [id, owner, rawProject] = reply[1] as Array<string | null>;
      if (!id || !owner) continue;
      const project = rawProject ?? 'default';
      writes.eval(BACKFILL_IF_CURRENT, 2, ThreadKeys.detail(id), threadProjectIndexKey(project), id, owner, project);
    }
    const written = await writes.exec();
    if (!written) throw new Error('Incomplete thread project backfill');
    for (const reply of written) if (reply[0]) throw reply[0];
  }
}

const MOVE_PROJECT = `
if redis.call('HEXISTS', KEYS[1], 'id') == 0 then return 1 end
if (redis.call('HGET', KEYS[1], 'projectPath') or 'default') ~= ARGV[2]
  or (redis.call('HGET', KEYS[1], 'createdBy') or '') ~= ARGV[4] then return 0 end
redis.call('HSET', KEYS[1], 'projectPath', ARGV[3])
redis.call('SREM', KEYS[2], ARGV[1])
redis.call('SADD', KEYS[3], ARGV[1])
return 1
`;

export async function moveThreadProject(redis: RedisClient, threadId: string, projectPath: string): Promise<void> {
  const key = ThreadKeys.detail(threadId);
  for (let attempt = 0; attempt < 10; attempt++) {
    const [previous, owner] = await redis.hmget(key, 'projectPath', 'createdBy');
    if (owner === null) return;
    const oldProject = previous ?? 'default';
    const changed = await redis.eval(
      MOVE_PROJECT,
      3,
      key,
      threadProjectIndexKey(oldProject),
      threadProjectIndexKey(projectPath),
      threadId,
      oldProject,
      projectPath,
      owner,
    );
    if (changed === 1) return;
  }
  throw new Error(`Thread project changed concurrently: ${threadId}`);
}

/** Lightweight existence probe for an idle project: do not hydrate any history
 * body, participants, or memory just to return an empty active projection. */
export async function hasVisibleThreadProject(
  redis: RedisClient,
  userId: string,
  projectPath: string,
): Promise<boolean> {
  let cursor = '0';
  do {
    const [next, ids] = await redis.sscan(threadProjectIndexKey(projectPath), cursor, 'COUNT', 100);
    cursor = next;
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100);
      const pipeline = redis.pipeline();
      for (const id of batch) {
        pipeline.zscore(ThreadKeys.userList(userId), id);
        pipeline.hmget(
          ThreadKeys.detail(id),
          'id',
          'projectPath',
          'deletedAt',
          'externalRuntimeAnchorState',
          'createdBy',
        );
      }
      const replies = await pipeline.exec();
      for (let i = 0; i < batch.length; i++) {
        const membership = replies?.[2 * i];
        const detail = replies?.[2 * i + 1];
        if (!membership || !detail || membership[0] || detail[0])
          throw membership?.[0] ?? detail?.[0] ?? new Error('Incomplete project existence read');
        if (membership[1] !== null && typeof membership[1] !== 'string')
          throw new Error('Invalid project visibility score');
        const [id, path, deletedAt, anchor, owner] = detail[1] as Array<string | null>;
        if (
          membership[1] !== null &&
          id &&
          (path ?? 'default') === projectPath &&
          !Number(deletedAt) &&
          !anchor &&
          (owner === userId || owner === 'system')
        )
          return true;
      }
    }
  } while (cursor !== '0');
  return false;
}

const INDEX_FOR_USER = `
if redis.call('HEXISTS', KEYS[1], 'id') == 0 then return 1 end
if (redis.call('HGET', KEYS[1], 'projectPath') or 'default') ~= ARGV[2] then return 0 end
local score = redis.call('HGET', KEYS[1], 'lastActiveAt') or ARGV[3]
redis.call('ZADD', KEYS[2], score, ARGV[1])
redis.call('SADD', KEYS[3], ARGV[1])
return 1
`;

/** Visibility and project discovery appear atomically, including legacy system
 * records indexed while the user's initial backfill is in flight. */
export async function indexThreadProjectForUser(redis: RedisClient, threadId: string, userId: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const project = (await redis.hget(ThreadKeys.detail(threadId), 'projectPath')) ?? 'default';
    const result = await redis.eval(
      INDEX_FOR_USER,
      3,
      ThreadKeys.detail(threadId),
      ThreadKeys.userList(userId),
      threadProjectIndexKey(project),
      threadId,
      project,
      String(Date.now()),
    );
    if (result === 1) return;
  }
  throw new Error(`Thread project changed while indexing visibility: ${threadId}`);
}
