import type {
  RuntimeInteractionCardRef,
  RuntimeInteractionRecord,
  RuntimeInteractionTerminalReasonCode,
} from '@cat-cafe/shared';
import type {
  CreateRuntimeInteractionInput,
  InvalidateRuntimeInteractionInput,
  RuntimeInteractionStore,
  SettleRuntimeInteractionInput,
} from '../ports/RuntimeInteractionStore.js';

export class InMemoryRuntimeInteractionStore implements RuntimeInteractionStore {
  private readonly records = new Map<string, RuntimeInteractionRecord>();

  async createStaged(input: CreateRuntimeInteractionInput): Promise<RuntimeInteractionRecord> {
    const id = input.request.interactionId;
    if (this.records.has(id)) throw new Error(`runtime interaction already exists: ${id}`);
    const record: RuntimeInteractionRecord = {
      request: structuredClone(input.request),
      status: 'staged',
      hostEpoch: input.hostEpoch,
      updatedAt: input.now,
    };
    this.records.set(id, record);
    return clone(record);
  }

  async anchor(
    interactionId: string,
    hostEpoch: string,
    cardRef: RuntimeInteractionCardRef,
    now: number,
  ): Promise<RuntimeInteractionRecord | null> {
    const record = this.records.get(interactionId);
    if (!record || record.status !== 'staged' || record.hostEpoch !== hostEpoch) return null;
    const anchored: RuntimeInteractionRecord = {
      ...record,
      status: 'pending',
      cardRef: structuredClone(cardRef),
      updatedAt: now,
    };
    this.records.set(interactionId, anchored);
    return clone(anchored);
  }

  async settle(input: SettleRuntimeInteractionInput): Promise<RuntimeInteractionRecord | null> {
    const record = this.records.get(input.interactionId);
    if (!record || record.status !== 'pending' || record.hostEpoch !== input.hostEpoch) return null;
    const settled: RuntimeInteractionRecord = {
      ...record,
      status: input.terminal.status,
      terminal: structuredClone(input.terminal),
      updatedAt: input.now,
    };
    this.records.set(input.interactionId, settled);
    return clone(settled);
  }

  async invalidate(input: InvalidateRuntimeInteractionInput): Promise<RuntimeInteractionRecord | null> {
    const record = this.records.get(input.interactionId);
    if (!record || !isActive(record)) return null;
    const invalidated = invalidatedRecord(record, input.reasonCode, input.now);
    this.records.set(input.interactionId, invalidated);
    return clone(invalidated);
  }

  async invalidateByInvocation(
    invocationId: string,
    reasonCode: RuntimeInteractionTerminalReasonCode,
    now: number,
  ): Promise<RuntimeInteractionRecord[]> {
    return this.invalidateMatching((record) => record.request.owner.invocationId === invocationId, reasonCode, now);
  }

  async invalidateActiveFromOtherHostEpoch(
    hostEpoch: string,
    reasonCode: RuntimeInteractionTerminalReasonCode,
    now: number,
  ): Promise<RuntimeInteractionRecord[]> {
    return this.invalidateMatching((record) => record.hostEpoch !== hostEpoch, reasonCode, now);
  }

  async get(interactionId: string): Promise<RuntimeInteractionRecord | null> {
    const record = this.records.get(interactionId);
    return record ? clone(record) : null;
  }

  async listPendingByUser(userId: string): Promise<RuntimeInteractionRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.status === 'pending' && record.request.owner.userId === userId)
      .sort((left, right) => right.request.createdAt - left.request.createdAt)
      .map(clone);
  }

  private invalidateMatching(
    predicate: (record: RuntimeInteractionRecord) => boolean,
    reasonCode: RuntimeInteractionTerminalReasonCode,
    now: number,
  ): RuntimeInteractionRecord[] {
    const invalidated: RuntimeInteractionRecord[] = [];
    for (const [id, record] of this.records) {
      if (!isActive(record) || !predicate(record)) continue;
      const next = invalidatedRecord(record, reasonCode, now);
      this.records.set(id, next);
      invalidated.push(clone(next));
    }
    return invalidated;
  }
}

function isActive(record: RuntimeInteractionRecord): boolean {
  return record.status === 'staged' || record.status === 'pending';
}

function invalidatedRecord(
  record: RuntimeInteractionRecord,
  reasonCode: RuntimeInteractionTerminalReasonCode,
  now: number,
): RuntimeInteractionRecord {
  return {
    ...record,
    status: 'invalidated',
    terminal: { status: 'invalidated', reasonCode, settledAt: now },
    updatedAt: now,
  };
}

function clone(record: RuntimeInteractionRecord): RuntimeInteractionRecord {
  return structuredClone(record);
}
