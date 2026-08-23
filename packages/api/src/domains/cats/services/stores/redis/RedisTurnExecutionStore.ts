import type { RedisClient } from '@cat-cafe/shared/utils';
import {
  assertCoveredMessageIds,
  assertCreateTurnExecutionInput,
  assertTurnExecutionTerminalInput,
  type BindCoveredMessageIdsResult,
  type CreateTurnExecutionInput,
  type CreateTurnExecutionResult,
  cloneTurnExecutionRecord,
  type InterruptRunningTurnExecutionsInput,
  type ITurnExecutionStore,
  serializeTurnExecutionIdentity,
  type TransitionTurnExecutionResult,
  type TurnExecutionRecord,
  type TurnExecutionTerminalInput,
} from '../ports/TurnExecutionStore.js';
import { TurnExecutionKeys } from '../redis-keys/turn-execution-keys.js';
import { readAuthoritativeHash } from './redis-pipeline-reply.js';
import { hydrateTurnExecution, type RedisTurnExecutionHash, sortTurnExecutions } from './turn-execution-redis-codec.js';
import {
  BIND_TURN_EXECUTION_COVERAGE_LUA,
  CREATE_TURN_EXECUTION_LUA,
  TERMINALIZE_TURN_EXECUTION_LUA,
} from './turn-execution-redis-scripts.js';

export class RedisTurnExecutionStore implements ITurnExecutionStore {
  constructor(private readonly redis: RedisClient) {}

  async createRunning(input: CreateTurnExecutionInput): Promise<CreateTurnExecutionResult> {
    assertCreateTurnExecutionInput(input);
    const result = Number(
      await this.redis.eval(
        CREATE_TURN_EXECUTION_LUA,
        3,
        TurnExecutionKeys.record(input.invocationId),
        TurnExecutionKeys.parent(input.parentInvocationId),
        TurnExecutionKeys.running,
        serializeTurnExecutionIdentity(input),
        input.invocationId,
        input.parentInvocationId,
        input.threadId,
        input.userId,
        input.catId as string,
        input.executionKind,
        String(input.startedAt),
        JSON.stringify(input.causal ?? {}),
      ),
    );
    if (result === -1) {
      throw new Error(`corrupt turn execution record already exists: ${input.invocationId}`);
    }
    const record = await this.get(input.invocationId);
    if (!record) throw new Error(`turn execution create lost record ${input.invocationId}`);
    return { outcome: result === 1 ? 'created' : result === 2 ? 'replayed' : 'conflict', record };
  }

  async bindCoveredMessageIds(
    invocationId: string,
    messageIds: readonly string[],
  ): Promise<BindCoveredMessageIdsResult> {
    assertCoveredMessageIds(messageIds);
    const before = await this.get(invocationId);
    if (!before) return { outcome: 'not_found', record: null };
    const existing = before.causal?.coveredMessageIds;
    if (existing) {
      const expected = [...messageIds].sort();
      const same =
        existing.length === expected.length && [...existing].sort().every((id, index) => id === expected[index]);
      return { outcome: same ? 'replayed' : 'conflict', record: before };
    }
    const requested = [...messageIds];
    const next = {
      ...before,
      causal: { ...(before.causal ?? {}), coveredMessageIds: requested },
    };
    const result = Number(
      await this.redis.eval(
        BIND_TURN_EXECUTION_COVERAGE_LUA,
        1,
        TurnExecutionKeys.record(invocationId),
        JSON.stringify(requested),
        serializeTurnExecutionIdentity(next),
      ),
    );
    const record = await this.get(invocationId);
    if (result === -1 || !record) return { outcome: 'not_found', record: null };
    if (result === 1) return { outcome: 'bound', record };
    if (result === 2) return { outcome: 'replayed', record };
    const current = record.causal?.coveredMessageIds;
    const same =
      current?.length === requested.length && [...current].sort().every((id, index) => id === requested[index]);
    return { outcome: same ? 'replayed' : 'conflict', record };
  }

  async get(invocationId: string): Promise<TurnExecutionRecord | null> {
    const data = (await this.redis.hgetall(TurnExecutionKeys.record(invocationId))) as RedisTurnExecutionHash;
    if (Object.keys(data).length === 0) return null;
    const record = hydrateTurnExecution(data);
    if (!record) throw new Error(`corrupt turn execution record: ${invocationId}`);
    return cloneTurnExecutionRecord(record);
  }

