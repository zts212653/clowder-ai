import type { ApprovalEnvelope, ApprovalPublication } from '@cat-cafe/shared';
import { validateApprovalPublication } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

const COMMIT_APPROVAL_ENVELOPE_LUA = `
local raw = redis.call('HGET', KEYS[1], 'publication')
if not raw then
  return -2
end
local ok, current = pcall(cjson.decode, raw)
if not ok then
  return -3
end
if current.state == 'anchored' then
  if raw == ARGV[1] then
    return 2
  end
  return -1
end
if current.state ~= 'staged' then
  return 0
end
redis.call('HSET', KEYS[1], 'publication', ARGV[1], 'cardMessageId', ARGV[2])
return 1
`;

const ABORT_STAGED_LUA = `
local raw = redis.call('HGET', KEYS[1], 'publication')
if not raw then
  return 0
end
local ok, current = pcall(cjson.decode, raw)
if not ok or current.state ~= 'staged' then
  return 0
end
redis.call('DEL', KEYS[1])
local indexCount = tonumber(ARGV[2])
for i = 2, 1 + indexCount do
  redis.call('ZREM', KEYS[i], ARGV[1])
end
local conditionalDeleteKey = KEYS[2 + indexCount]
if conditionalDeleteKey and redis.call('GET', conditionalDeleteKey) == ARGV[1] then
  redis.call('DEL', conditionalDeleteKey)
end
return 1
`;

export function serializeApprovalPublication(publication: ApprovalPublication): string {
  validateApprovalPublication(publication);
  return JSON.stringify(publication);
}

export function hydrateApprovalPublication(raw: string | undefined): ApprovalPublication | undefined {
  if (!raw) return undefined;
  let publication: ApprovalPublication;
  try {
    publication = JSON.parse(raw) as ApprovalPublication;
    validateApprovalPublication(publication);
  } catch (error) {
    throw new Error(`Malformed approval publication: ${error instanceof Error ? error.message : String(error)}`);
  }
  return publication;
}

export async function commitRedisApprovalEnvelope(
  redis: RedisClient,
  detailKey: string,
  envelope: ApprovalEnvelope,
): Promise<void> {
  const publication: ApprovalPublication = { state: 'anchored', envelope };
  const result = (await redis.eval(
    COMMIT_APPROVAL_ENVELOPE_LUA,
    1,
    detailKey,
    serializeApprovalPublication(publication),
    envelope.approvalCardRef.messageId,
  )) as number;
  if (result === 1 || result === 2) return;
  if (result === -1) throw new Error('conflicting approval envelope');
  if (result === -2) throw new Error('approval publication is not staged');
  if (result === -3) throw new Error('malformed approval publication');
  throw new Error('approval publication is not staged');
}

export async function abortRedisStaged(
  redis: RedisClient,
  detailKey: string,
  indexKeys: readonly string[],
  proposalId: string,
  conditionalDeleteKey?: string,
): Promise<boolean> {
  const keys = conditionalDeleteKey ? [detailKey, ...indexKeys, conditionalDeleteKey] : [detailKey, ...indexKeys];
  const result = await redis.eval(ABORT_STAGED_LUA, keys.length, ...keys, proposalId, String(indexKeys.length));
  return result === 1;
}
