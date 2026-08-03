import type { RedisClient } from '@cat-cafe/shared/utils';
import {
  assertCreateTurnExecutionInput,
  assertTurnExecutionTerminalInput,
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
import { hydrateTurnExecution, type RedisTurnExecutionHash, sortTurnExecutions } from './turn-execution-redis-codec.js';
import { CREATE_TURN_EXECUTION_LUA, TERMINALIZE_TURN_EXECUTION_LUA } from './turn-execution-redis-scripts.js';

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

  async interruptRunningBefore(
    cutoffStartedAt: number,
    input: InterruptRunningTurnExecutionsInput,
  ): Promise<TurnExecutionRecord[]> {
    if (!Number.isFinite(cutoffStartedAt) || cutoffStartedAt < 0) {
      throw new Error('cutoffStartedAt must be a finite non-negative number');
    }
    const childIds = await this.redis.smembers(TurnExecutionKeys.running);
    const interrupted: TurnExecutionRecord[] = [];
    for (const invocationId of childIds) {
      const record = await this.get(invocationId);
      if (!record || record.status !== 'running') {
        await this.redis.srem(TurnExecutionKeys.running, invocationId);
        continue;
      }
      if (record.startedAt >= cutoffStartedAt) continue;
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
