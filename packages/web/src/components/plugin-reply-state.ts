import type { ChatMessage } from '@/stores/chat-types';

/** The caller supplies one thread's timeline. Reply identity is written by the Host, not the plugin payload. */
export function pluginReplyFor(inputMessageId: string, instanceId: string, messages: readonly ChatMessage[]) {
  return messages.find(
    (message) =>
      message.from?.kind === 'plugin' &&
      message.from.instanceId === instanceId &&
      message.replyTo === inputMessageId &&
      message.visibility !== 'whisper' &&
      !message.extra?.recall &&
      (message.content.trim().length > 0 ||
        Boolean(message.contentBlocks?.length) ||
        Boolean(message.extra?.rich?.blocks?.length)),
  );
}
