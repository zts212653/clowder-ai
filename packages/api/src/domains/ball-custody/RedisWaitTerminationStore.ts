import { buildHumanDispositionLedgerReceipt, humanDispositionLedgerReceiptSchema } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import {
  HUMAN_DISPOSITION_RECEIPT_FUNCTIONS_LUA,
  humanDispositionReceiptAppendArguments,
} from '../human-disposition/human-disposition-lua.js';
import {
  type WaitTerminationCommitOutcome,
  type WaitTerminationRecord,
  type WaitTerminationStore,
  waitTerminationRecordSchema,
} from './WaitTerminationStore.js';
import { WaitTerminationKeys } from './wait-termination-keys.js';

const COMMIT_LUA = `
${HUMAN_DISPOSITION_RECEIPT_FUNCTIONS_LUA}
if #KEYS ~= 5 or #ARGV ~= 6 then
  return 'INVALID_ARGUMENTS'
end
if not allowed_type(KEYS[1], 'hash') or not allowed_type(KEYS[2], 'hash') then
  return 'TYPE_CONFLICT'
end
local receipt_status = preflight_human_disposition_receipt(
  KEYS[3], KEYS[4], KEYS[5], ARGV[3], ARGV[4], ARGV[5], ARGV[6]
)
if receipt_status == 'TYPE_CONFLICT' or receipt_status == 'INVALID_RECEIPT' then
  return receipt_status
end
local existing_record = redis.call('HGET', KEYS[1], ARGV[1])
local existing_wait_id = redis.call('HGET', KEYS[2], ARGV[4])
if existing_record then
  if existing_record == ARGV[2] and existing_wait_id == ARGV[1] and receipt_status == 'REPLAY' then
    return 'REPLAY'
  end
  return 'CONFLICT'
end
if existing_wait_id or receipt_status ~= 'NEW' then
  return 'CONFLICT'
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[2], ARGV[4], ARGV[1])
write_human_disposition_receipt(KEYS[3], KEYS[4], KEYS[5], ARGV[3], ARGV[4], ARGV[6])
return 'APPLIED'
`;

export class RedisWaitTerminationStore implements WaitTerminationStore {
  constructor(private readonly redis: RedisClient) {}

  async getByWaitId(waitId: string): Promise<WaitTerminationRecord | null> {
    const raw = await this.redis.hget(WaitTerminationKeys.records(), waitId);
    return this.parseRecord(raw);
  }

  async commit(recordInput: WaitTerminationRecord): Promise<WaitTerminationCommitOutcome> {
    const record = waitTerminationRecordSchema.parse(recordInput);
    const receipt = buildHumanDispositionLedgerReceipt(record.entry);
    const receiptCall = humanDispositionReceiptAppendArguments(record.event.ownerUserId, receipt);
    const result = await this.redis.eval(
      COMMIT_LUA,
      5,
      WaitTerminationKeys.records(),
      WaitTerminationKeys.sources(),
      ...receiptCall.keys,
      record.event.waitId,
      JSON.stringify(record),
      ...receiptCall.arguments,
    );
    if (result === 'APPLIED') return 'applied';
    if (result === 'REPLAY') return 'replay';
    if (result === 'CONFLICT') return 'conflict';
    throw new Error(`wait termination commit failed: ${String(result)}`);
  }

  async loadEntry(input: { ownerUserId: string; receipt: unknown }): Promise<WaitTerminationRecord['entry'] | null> {
    const receipt = humanDispositionLedgerReceiptSchema.safeParse(input.receipt);
    if (!receipt.success) return null;
    const waitId = await this.redis.hget(WaitTerminationKeys.sources(), receipt.data.sourceRef);
    if (!waitId) return null;
    const record = await this.getByWaitId(waitId);
    if (!record || record.event.ownerUserId !== input.ownerUserId) return null;
    const canonicalReceipt = buildHumanDispositionLedgerReceipt(record.entry);
    return JSON.stringify(canonicalReceipt) === JSON.stringify(receipt.data) ? record.entry : null;
  }

  async listRecords(): Promise<WaitTerminationRecord[]> {
    const raw = await this.redis.hvals(WaitTerminationKeys.records());
    return raw.flatMap((entry) => {
      const parsed = this.parseRecord(entry);
      return parsed ? [parsed] : [];
    });
  }

  private parseRecord(raw: string | null): WaitTerminationRecord | null {
    if (!raw) return null;
    try {
      const parsed = waitTerminationRecordSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}
