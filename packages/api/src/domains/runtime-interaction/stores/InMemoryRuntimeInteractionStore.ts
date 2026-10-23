import type {
  RuntimeInteractionCardRef,
  RuntimeInteractionRecord,
  RuntimeInteractionTerminalReasonCode,
} from '@cat-cafe/shared';
import type {
  ClaimRuntimeInteractionSubmissionInput,
  CompleteRuntimeInteractionSubmissionInput,
  CreateRuntimeInteractionInput,
  InvalidateRuntimeInteractionInput,
  RuntimeInteractionStore,
  SettleConversationInteractionInput,
  SettleRuntimeInteractionInput,
} from '../ports/RuntimeInteractionStore.js';
import {
  bindingsForRuntimeInteraction,
  isConversationRuntimeInteraction,
  isProviderRuntimeInteraction,
  isRuntimeInteractionActive,
} from '../RuntimeInteractionRecordModel.js';

export class InMemoryRuntimeInteractionStore implements RuntimeInteractionStore {
  private readonly records = new Map<string, RuntimeInteractionRecord>();

  async createStaged(input: CreateRuntimeInteractionInput): Promise<RuntimeInteractionRecord> {
    const id = input.request.interactionId;
    if (this.records.has(id)) throw new Error(`runtime interaction already exists: ${id}`);
    const bindings = bindingsForRuntimeInteraction(input.request);
    const invocationId = input.request.owner.invocationId;
    if (
      bindings.returnBinding.kind === 'provider_waiter' &&
      [...this.records.values()].some(
        (record) =>
          isRuntimeInteractionActive(record) &&
          isProviderRuntimeInteraction(record) &&
          record.request.owner.invocationId === invocationId,
      )
    ) {
      throw new Error(`active interaction already exists for invocation: ${invocationId}`);
    }
    const record: RuntimeInteractionRecord = {
      request: structuredClone(input.request),
      source: structuredClone(bindings.source),
      returnBinding: structuredClone(bindings.returnBinding),
      status: 'staged',
      hostEpoch: input.hostEpoch,
      revision: 1,
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
    expectedRevision?: number,
  ): Promise<RuntimeInteractionRecord | null> {
    const record = this.records.get(interactionId);
    if (
      !record ||
      record.status !== 'staged' ||
      (record.hostEpoch !== hostEpoch && !isConversationRuntimeInteraction(record)) ||
      (expectedRevision !== undefined && record.revision !== expectedRevision)
    )
      return null;
    const anchored: RuntimeInteractionRecord = {
      ...record,
      status: 'pending',
      hostEpoch,
      cardRef: structuredClone(cardRef),
      revision: record.revision + 1,
      updatedAt: now,
    };
    this.records.set(interactionId, anchored);
    return clone(anchored);
  }

  async settle(input: SettleRuntimeInteractionInput): Promise<RuntimeInteractionRecord | null> {
    const record = this.records.get(input.interactionId);
    if (
      !record ||
      record.status !== 'pending' ||
      !isProviderRuntimeInteraction(record) ||
      record.hostEpoch !== input.hostEpoch ||
      (input.expectedRevision !== undefined && record.revision !== input.expectedRevision)
    )
      return null;
    const settled: RuntimeInteractionRecord = {
      ...record,
      status: input.terminal.status,
      terminal: structuredClone(input.terminal),
      revision: record.revision + 1,
      updatedAt: input.now,
    };
    this.records.set(input.interactionId, settled);
    return clone(settled);
  }

  async claimSubmission(input: ClaimRuntimeInteractionSubmissionInput): Promise<RuntimeInteractionRecord | null> {
    const record = this.records.get(input.interactionId);
    if (
      !record ||
      record.status !== 'pending' ||
      !isConversationRuntimeInteraction(record) ||
      record.submission ||
      record.revision !== input.expectedRevision
    )
      return null;
    const claimed: RuntimeInteractionRecord = {
      ...record,
      submission: structuredClone(input.submission),
      revision: record.revision + 1,
      updatedAt: input.now,
    };
    this.records.set(input.interactionId, claimed);
    return clone(claimed);
  }

  async completeSubmission(input: CompleteRuntimeInteractionSubmissionInput): Promise<RuntimeInteractionRecord | null> {
    const record = this.records.get(input.interactionId);
    if (
      !record ||
      record.status !== 'pending' ||
      !isConversationRuntimeInteraction(record) ||
      record.revision !== input.expectedRevision ||
      record.submission?.operationId !== input.operationId
    )
      return null;
    const settled: RuntimeInteractionRecord = {
      ...record,
      status: input.terminal.status,
      terminal: structuredClone(input.terminal),
      revision: record.revision + 1,
      updatedAt: input.now,
    };
    delete (settled as { submission?: unknown }).submission;
    this.records.set(input.interactionId, settled);
    return clone(settled);
  }

  async settleConversation(input: SettleConversationInteractionInput): Promise<RuntimeInteractionRecord | null> {
    const record = this.records.get(input.interactionId);
    if (
      !record ||
      record.status !== 'pending' ||
      !isConversationRuntimeInteraction(record) ||
      record.submission ||
      record.revision !== input.expectedRevision
    )
      return null;
    const settled: RuntimeInteractionRecord = {
      ...record,
      status: input.terminal.status,
      terminal: structuredClone(input.terminal),
      revision: record.revision + 1,
      updatedAt: input.now,
    };
    this.records.set(input.interactionId, settled);
    return clone(settled);
  }

  async invalidate(input: InvalidateRuntimeInteractionInput): Promise<RuntimeInteractionRecord | null> {
    const record = this.records.get(input.interactionId);
    if (
      !record ||
      !isRuntimeInteractionActive(record) ||
      (input.expectedRevision !== undefined && record.revision !== input.expectedRevision)
    )
      return null;
    const invalidated = invalidatedRecord(record, input.reasonCode, input.now);
    this.records.set(input.interactionId, invalidated);
    return clone(invalidated);
  }

  async invalidateByInvocation(
    invocationId: string,
    reasonCode: RuntimeInteractionTerminalReasonCode,
    now: number,
  ): Promise<RuntimeInteractionRecord[]> {
    return this.invalidateMatching(
      (record) => isProviderRuntimeInteraction(record) && record.request.owner.invocationId === invocationId,
      reasonCode,
      now,
    );
  }

  async invalidateActiveFromOtherHostEpoch(
    hostEpoch: string,
    reasonCode: RuntimeInteractionTerminalReasonCode,
    now: number,
  ): Promise<RuntimeInteractionRecord[]> {
    return this.invalidateMatching(
      (record) => isProviderRuntimeInteraction(record) && record.hostEpoch !== hostEpoch,
      reasonCode,
      now,
    );
  }

  async get(interactionId: string): Promise<RuntimeInteractionRecord | null> {
    const record = this.records.get(interactionId);
    return record ? clone(record) : null;
  }

  async listActive(): Promise<RuntimeInteractionRecord[]> {
    return [...this.records.values()].filter(isRuntimeInteractionActive).map(clone);
  }

  async readPendingIndexByUser(userId: string) {
    return { records: await this.listPendingByUser(userId), exhaustiveness: 'complete' as const };
  }

  async listPendingByUser(userId: string): Promise<RuntimeInteractionRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.status === 'pending' && record.request.owner.userId === userId)
      .sort((left, right) => right.request.createdAt - left.request.createdAt)
      .map(clone);
  }

  async listSettledByUser(userId: string, limit: number): Promise<RuntimeInteractionRecord[]> {
    return [...this.records.values()]
      .filter(
        (record) =>
          record.request.owner.userId === userId &&
          record.cardRef &&
          record.terminal &&
          !isRuntimeInteractionActive(record),
      )
      .sort((left, right) => right.terminal!.settledAt - left.terminal!.settledAt)
      .slice(0, limit)
      .map(clone);
  }

  private invalidateMatching(
    predicate: (record: RuntimeInteractionRecord) => boolean,
    reasonCode: RuntimeInteractionTerminalReasonCode,
    now: number,
  ): RuntimeInteractionRecord[] {
    const invalidated: RuntimeInteractionRecord[] = [];
    for (const [id, record] of this.records) {
      if (!isRuntimeInteractionActive(record) || !predicate(record)) continue;
      const next = invalidatedRecord(record, reasonCode, now);
      this.records.set(id, next);
      invalidated.push(clone(next));
    }
    return invalidated;
  }
}

function invalidatedRecord(
  record: RuntimeInteractionRecord,
  reasonCode: RuntimeInteractionTerminalReasonCode,
  now: number,
): RuntimeInteractionRecord {
  const invalidated: RuntimeInteractionRecord = {
    ...record,
    status: 'invalidated',
    terminal: { status: 'invalidated', reasonCode, settledAt: now },
    revision: record.revision + 1,
    updatedAt: now,
  };
  delete (invalidated as { submission?: unknown }).submission;
  return invalidated;
}

function clone(record: RuntimeInteractionRecord): RuntimeInteractionRecord {
  return structuredClone(record);
}
