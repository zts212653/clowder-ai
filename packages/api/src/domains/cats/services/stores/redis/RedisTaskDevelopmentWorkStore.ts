import type { DevelopmentScopeV1, TaskItem } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import {
  type DevelopmentSourceQuery,
  type DevelopmentWorkReceipt,
  type DevelopmentWorkResult,
  type DevelopmentWorkTransition,
  developmentActionKey,
  developmentScopeKey,
  developmentWorkIsOpen,
  hasDevelopmentSourceReceipt,
  matchesDevelopmentScope,
  type PreparedDevelopmentWork,
  prepareDevelopmentWorkTransition,
} from '../ports/DevelopmentWorkTransition.js';
import { TaskKeys } from '../redis-keys/task-keys.js';
import { hydrateTask, serializeTask } from './RedisTaskCodec.js';
import { runWithExclusiveRedisWatchSession } from './RedisWatchSession.js';

const receiptField = (input: DevelopmentWorkTransition) => `developmentAction:${developmentActionKey(input)}`;

/** Scope index is disposable; receipts stay with the Task hash without TTL. */
export class RedisTaskDevelopmentWorkStore {
  constructor(private readonly redis: RedisClient) {}

  async hasSource(query: DevelopmentSourceQuery): Promise<boolean> {
    const raw = await this.redis.hgetall(TaskKeys.detail(query.taskId));
    const receipts = Object.entries(raw).flatMap(([key, value]) =>
      key.startsWith('developmentAction:') ? [JSON.parse(value) as DevelopmentWorkReceipt] : [],
    );
    return hasDevelopmentSourceReceipt(raw.id ? hydrateTask(raw) : null, receipts, query);
  }

  private async readTask(redis: RedisClient, id: string): Promise<TaskItem | null> {
    const raw = await redis.hgetall(TaskKeys.detail(id));
    return raw.id ? hydrateTask(raw) : null;
  }

  private async readMatches(redis: RedisClient, userId: string, scope: DevelopmentScopeV1): Promise<TaskItem[]> {
    const index = TaskKeys.developmentScope(developmentScopeKey(userId, scope));
    const indexedId = await redis.get(index);
    if (indexedId) {
      await redis.watch(TaskKeys.detail(indexedId));
      const task = await this.readTask(redis, indexedId);
      if (task && matchesDevelopmentScope(task, userId, scope)) return [task];
    }
    // Reconstruct from the Task owner's existing kind index. Never infer from titles.
    await redis.watch(TaskKeys.kind('work'));
    const ids = await redis.zrange(TaskKeys.kind('work'), 0, -1);
    const matches: TaskItem[] = [];
    for (const id of ids) {
      const candidate = await this.readTask(redis, id);
      if (!candidate || !matchesDevelopmentScope(candidate, userId, scope)) continue;
      await redis.watch(TaskKeys.detail(id));
      const current = await this.readTask(redis, id);
      if (current && matchesDevelopmentScope(current, userId, scope)) matches.push(current);
    }
    return matches;
  }

  async find(userId: string, scope: DevelopmentScopeV1): Promise<TaskItem[]> {
    const key = TaskKeys.developmentScope(developmentScopeKey(userId, scope));
    for (let attempt = 0; attempt < 8; attempt++) {
      const result = await runWithExclusiveRedisWatchSession(this.redis, key, async (session) => {
        const matches = await this.readMatches(session, userId, scope);
        const open = matches.find(developmentWorkIsOpen);
        const tx = session.multi();
        if (open) tx.set(key, open.id);
        else tx.del(key);
        return (await tx.exec()) ? matches : null;
      });
      if (result) return result;
    }
    throw new Error('Development scope lookup contention; retry from current owner facts');
  }

  private async readTransitionContext(session: RedisClient, input: DevelopmentWorkTransition) {
    const scoped = await this.readMatches(session, input.actor.userId, input.scope);
    const lineage: TaskItem[] = [];
    for (const ref of [input.parentTaskRef, input.predecessorTaskRef]) {
      if (!ref) continue;
      const id = ref.slice('task:work:'.length);
      await session.watch(TaskKeys.detail(id));
      const task = await this.readTask(session, id);
      if (task) lineage.push(task);
    }
    let existing: TaskItem | null = null;
    if (input.taskId) {
      await session.watch(TaskKeys.detail(input.taskId));
      existing = await this.readTask(session, input.taskId);
    }
    const receiptTask = existing ?? scoped[0];
    const rawReceipt = receiptTask ? await session.hget(TaskKeys.detail(receiptTask.id), receiptField(input)) : null;
    const receipt = rawReceipt ? (JSON.parse(rawReceipt) as DevelopmentWorkReceipt) : null;

    return { scoped, lineage, existing, receipt };
  }

  private async commitTransition(
    session: RedisClient,
    scopeKey: string,
    input: DevelopmentWorkTransition,
    prepared: Extract<PreparedDevelopmentWork, { result: 'write' }>,
    existing: TaskItem | null,
  ): Promise<DevelopmentWorkResult | null> {
    const task = prepared.task;
    const key = TaskKeys.detail(task.id);
    if (!task.subjectKey) throw new Error('Prepared development Task requires a subject');
    const subjectKey = TaskKeys.subject(task.subjectKey);
    await session.watch(subjectKey, key);
    const subjectOwner = await session.get(subjectKey);
    if (subjectOwner && subjectOwner !== task.id) return { result: 'scope_conflict' } as const;
    if (!existing && (await session.exists(key))) return null;
    const tx = session.multi();
    tx.hset(key, serializeTask(task));
    tx.hset(key, receiptField(input), JSON.stringify(prepared.receipt));
    tx.persist(key);
    tx.set(subjectKey, task.id);
    tx.set(scopeKey, task.id);
    tx.zadd(TaskKeys.thread(task.threadId), task.createdAt, task.id);
    tx.persist(TaskKeys.thread(task.threadId));
    tx.zadd(TaskKeys.kind(task.kind), task.createdAt, task.id);
    if (!(await tx.exec())) return null;
    return { result: prepared.receipt.result, task, receiptRef: prepared.receipt.receiptRef };
  }

  async transition(input: DevelopmentWorkTransition): Promise<DevelopmentWorkResult> {
    const scopeKey = TaskKeys.developmentScope(developmentScopeKey(input.actor.userId, input.scope));
    for (let attempt = 0; attempt < 8; attempt++) {
      const result = await runWithExclusiveRedisWatchSession(this.redis, scopeKey, async (session) => {
        const { scoped, lineage, existing, receipt } = await this.readTransitionContext(session, input);
        const prepared = prepareDevelopmentWorkTransition(input, scoped, existing, receipt, lineage);
        if (prepared.result !== 'write') return prepared;
        return this.commitTransition(session, scopeKey, input, prepared, existing);
      });
      if (result) return result;
    }
    throw new Error('Development Task transition contention; retry from current owner facts');
  }
}
