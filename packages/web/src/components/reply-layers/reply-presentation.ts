import { type CompanionIdentitySnapshotV1, companionIdentitySnapshotV1Schema } from '@cat-cafe/shared';
import type { ChatMessage } from '@/stores/chat-types';
import { doesAssistantMessageRenderBubble } from '../assistant-message-renderability';
import type { ShellPresentation } from '../shell/shell-presentation';

/** Resolve only identity snapshots that actually describe this assistant row. */
export function resolveReplyCompanionIdentity(message: ChatMessage): CompanionIdentitySnapshotV1 | undefined {
  if (message.type !== 'assistant') return undefined;
  const parsed = companionIdentitySnapshotV1Schema.safeParse(message.extra?.liveCompanion?.identity);
  if (!parsed.success) return undefined;
  return message.catId === parsed.data.live.catId || message.catId === parsed.data.deep.catId ? parsed.data : undefined;
}

export interface ReplyLayersPresentationContext {
  shellPresentation: ShellPresentation;
  compact: boolean;
  currentThreadId?: string;
}

/**
 * Keep the reply body/record layout tied to its durable author, not async catalog hydration.
 * The header resolves optional profile styling separately; ReplyLayers also require a thread to own their controls.
 */
export function canRenderLayeredReply(message: ChatMessage, context: ReplyLayersPresentationContext): boolean {
  return Boolean(
    context.shellPresentation === 'v2' &&
      !context.compact &&
      doesAssistantMessageRenderBubble(message, { currentThreadId: context.currentThreadId }) &&
      !resolveReplyCompanionIdentity(message) &&
      message.catId,
  );
}

/** A durable carrier may move only when the exact owner row will actually draw ReplyLayers. */
export function canRenderReplyLayers(message: ChatMessage, context: ReplyLayersPresentationContext): boolean {
  return Boolean(context.currentThreadId && canRenderLayeredReply(message, context));
}
