import type { ChatMessage } from '@/stores/chat-types';
import { runtimeInteractionHeadingCopy } from './runtime-interaction-heading.shell-copy';

/** Translate only the publisher's exact, bound template. Stored history and authored titles stay intact. */
export function projectRuntimeInteractionHeading(
  message: Pick<ChatMessage, 'content' | 'extra'>,
  copy: (typeof runtimeInteractionHeadingCopy)['zh'],
): string {
  const binding = message.extra?.runtimeInteractionCard;
  if (!binding || binding.version !== 1 || binding.requestKind === 'conversation_decision') return message.content;
  const block = message.extra?.rich?.blocks.find((candidate) => candidate.id === binding.blockId);
  if (
    block?.kind !== 'card' ||
    block.meta?.kind !== 'runtime_interaction' ||
    block.meta.interactionId !== binding.interactionId ||
    block.meta.interactionKind !== binding.requestKind
  )
    return message.content;
  const kind = binding.requestKind;
  if (message.content !== runtimeInteractionHeadingCopy.zh[kind](block.title)) return message.content;
  return copy[kind](block.title);
}