  async listByParent(parentInvocationId: string): Promise<TurnExecutionRecord[]> {
    const childIds = await this.redis.smembers(TurnExecutionKeys.parent(parentInvocationId));
    if (childIds.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const invocationId of childIds) pipeline.hgetall(TurnExecutionKeys.record(invocationId));
    const results = await pipeline.exec();
    const records: TurnExecutionRecord[] = [];
    for (let index = 0; index < childIds.length; index += 1) {
      const [error, data] = results?.[index] ?? [];
      const invocationId = childIds[index];
      if (error) throw error;
      const hash = data as RedisTurnExecutionHash | undefined;
      if (!hash || Object.keys(hash).length === 0) {
        throw new Error(`turn execution parent index references missing record: ${invocationId}`);
      }
      const record = hydrateTurnExecution(hash);
      if (!record || record.parentInvocationId !== parentInvocationId) {
        throw new Error(`corrupt turn execution record: ${invocationId}`);
      }
      records.push(record);
    }
    return sortTurnExecutions(records).map(cloneTurnExecutionRecord);
  }

  async transitionTerminal(
    invocationId: string,
    input: TurnExecutionTerminalInput,
  ): Promise<TransitionTurnExecutionResult> {
    const before = await this.get(invocationId);
    if (!before) return { outcome: 'not_found', record: null };
    assertTurnExecutionTerminalInput(before, input);
    const result = Number(
      await this.redis.eval(
        TERMINALIZE_TURN_EXECUTION_LUA,
        2,
        TurnExecutionKeys.record(invocationId),
        TurnExecutionKeys.running,
        input.status,
        String(input.endedAt),
        input.terminalReason ?? '',
        invocationId,
      ),
    );
    const record = await this.get(invocationId);
    if (result === -1 || !record) return { outcome: 'not_found', record: null };
    return { outcome: result === 1 ? 'transitioned' : 'already_terminal', record };
  }

  /**
   * F297 (PR #3748 R3 P1-2): user-scoped running children，read-only 投影。
   *
   * 复用既有的全局 `TurnExecutionKeys.running` 集合 + 一次 pipeline。
   *
   * 这里不需要 per-user 索引，理由是**本模块自己成立的**，不再挂靠 `listRunningThreadIds`
   * 的取舍——后者已被 cloud R7 P2 推翻并改成 per-user 索引。此处成立是因为：该全局 set 可
   * 直接寻址（SMEMBERS，不是 `SCAN MATCH`），成本随**在跑的 child 数**增长，而不随整个
   * keyspace；running child 天然是小集合。
   * 刻意**不做 srem 清理**：本方法是观测路径，stale 成员由 `interruptRunningBefore` 的
   * 清扫路径负责；观测路径写终态正是 F297 一直在防的那类越权。
   */
  async listRunningByUser(userId: string): Promise<TurnExecutionRecord[]> {
    const childIds = await this.redis.smembers(TurnExecutionKeys.running);
    if (childIds.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const invocationId of childIds) pipeline.hgetall(TurnExecutionKeys.record(invocationId));
    const results = await pipeline.exec();
    const records: TurnExecutionRecord[] = [];
    for (let index = 0; index < childIds.length; index += 1) {
      const invocationId = childIds[index];
      // 判据收口到 readAuthoritativeHash（R10 P1-1）：null / 非 plain object / 短 reply
      // 以前都被 `!hash` 或 `typeof === 'object'` 静默降成空。
      const hash = readAuthoritativeHash(results?.[index], `turn execution ${invocationId}`);
      // 权威空：记录已不存在 ⇒ running set 里的 stale 成员，跳过即可。
      if (hash === null) continue;
      const record = hydrateTurnExecution(hash as RedisTurnExecutionHash);
      // 非空却 hydrate 不出来 = 损坏，属未知，**不得**降成"没在跑"。
      if (!record) throw new Error(`turn execution ${invocationId}: non-empty hash failed to hydrate`);
      // 合法 terminal / 非本人 scope 才是可证明的非 live。
      if (record.status !== 'running' || record.userId !== userId) continue;
      records.push(cloneTurnExecutionRecord(record));
    }
    return sortTurnExecutions(records);
  }

  async interruptRunningBefore(
    cutoffStartedAt: number,
    input: InterruptRunningTurnExecutionsInput,
  ): Promise<TurnExecutionRecord[]> {
    if (!Number.isFinite(cutoffStartedAt) || cutoffStartedAt < 0) {
      throw new Error('cutoffStartedAt must be a finite non-negative number');
    }
    const childIds = await this.redis.smembers(TurnExecutionKeys.running);
    const interrupted: TurnExecutionRecord[] = [];
    const excluded = new Set(input.excludedInvocationIds ?? []);
    for (const invocationId of childIds) {
      const record = await this.get(invocationId);
      if (!record || record.status !== 'running') {
        await this.redis.srem(TurnExecutionKeys.running, invocationId);
        continue;
      }
      if (record.startedAt >= cutoffStartedAt || excluded.has(invocationId)) continue;
      const result = await this.transitionTerminal(invocationId, {
        status: 'interrupted',
        endedAt: input.endedAt,
        terminalReason: input.terminalReason,
      });
      if (result.outcome === 'transitioned' && result.record) interrupted.push(result.record);
    }
    return sortTurnExecutions(interrupted).map(cloneTurnExecutionRecord);
  }
}
