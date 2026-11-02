import { type MessageSearchAnswerBinding, messageSearchAnswerBindingSchema, type RichBlock } from '@cat-cafe/shared';
import type { StoredMessage } from './ports/MessageStore.js';

export interface MessageSearchAnswerAttachment {
  ownerUserId: string;
  threadId: string;
  catId: string;
  binding: MessageSearchAnswerBinding;
}
export function messageSearchAnswerBlock(binding: MessageSearchAnswerBinding): RichBlock {
  return {
    kind: 'card',
    v: 1,
    id: binding.blockId,
    title: '',
    meta: { domain: 'message-search-answer', publicationRef: binding.publicationRef },
  };
}
function sameAnswerBinding(
  saved: MessageSearchAnswerBinding | undefined,
  binding: MessageSearchAnswerBinding,
): boolean {
  return (
    !!saved &&
    saved.publicationRef === binding.publicationRef &&
    saved.blockId === binding.blockId &&
    saved.responseDigest === binding.responseDigest &&
    saved.forwardedFromMessageId === binding.forwardedFromMessageId
  );
}
export function matchesMessageSearchAnswer(message: StoredMessage, binding: MessageSearchAnswerBinding): boolean {
  return (
    sameAnswerBinding(message.extra?.messageSearchAnswer, binding) &&
    !!message.extra?.rich?.blocks.some(
      (block) =>
        block.id === binding.blockId &&
        block.kind === 'card' &&
        block.meta?.domain === 'message-search-answer' &&
        block.meta.publicationRef === binding.publicationRef,
    )
  );
}
/** Ordinary extra/rich writers preserve this existing Host-owned ref, never mint it. */
export function preserveMessageSearchAnswerBlock(
  extra: StoredMessage['extra'],
  binding: MessageSearchAnswerBinding | undefined,
): StoredMessage['extra'] {
  const parsed = messageSearchAnswerBindingSchema.safeParse(binding);
  if (!parsed.success) return extra;
  return {
    ...extra,
    messageSearchAnswer: parsed.data,
    rich: {
      v: 1,
      blocks: [
        ...(extra?.rich?.blocks ?? []).filter((block) => block.id !== parsed.data.blockId),
        messageSearchAnswerBlock(parsed.data),
      ],
    },
  };
}
export function attachMessageSearchAnswerExtra(
  message: StoredMessage,
  input: MessageSearchAnswerAttachment,
): StoredMessage['extra'] | null {
  const parsed = messageSearchAnswerBindingSchema.safeParse(input.binding);
  if (
    !parsed.success ||
    message.recall ||
    message._tombstone ||
    message.deletedAt ||
    message.userId !== input.ownerUserId ||
    message.threadId !== input.threadId ||
    message.from?.kind !== 'agent' ||
    message.from.catId !== input.catId
  )
    return null;
  if (message.extra?.messageSearchAnswer && !sameAnswerBinding(message.extra.messageSearchAnswer, parsed.data))
    return null;
  return {
    ...message.extra,
    messageSearchAnswer: parsed.data,
    rich: {
      v: 1,
      blocks: [
        ...(message.extra?.rich?.blocks ?? []).filter((block) => block.id !== parsed.data.blockId),
        messageSearchAnswerBlock(parsed.data),
      ],
    },
  };
}

/** Dedicated Host transition. Generic extra writers cannot introduce or replace this field. */
export const ATTACH_MESSAGE_SEARCH_ANSWER_LUA = `
if redis.call('EXISTS',KEYS[1]) == 0 then return 0 end
if redis.call('HGET',KEYS[1],'recall') or redis.call('HGET',KEYS[1],'_tombstone') or redis.call('HGET',KEYS[1],'deletedAt') then return 0 end
if redis.call('HGET',KEYS[1],'userId') ~= ARGV[1] or redis.call('HGET',KEYS[1],'threadId') ~= ARGV[2] then return 0 end
local author=cjson.decode(redis.call('HGET',KEYS[1],'from') or '{}')
if author.kind ~= 'agent' or author.catId ~= ARGV[3] then return 0 end
local extraRaw=redis.call('HGET',KEYS[1],'extra')
local extra={}
if extraRaw and extraRaw ~= '' then extra=cjson.decode(extraRaw) end
local binding=cjson.decode(ARGV[4])
local current=extra.messageSearchAnswer
if current and (current.publicationRef ~= binding.publicationRef or current.blockId ~= binding.blockId or current.responseDigest ~= binding.responseDigest or current.forwardedFromMessageId ~= binding.forwardedFromMessageId) then return 0 end
local blocks={}
if extra.rich and extra.rich.blocks then
  for _,block in ipairs(extra.rich.blocks) do if block.id ~= binding.blockId then table.insert(blocks,block) end end
end
table.insert(blocks,cjson.decode(ARGV[5]))
extra.rich={v=1,blocks=blocks}
extra.messageSearchAnswer=binding
redis.call('HSET',KEYS[1],'extra',cjson.encode(extra))
return 1
`;
