import {
  type ApprovalLifecycleEpochPhase,
  type ApprovalLifecycleEpochRecord,
  type ApprovalLifecycleOperation,
  type ApprovalLifecycleQuiescence,
  type ApprovalProducerId,
  type ApprovalWriterGeneration,
  approvalLifecycleEpochRecordSchema,
  approvalLifecycleOperationAllowed,
  assertApprovalLifecycleTransition,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

type EpochRedis = Pick<RedisClient, 'get'> & Partial<Pick<RedisClient, 'set' | 'eval'>>;

export const ApprovalLifecycleEpochKeys = {
  producer: (producerId: ApprovalProducerId): string => `approval:lifecycle-epoch:${producerId}`,
} as const;

export type ApprovalEpochBlockReason = 'epoch_missing' | 'epoch_corrupt' | 'epoch_read_failed' | 'operation_fenced';

export type ApprovalEpochAuthorization =
  | { allowed: true; record: ApprovalLifecycleEpochRecord }
  | { allowed: false; reason: ApprovalEpochBlockReason; record?: ApprovalLifecycleEpochRecord };

export interface ApprovalLifecycleEpochTransitionInput {
  producerId: ApprovalProducerId;
  expectedEpoch: number;
  expectedRevision: number;
  to: ApprovalLifecycleEpochPhase;
  occurredAt: string;
  quiescence?: ApprovalLifecycleQuiescence;
  cutoverReceiptRef?: string;
}

const CAS_LUA = `
local current = redis.call('GET', KEYS[1])
if current ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`;

function requireEpoch(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative safe integer`);
}

function parseProducerEpochRecord(encoded: string, producerId: ApprovalProducerId): ApprovalLifecycleEpochRecord {
  const record = approvalLifecycleEpochRecordSchema.parse(JSON.parse(encoded));
  if (record.producerId !== producerId) {
    throw new Error(`Approval lifecycle epoch producer mismatch: key=${producerId}, record=${record.producerId}`);
  }
  return record;
}

export class RedisApprovalLifecycleEpochAuthority {
  constructor(private readonly redis: EpochRedis) {}

  async initializeLegacy(
    producerId: ApprovalProducerId,
    epoch: number,
    occurredAt: string,
  ): Promise<ApprovalLifecycleEpochRecord> {
    requireEpoch(epoch, 'epoch');
    if (!this.redis.set) throw new Error('Approval lifecycle epoch write unavailable');
    const record = approvalLifecycleEpochRecordSchema.parse({
      producerId,
      epoch,
      revision: 0,
      phase: 'legacy_active',
      updatedAt: occurredAt,
    });
    const result = await this.redis.set(ApprovalLifecycleEpochKeys.producer(producerId), JSON.stringify(record), 'NX');
    if (result === 'OK') return record;
    const existing = await this.read(producerId);
    if (existing && existing.epoch === epoch && existing.phase === 'legacy_active') return existing;
    throw new Error(`Approval lifecycle epoch ${producerId} is already initialized`);
  }

  async read(producerId: ApprovalProducerId): Promise<ApprovalLifecycleEpochRecord | null> {
    const encoded = await this.redis.get(ApprovalLifecycleEpochKeys.producer(producerId));
    if (encoded === null) return null;
    return parseProducerEpochRecord(encoded, producerId);
  }

  async authorize(
    producerId: ApprovalProducerId,
    writer: ApprovalWriterGeneration,
    operation: ApprovalLifecycleOperation,
  ): Promise<ApprovalEpochAuthorization> {
    let encoded: string | null;
    try {
      encoded = await this.redis.get(ApprovalLifecycleEpochKeys.producer(producerId));
    } catch {
      return { allowed: false, reason: 'epoch_read_failed' };
    }
    if (encoded === null) return { allowed: false, reason: 'epoch_missing' };
    let record: ApprovalLifecycleEpochRecord;
    try {
      record = parseProducerEpochRecord(encoded, producerId);
    } catch {
      return { allowed: false, reason: 'epoch_corrupt' };
    }
    return approvalLifecycleOperationAllowed(record, writer, operation)
      ? { allowed: true, record }
      : { allowed: false, reason: 'operation_fenced', record };
  }

  async transition(input: ApprovalLifecycleEpochTransitionInput): Promise<ApprovalLifecycleEpochRecord> {
    requireEpoch(input.expectedEpoch, 'expectedEpoch');
    requireEpoch(input.expectedRevision, 'expectedRevision');
    if (!this.redis.eval) throw new Error('Approval lifecycle epoch CAS unavailable');
    const key = ApprovalLifecycleEpochKeys.producer(input.producerId);
    const encoded = await this.redis.get(key);
    if (encoded === null) throw new Error(`Approval lifecycle epoch missing for ${input.producerId}`);
    let current: ApprovalLifecycleEpochRecord;
    try {
      current = parseProducerEpochRecord(encoded, input.producerId);
    } catch (error) {
      throw new Error(`Approval lifecycle epoch corrupt for ${input.producerId}`, { cause: error });
    }
    if (current.epoch !== input.expectedEpoch || current.revision !== input.expectedRevision) {
      throw new Error(
        `Approval lifecycle epoch CAS conflict for ${input.producerId}: expected ${input.expectedEpoch}/${input.expectedRevision}, actual ${current.epoch}/${current.revision}`,
      );
    }
    assertApprovalLifecycleTransition(current, input.to, input.quiescence);
    const next = approvalLifecycleEpochRecordSchema.parse({
      producerId: input.producerId,
      epoch: current.epoch,
      revision: current.revision + 1,
      phase: input.to,
      updatedAt: input.occurredAt,
      ...(input.to === 'v1_active' ? { cutoverReceiptRef: input.cutoverReceiptRef } : {}),
    });
    const applied = await this.redis.eval(CAS_LUA, 1, key, encoded, JSON.stringify(next));
    if (Number(applied) !== 1) {
      throw new Error(`Approval lifecycle epoch CAS conflict for ${input.producerId}`);
    }
    return next;
  }
}
