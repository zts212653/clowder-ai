import { type HumanDispositionLedgerReceipt, humanDispositionLedgerReceiptSchema } from '@cat-cafe/shared';
import { HumanDispositionKeys } from './human-disposition-keys.js';

export const HUMAN_DISPOSITION_RECEIPT_FUNCTIONS_LUA = `
local function redis_type_name(key)
  local reply = redis.call('TYPE', key)
  if type(reply) == 'table' then
    return reply.ok
  end
  return reply
end

local function allowed_type(key, expected)
  local actual = redis_type_name(key)
  return actual == 'none' or actual == expected
end

local function preflight_human_disposition_receipt(
  receipt_key,
  owner_index_key,
  subject_index_key,
  receipt_json,
  source_ref,
  subject_ref,
  score_text
)
  if not allowed_type(receipt_key, 'hash')
    or not allowed_type(owner_index_key, 'zset')
    or not allowed_type(subject_index_key, 'zset') then
    return 'TYPE_CONFLICT'
  end

  local ok, receipt = pcall(cjson.decode, receipt_json)
  local score = tonumber(score_text)
  if not ok or type(receipt) ~= 'table' or score == nil
    or score ~= score or score == math.huge or score == -math.huge then
    return 'INVALID_RECEIPT'
  end

  local fields = 0
  for key, _ in pairs(receipt) do
    if key ~= 'sourceRef' and key ~= 'subjectRef'
      and key ~= 'interactionKind' and key ~= 'decidedAt' then
      return 'INVALID_RECEIPT'
    end
    fields = fields + 1
  end
  if fields ~= 4
    or type(receipt.sourceRef) ~= 'string' or receipt.sourceRef == ''
    or type(receipt.subjectRef) ~= 'string' or receipt.subjectRef == ''
    or type(receipt.interactionKind) ~= 'string' or receipt.interactionKind == ''
    or type(receipt.decidedAt) ~= 'number'
    or receipt.sourceRef ~= source_ref
    or receipt.subjectRef ~= subject_ref
    or receipt.decidedAt ~= score then
    return 'INVALID_RECEIPT'
  end

  local existing = redis.call('HGET', receipt_key, source_ref)
  local owner_score = redis.call('ZSCORE', owner_index_key, source_ref)
  local subject_score = redis.call('ZSCORE', subject_index_key, source_ref)
  if existing then
    if existing == receipt_json
      and owner_score and tonumber(owner_score) == score
      and subject_score and tonumber(subject_score) == score then
      return 'REPLAY'
    end
    return 'CONFLICT'
  end
  if owner_score or subject_score then
    return 'CONFLICT'
  end
  return 'NEW'
end

local function write_human_disposition_receipt(
  receipt_key,
  owner_index_key,
  subject_index_key,
  receipt_json,
  source_ref,
  score
)
  redis.call('HSET', receipt_key, source_ref, receipt_json)
  redis.call('ZADD', owner_index_key, 'NX', score, source_ref)
  redis.call('ZADD', subject_index_key, 'NX', score, source_ref)
end
`;

export const HUMAN_DISPOSITION_RECEIPT_APPEND_LUA = `
${HUMAN_DISPOSITION_RECEIPT_FUNCTIONS_LUA}
if #KEYS ~= 3 or #ARGV ~= 4 then
  return 'INVALID_ARGUMENTS'
end
local status = preflight_human_disposition_receipt(
  KEYS[1],
  KEYS[2],
  KEYS[3],
  ARGV[1],
  ARGV[2],
  ARGV[3],
  ARGV[4]
)
if status ~= 'NEW' then
  return status
end
write_human_disposition_receipt(KEYS[1], KEYS[2], KEYS[3], ARGV[1], ARGV[2], ARGV[4])
return 'APPLIED'
`;

export interface HumanDispositionReceiptAppendArguments {
  keys: [string, string, string];
  arguments: [string, string, string, string];
}

export function humanDispositionReceiptAppendArguments(
  ownerUserId: string,
  receiptInput: HumanDispositionLedgerReceipt,
): HumanDispositionReceiptAppendArguments {
  const receipt = humanDispositionLedgerReceiptSchema.parse(receiptInput);
  return {
    keys: [
      HumanDispositionKeys.receipts(ownerUserId),
      HumanDispositionKeys.episodes(ownerUserId),
      HumanDispositionKeys.subject(ownerUserId, receipt.subjectRef),
    ],
    arguments: [JSON.stringify(receipt), receipt.sourceRef, receipt.subjectRef, String(receipt.decidedAt)],
  };
}
