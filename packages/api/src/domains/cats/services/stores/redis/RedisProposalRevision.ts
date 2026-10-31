import type { ThreadProposal } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { ProposalKeys } from '../redis-keys/proposals/proposal-keys.js';

const RECORD_REQUEST = `
if redis.call('HGET', KEYS[1], 'status') ~= 'pending' then return 0 end
local old = redis.call('HGET', KEYS[1], 'revisionRequest')
if old then
  if cjson.decode(old).instruction ~= ARGV[2] then return 0 end
  local previous = cjson.decode(old)
  local incoming = cjson.decode(ARGV[1])
  local oldChoices = previous.choices or {}
  local newChoices = incoming.choices or {}
  for _, key in ipairs({'suggestedGroupId', 'projectPath', 'pinned'}) do
    if oldChoices[key] ~= newChoices[key] then return 0 end
  end
  if incoming.queuedAt and previous.messageId == incoming.messageId and not previous.queuedAt then
    previous.queuedAt = incoming.queuedAt
    redis.call('HSET', KEYS[1], 'revisionRequest', cjson.encode(previous))
  end
else redis.call('HSET', KEYS[1], 'revisionRequest', ARGV[1]) end
return 1`;

const REPLACE = `
if redis.call('HGET', KEYS[1], 'supersededByProposalId') == ARGV[2] then return 1 end
if redis.call('HGET', KEYS[1], 'status') ~= 'pending' then return 0 end
local request = redis.call('HGET', KEYS[1], 'revisionRequest')
if not request or cjson.decode(request).messageId ~= ARGV[3] then return 0 end
if redis.call('HGET', KEYS[2], 'status') ~= 'pending' then return 0 end
if not redis.call('HGET', KEYS[2], 'cardMessageId') then return 0 end
if redis.call('HGET', KEYS[2], 'supersedesProposalId') ~= ARGV[1] then return 0 end
if redis.call('HGET', KEYS[2], 'sourceMessageId') ~= ARGV[3] then return 0 end
for _, field in ipairs({'createdBy','sourceCatId','sourceThreadId'}) do
  if redis.call('HGET', KEYS[1], field) ~= redis.call('HGET', KEYS[2], field) then return 0 end
end
local historyType = redis.call('TYPE', KEYS[4]).ok
if historyType ~= 'none' and historyType ~= 'zset' then return redis.error_reply('proposal history index type conflict') end
redis.call('HSET', KEYS[1], 'status', 'withdrawn', 'withdrawnAt', ARGV[4],
  'withdrawnBy', redis.call('HGET', KEYS[1], 'sourceCatId'), 'supersededByProposalId', ARGV[2])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('ZADD', KEYS[4], ARGV[4], ARGV[1])
return 1`;

export async function recordRedisRevisionRequest(
  redis: RedisClient,
  proposalId: string,
  request: NonNullable<ThreadProposal['revisionRequest']>,
): Promise<boolean> {
  return (
    (await redis.eval(
      RECORD_REQUEST,
      1,
      ProposalKeys.detail(proposalId),
      JSON.stringify(request),
      request.instruction,
    )) === 1
  );
}

export async function supersedeRedisProposal(
  redis: RedisClient,
  proposal: ThreadProposal,
  replacementId: string,
  requestMessageId: string,
): Promise<boolean> {
  return (
    (await redis.eval(
      REPLACE,
      4,
      ProposalKeys.detail(proposal.proposalId),
      ProposalKeys.detail(replacementId),
      ProposalKeys.userPending(proposal.createdBy),
      ProposalKeys.userSettled(proposal.createdBy),
      proposal.proposalId,
      replacementId,
      requestMessageId,
      String(Date.now()),
    )) === 1
  );
}
