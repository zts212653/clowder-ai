import type {
  RuntimeInteractionCardRef,
  RuntimeInteractionRecord,
  RuntimeInteractionStatus,
  RuntimeInteractionTerminal,
  RuntimeInteractionTerminalReasonCode,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { SettledIndexPreparingError } from '../../../utils/redis-settled-index.js';
import type {
  ClaimRuntimeInteractionSubmissionInput,
  CompleteRuntimeInteractionSubmissionInput,
  CreateRuntimeInteractionInput,
  InvalidateRuntimeInteractionInput,
  RuntimeInteractionPendingIndexRead,
  RuntimeInteractionStore,
  SettleConversationInteractionInput,
  SettleRuntimeInteractionInput,
} from '../ports/RuntimeInteractionStore.js';
import { bindingsForRuntimeInteraction, normalizeRuntimeInteractionRecord } from '../RuntimeInteractionRecordModel.js';
import {
  ANCHOR_LUA,
  CLAIM_SUBMISSION_LUA,
  COMPLETE_SUBMISSION_LUA,
  CREATE_STAGED_LUA,
  INVALIDATE_LUA,
  SETTLE_CONVERSATION_LUA,
  SETTLE_LUA,
} from './redis-runtime-interaction-scripts.js';
import { advanceRuntimeHistoryIndex, runtimeSettledKey } from './runtime-history-index.js';

export const RuntimeInteractionKeys = {
  detail: (interactionId: string) => `runtime-interaction:${interactionId}`,
  active: () => 'runtime-interaction:active',
  settledByUser: runtimeSettledKey,
  pendingByUser: (userId: string) => `runtime-interaction:user:${userId}:pending`,
  activeByInvocation: (invocationId: string) => `runtime-interaction:invocation:${invocationId}:active`,
} as const;

export class RedisRuntimeInteractionStore implements RuntimeInteractionStore {
  constructor(private readonly redis: RedisClient) {}

  async createStaged(input: CreateRuntimeInteractionInput): Promise<RuntimeInteractionRecord> {
    const derived = bindingsForRuntimeInteraction(input.request);
    const record: RuntimeInteractionRecord = {
      request: structuredClone(input.request),
      source: structuredClone(derived.source),
      returnBinding: structuredClone(derived.returnBinding),
      status: 'staged',
      hostEpoch: input.hostEpoch,
      revision: 1,
      updatedAt: input.now,
    };
    const created = await this.redis.eval(
      CREATE_STAGED_LUA,
      3,
      RuntimeInteractionKeys.detail(input.request.interactionId),
      RuntimeInteractionKeys.active(),
      RuntimeInteractionKeys.activeByInvocation(input.request.owner.invocationId),
      JSON.stringify(record.request),
      record.hostEpoch,
      String(record.updatedAt),
      input.request.interactionId,
      record.returnBinding.kind === 'provider_waiter' ? '1' : '0',
      JSON.stringify(record.source),
      JSON.stringify(record.returnBinding),
    );
    if (Number(created) === -1) {
      throw new Error(`active interaction already exists for invocation: ${input.request.owner.invocationId}`);
    }
    if (Number(created) !== 1) {
      throw new Error(`runtime interaction already exists: ${input.request.interactionId}`);
    }
    return record;
  }

  async anchor(
    interactionId: string,
    hostEpoch: string,
    cardRef: RuntimeInteractionCardRef,
    now: number,
    expectedRevision?: number,
  ): Promise<RuntimeInteractionRecord | null> {
    const existing = await this.get(interactionId);
    if (!existing) return null;
    const transitioned = await this.redis.eval(
      ANCHOR_LUA,
      2,
      RuntimeInteractionKeys.detail(interactionId),
      RuntimeInteractionKeys.pendingByUser(existing.request.owner.userId),
      hostEpoch,
      JSON.stringify(cardRef),
      String(now),
      String(existing.request.createdAt),
      interactionId,
      expectedRevision === undefined ? '' : String(expectedRevision),
    );
    return Number(transitioned) === 1 ? this.get(interactionId) : null;
  }

  async settle(input: SettleRuntimeInteractionInput): Promise<RuntimeInteractionRecord | null> {
    const existing = await this.get(input.interactionId);
    if (!existing) return null;
    const transitioned = await this.redis.eval(
      SETTLE_LUA,
      5,
      RuntimeInteractionKeys.detail(input.interactionId),
      RuntimeInteractionKeys.pendingByUser(existing.request.owner.userId),
      RuntimeInteractionKeys.active(),
      RuntimeInteractionKeys.activeByInvocation(existing.request.owner.invocationId),
      runtimeSettledKey(existing.request.owner.userId),
      input.hostEpoch,
      input.terminal.status,
      JSON.stringify(input.terminal),
      String(input.now),
      input.interactionId,
      input.expectedRevision === undefined ? '' : String(input.expectedRevision),
    );
    return Number(transitioned) === 1 ? this.get(input.interactionId) : null;
  }

  async claimSubmission(input: ClaimRuntimeInteractionSubmissionInput): Promise<RuntimeInteractionRecord | null> {
    const transitioned = await this.redis.eval(
      CLAIM_SUBMISSION_LUA,
      1,
      RuntimeInteractionKeys.detail(input.interactionId),
      String(input.expectedRevision),
      JSON.stringify(input.submission),
      String(input.now),
    );
    return Number(transitioned) === 1 ? this.get(input.interactionId) : null;
  }

  async completeSubmission(input: CompleteRuntimeInteractionSubmissionInput): Promise<RuntimeInteractionRecord | null> {
    const existing = await this.get(input.interactionId);
    if (!existing) return null;
    const transitioned = await this.redis.eval(
      COMPLETE_SUBMISSION_LUA,
      5,
      RuntimeInteractionKeys.detail(input.interactionId),
      RuntimeInteractionKeys.pendingByUser(existing.request.owner.userId),
      RuntimeInteractionKeys.active(),
      RuntimeInteractionKeys.activeByInvocation(existing.request.owner.invocationId),
      runtimeSettledKey(existing.request.owner.userId),
      String(input.expectedRevision),
      input.operationId,
      input.terminal.status,
      JSON.stringify(input.terminal),
      String(input.now),
      input.interactionId,
    );
    return Number(transitioned) === 1 ? this.get(input.interactionId) : null;
  }

  async settleConversation(input: SettleConversationInteractionInput): Promise<RuntimeInteractionRecord | null> {
    const existing = await this.get(input.interactionId);
    if (!existing) return null;
    const transitioned = await this.redis.eval(
      SETTLE_CONVERSATION_LUA,
      5,
      RuntimeInteractionKeys.detail(input.interactionId),
      RuntimeInteractionKeys.pendingByUser(existing.request.owner.userId),
      RuntimeInteractionKeys.active(),
      RuntimeInteractionKeys.activeByInvocation(existing.request.owner.invocationId),
      runtimeSettledKey(existing.request.owner.userId),
      String(input.expectedRevision),
      input.terminal.status,
      JSON.stringify(input.terminal),
      String(input.now),
      input.interactionId,
    );
    return Number(transitioned) === 1 ? this.get(input.interactionId) : null;
  }

  async invalidate(input: InvalidateRuntimeInteractionInput): Promise<RuntimeInteractionRecord | null> {
    const existing = await this.get(input.interactionId);
    if (!existing || (input.expectedRevision !== undefined && existing.revision !== input.expectedRevision))
      return null;
    return this.invalidateKnown(existing, input.reasonCode, input.now);
  }

  async invalidateByInvocation(
    invocationId: string,
    reasonCode: RuntimeInteractionTerminalReasonCode,
    now: number,
  ): Promise<RuntimeInteractionRecord[]> {
    const ids = await this.redis.smembers(RuntimeInteractionKeys.activeByInvocation(invocationId));
    const records = await this.readMany(ids);
    return this.invalidateRecords(records, reasonCode, now);
  }

  async invalidateActiveFromOtherHostEpoch(
    hostEpoch: string,
    reasonCode: RuntimeInteractionTerminalReasonCode,
    now: number,
  ): Promise<RuntimeInteractionRecord[]> {
    const ids = await this.redis.smembers(RuntimeInteractionKeys.active());
    const records = (await this.readMany(ids)).filter(
      (record) => record.returnBinding.kind === 'provider_waiter' && record.hostEpoch !== hostEpoch,
    );
    return this.invalidateRecords(records, reasonCode, now);
  }

  async get(interactionId: string): Promise<RuntimeInteractionRecord | null> {
    return parseRecord(await this.redis.hgetall(RuntimeInteractionKeys.detail(interactionId)));
  }

  async listActive(): Promise<RuntimeInteractionRecord[]> {
    return this.readMany(await this.redis.smembers(RuntimeInteractionKeys.active()));
  }

  async readPendingIndexByUser(userId: string): Promise<RuntimeInteractionPendingIndexRead> {
    const ids = await this.redis.zrevrange(RuntimeInteractionKeys.pendingByUser(userId), 0, -1);
    return this.readManyWithCoverage(ids);
  }

  async listPendingByUser(userId: string): Promise<RuntimeInteractionRecord[]> {
    const read = await this.readPendingIndexByUser(userId);
    if (read.exhaustiveness !== 'complete') {
      throw new Error('runtime interaction pending index read was incomplete');
    }
    return read.records.filter((record) => record.status === 'pending' && record.request.owner.userId === userId);
  }

  /** Owner index bounds ordinary reads; legacy discovery advances one bounded, resumable batch. */
  async listSettledByUser(userId: string, limit: number): Promise<RuntimeInteractionRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('invalid runtime history limit');
    if (!(await advanceRuntimeHistoryIndex(this.redis, parseRecord))) throw new SettledIndexPreparingError();
    const ids = await this.redis.zrevrange(runtimeSettledKey(userId), 0, limit - 1);
    return (await this.readMany(ids)).filter(
      (record) =>
        record.request.owner.userId === userId &&
        record.cardRef &&
        record.terminal &&
        record.status !== 'pending' &&
        record.status !== 'staged',
    );
  }

  private async invalidateRecords(
    records: RuntimeInteractionRecord[],
    reasonCode: RuntimeInteractionTerminalReasonCode,
    now: number,
  ): Promise<RuntimeInteractionRecord[]> {
    const results = await Promise.all(records.map((record) => this.invalidateKnown(record, reasonCode, now)));
    return results.filter((record): record is RuntimeInteractionRecord => record !== null);
  }

  private async invalidateKnown(
    existing: RuntimeInteractionRecord,
    reasonCode: RuntimeInteractionTerminalReasonCode,
    now: number,
  ): Promise<RuntimeInteractionRecord | null> {
    const terminal: RuntimeInteractionTerminal = { status: 'invalidated', reasonCode, settledAt: now };
    const id = existing.request.interactionId;
    const transitioned = await this.redis.eval(
      INVALIDATE_LUA,
      5,
      RuntimeInteractionKeys.detail(id),
      RuntimeInteractionKeys.pendingByUser(existing.request.owner.userId),
      RuntimeInteractionKeys.active(),
      RuntimeInteractionKeys.activeByInvocation(existing.request.owner.invocationId),
      runtimeSettledKey(existing.request.owner.userId),
      JSON.stringify(terminal),
      String(now),
      id,
      String(existing.revision),
    );
    return Number(transitioned) === 1 ? this.get(id) : null;
  }

  private async readMany(ids: string[]): Promise<RuntimeInteractionRecord[]> {
    const read = await this.readManyWithCoverage(ids);
    if (read.exhaustiveness !== 'complete') {
      throw new Error('runtime interaction detail read was incomplete');
    }
    return read.records;
  }

  private async readManyWithCoverage(ids: string[]): Promise<RuntimeInteractionPendingIndexRead> {
    if (ids.length === 0) return { records: [], exhaustiveness: 'complete' };
    const pipeline = this.redis.multi();
    for (const id of ids) pipeline.hgetall(RuntimeInteractionKeys.detail(id));
    const results = await pipeline.exec();
    if (!results) return { records: [], exhaustiveness: 'partial' };
    let complete = results.length === ids.length;
    const records: RuntimeInteractionRecord[] = [];
    for (const [index, id] of ids.entries()) {
      const record = parseBatchRecord(id, results[index]);
      if (!record) {
        complete = false;
        continue;
      }
      records.push(record);
    }
    return { records, exhaustiveness: complete ? 'complete' : 'partial' };
  }
}

