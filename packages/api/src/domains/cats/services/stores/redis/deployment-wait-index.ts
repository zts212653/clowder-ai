import type { TaskItem } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { DeploymentRecoveryFacts, DeploymentWaitAudit } from '../ports/deployment-wait/recovery-facts.js';
import { TaskKeys } from '../redis-keys/task-keys.js';
import { TASK_DEPLOYMENT_RECOVERY_LUA } from './deployment-recovery-lua.js';
import { hydrateTask } from './RedisTaskCodec.js';

export { isDeploymentWaitProjectionCandidate } from '../ports/deployment-wait/live-candidate.js';

export const DEPLOYMENT_WAIT_INDEX = 'tasks:deployment-wait:live:due';
export const DEPLOYMENT_AUDIT_INDEX = 'tasks:deployment-wait:audit:due';
const COMPLETE = 'tasks:deployment-wait:census:v2';
const PROJECT = `${TASK_DEPLOYMENT_RECOVERY_LUA}
if redis.call('HGET', KEYS[1], 'id') then writeTaskRecovery(KEYS[1], {})
else
  local live, audit = recoveryKeys(KEYS[1], ARGV[1])
  redis.call('ZREM', live, ARGV[1]); redis.call('ZREM', audit, ARGV[1])
end
return 1`;

/** One census/rebuild. Facts and exact pending audit intents remain with each original Task. */
export async function initializeDeploymentWaitRecovery(redis: RedisClient, rebuild = false): Promise<void> {
  if (!rebuild && (await redis.get(COMPLETE)) === '1') return;
  if (rebuild) await redis.del(DEPLOYMENT_WAIT_INDEX, DEPLOYMENT_AUDIT_INDEX);
  const ids = await redis.zrange(TaskKeys.kind('work'), 0, -1);
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = redis.pipeline();
    for (const id of ids.slice(offset, offset + 100)) batch.eval(PROJECT, 1, TaskKeys.detail(id), id);
    for (const [error] of (await batch.exec()) ?? []) if (error) throw error;
  }
  await redis.set(COMPLETE, '1');
}

async function dueIds(redis: RedisClient, index: string, limit: number, now: number): Promise<string[]> {
  await initializeDeploymentWaitRecovery(redis);
  return redis.zrangebyscore(index, '-inf', now, 'LIMIT', 0, limit);
}

export async function listDueDeploymentWaitRecovery(
  redis: RedisClient,
  limit = 100,
  now = Date.now(),
): Promise<TaskItem[]> {
  const ids = await dueIds(redis, DEPLOYMENT_WAIT_INDEX, limit, now);
  const tasks: TaskItem[] = [];
  for (const id of ids) {
    await redis.eval(PROJECT, 1, TaskKeys.detail(id), id);
    const raw = await redis.hgetall(TaskKeys.detail(id));
    const facts = raw._deploymentRecovery ? (JSON.parse(raw._deploymentRecovery) as DeploymentRecoveryFacts) : null;
    if (facts?.live && !facts.live.disposition && facts.live.nextAt <= now) tasks.push(hydrateTask(raw));
  }
  return tasks;
}

export async function listDeploymentWaitAuditCandidates(
  redis: RedisClient,
  limit = 100,
  now = Date.now(),
): Promise<DeploymentWaitAudit[]> {
  const entries: DeploymentWaitAudit[] = [];
  for (const id of await dueIds(redis, DEPLOYMENT_AUDIT_INDEX, limit, now)) {
    const facts = await getDeploymentWaitRecoveryFacts(redis, id);
    for (const entry of Object.values(facts?.pending ?? {})) {
      if (!entry.disposition && entry.nextAt <= now) entries.push(entry);
      if (entries.length >= limit) return entries;
    }
  }
  return entries;
}

export async function getDeploymentWaitRecoveryFacts(
  redis: RedisClient,
  id: string,
): Promise<DeploymentRecoveryFacts | null> {
  const raw = await redis.hget(TaskKeys.detail(id), '_deploymentRecovery');
  return raw ? (JSON.parse(raw) as DeploymentRecoveryFacts) : null;
}

const MUTATE_METADATA = `${TASK_DEPLOYMENT_RECOVERY_LUA}
local id = redis.call('HGET', KEYS[1], 'id')
if not id then return 0 end
recoveryPreflight(KEYS[1], id)
local facts = recoveryFacts(KEYS[1])
local mode = ARGV[1]
if mode == 'live' then
  if not facts.live or facts.live.signature ~= ARGV[2] then return 0 end
  facts.live.nextAt = tonumber(ARGV[3])
  if ARGV[4] == '1' then facts.live.failures = facts.live.failures + 1 else facts.live.failures = 0 end
  if facts.live.failures >= 5 then facts.live.disposition = 'needs_attention' end
else
  local entry = facts.pending[ARGV[2]]
  if not entry or entry.token ~= ARGV[3] then return 0 end
  if mode == 'ack' then facts.pending[ARGV[2]] = nil
  elseif mode == 'fail' then
    if entry.failures ~= tonumber(ARGV[5]) or entry.nextAt ~= tonumber(ARGV[6]) then return 0 end
    entry.failures = entry.failures + 1
    entry.nextAt = tonumber(ARGV[4]) + 60000
    if entry.failures >= 5 then entry.disposition = 'needs_attention' end
  else return 0 end
end
projectRecovery(KEYS[1], id, facts)
return 1`;

export async function ackDeploymentWaitAudit(redis: RedisClient, entry: DeploymentWaitAudit): Promise<boolean> {
  return (
    Number(
      await redis.eval(MUTATE_METADATA, 1, TaskKeys.detail(entry.taskId), 'ack', entry.event.eventId, entry.token),
    ) === 1
  );
}
export async function failDeploymentWaitAudit(
  redis: RedisClient,
  entry: DeploymentWaitAudit,
  now: number,
): Promise<void> {
  await redis.eval(
    MUTATE_METADATA,
    1,
    TaskKeys.detail(entry.taskId),
    'fail',
    entry.event.eventId,
    entry.token,
    now,
    entry.failures,
    entry.nextAt,
  );
}
export async function finishDeploymentWaitRecovery(
  redis: RedisClient,
  task: TaskItem,
  now: number,
  failed: boolean,
): Promise<void> {
  await redis.eval(
    MUTATE_METADATA,
    1,
    TaskKeys.detail(task.id),
    'live',
    JSON.stringify(task.deploymentWait),
    now,
    failed ? '1' : '0',
  );
}

/** User projection lists live waits independently of recovery cadence/disposition. It is not a periodic selector. */
export async function listDeploymentWaitProjectionCandidates(redis: RedisClient): Promise<TaskItem[]> {
  await initializeDeploymentWaitRecovery(redis);
  const tasks: TaskItem[] = [];
  for (const id of await redis.smembers('tasks:deployment-wait:projection')) {
    const raw = await redis.hgetall(TaskKeys.detail(id));
    if (raw.id) tasks.push(hydrateTask(raw));
  }
  return tasks;
}
