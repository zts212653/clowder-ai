import type { RedisClient } from '@cat-cafe/shared/utils';
import {
  type CompanionDeliveryAcceptance,
  companionDeliveryReceiptSchema,
  companionSubmissionKey,
} from '../companion-submission-state.js';
import { MessageKeys } from '../redis-keys/message-keys.js';

const RECORD_ACCEPTANCE = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
local raw = redis.call('HGETALL', KEYS[1])
if #raw == 0 then return 0 end
local m = {}
for i=1,#raw,2 do m[raw[i]]=raw[i+1] end
if m.userId ~= ARGV[2] or m.threadId ~= ARGV[3] or (m.catId or '') ~= '' then return 0 end
if m.recall or m.deletedAt or m._tombstone or m.source or m.content ~= ARGV[4] then return 0 end
local receipt = cjson.decode(ARGV[5])
local senderOk, sender = pcall(cjson.decode, m.from or '')
if not senderOk or type(sender) ~= 'table' or sender.kind ~= 'user' or sender.userId ~= ARGV[2] then return 0 end
local extra = {}
if m.extra and m.extra ~= '' then
  local extraOk, value = pcall(cjson.decode, m.extra)
  if not extraOk or type(value) ~= 'table' then return 0 end
  extra = value
end
if receipt.callId == cjson.null then
  if extra.liveCompanion then return 0 end
else
  local live = extra.liveCompanion
  if not live or live.modality ~= 'typed' or live.callId ~= receipt.callId or live.clientMessageId ~= receipt.clientMessageId then return 0 end
end
if m.companionDeliveryReceipt and m.companionDeliveryReceipt ~= '' then
  local previousOk, previous = pcall(cjson.decode, m.companionDeliveryReceipt)
  if not previousOk or type(previous) ~= 'table' then return 0 end
  if previous.clientMessageId ~= receipt.clientMessageId or previous.callId ~= receipt.callId or previous.contentDigest ~= receipt.contentDigest then return 0 end
  return 1
end
redis.call('HSET', KEYS[1], 'companionDeliveryReceipt', ARGV[5])
return 1
`;

/** Commit the acceptance beside its original Message, fenced by the canonical idempotency index. */
export async function recordRedisCompanionAcceptance(
  redis: RedisClient,
  id: string,
  input: CompanionDeliveryAcceptance,
  content: string,
): Promise<boolean> {
  const parsed = companionDeliveryReceiptSchema.safeParse({
    clientMessageId: input.clientMessageId,
    callId: input.callId,
    acceptedAt: input.acceptedAt,
    contentDigest: input.contentDigest,
  });
  if (!parsed.success) return false;
  const receipt = parsed.data;
  return (
    Number(
      await redis.eval(
        RECORD_ACCEPTANCE,
        2,
        MessageKeys.detail(id),
        MessageKeys.idempotency(input.ownerUserId, input.threadId, companionSubmissionKey(input)),
        id,
        input.ownerUserId,
        input.threadId,
        content,
        JSON.stringify(receipt),
      ),
    ) === 1
  );
}