function parseBatchRecord(interactionId: string, result: unknown): RuntimeInteractionRecord | null {
  const raw = Array.isArray(result) && result[0] === null ? result[1] : undefined;
  try {
    const record =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? parseRecord(raw as Record<string, string>) : null;
    return record?.request.interactionId === interactionId ? record : null;
  } catch {
    return null;
  }
}

function parseRecord(raw: Record<string, string>): RuntimeInteractionRecord | null {
  if (!raw.request || !raw.status || !raw.hostEpoch || !raw.updatedAt) return null;
  return normalizeRuntimeInteractionRecord({
    request: JSON.parse(raw.request) as unknown,
    status: raw.status as RuntimeInteractionStatus,
    hostEpoch: raw.hostEpoch,
    ...(raw.source ? { source: JSON.parse(raw.source) as RuntimeInteractionRecord['source'] } : {}),
    ...(raw.returnBinding
      ? { returnBinding: JSON.parse(raw.returnBinding) as RuntimeInteractionRecord['returnBinding'] }
      : {}),
    ...(raw.revision ? { revision: Number(raw.revision) } : {}),
    ...(raw.cardRef ? { cardRef: JSON.parse(raw.cardRef) as RuntimeInteractionCardRef } : {}),
    ...(raw.submission ? { submission: JSON.parse(raw.submission) as RuntimeInteractionRecord['submission'] } : {}),
    ...(raw.terminal ? { terminal: JSON.parse(raw.terminal) as RuntimeInteractionTerminal } : {}),
    updatedAt: Number(raw.updatedAt),
  });
}
