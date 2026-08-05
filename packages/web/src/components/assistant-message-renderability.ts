import { isCrossThreadProvenance } from '@cat-cafe/shared';
import type { ChatMessage } from '@/stores/chat-types';
import { toCliEvents } from './cli-output/toCliEvents';

/**
 * Single visual handoff contract for assistant messages.
 *
 * Pending-member projection and ChatMessage must agree on this predicate:
 * the placeholder can leave only in the same render where the real assistant
 * bubble is able to take ownership of the avatar slot.
 */
interface AssistantMessageRenderContext {
  currentThreadId?: string;
  /** Reuse ChatMessage's already-projected CLI timeline instead of rebuilding it. */
  hasCliBlock?: boolean;
  /** Reuse ChatMessage's already-resolved cross-thread provenance. */
  hasCrossThreadSource?: boolean;
}

export function doesAssistantMessageRenderBubble(
  message: ChatMessage,
  context: AssistantMessageRenderContext = {},
): boolean {
  // Persisted cross-thread/legacy records can retain type=user even though a
  // trusted catId establishes assistant authorship. Match ChatMessage's
  // long-standing author-precedence branch without admitting system records,
  // which render through a separate surface and never own the cat avatar slot.
  const isAssistantAuthored = message.type === 'assistant' || (message.type === 'user' && Boolean(message.catId));
  if (!isAssistantAuthored) return false;
  if (message.isStreaming) return true;

  const hasTextContent = message.content.trim().length > 0;
  const hasBlocks = Boolean(message.contentBlocks?.length);
  const isStreamOrigin = message.origin === 'stream' && !message.extra?.supplement;
  const mergedCliStdout = message.extra?.stream?.cliStdout;
  const mergedSpeechContent = message.extra?.stream?.speechContent;
  const cachedSpeechStdout =
    isStreamOrigin &&
    mergedCliStdout === '' &&
    !hasTextContent &&
    typeof mergedSpeechContent === 'string' &&
    mergedSpeechContent.trim().length > 0
      ? mergedSpeechContent
      : undefined;
  const projectedCliStdout =
    isStreamOrigin && mergedCliStdout === '' && hasTextContent ? message.content : mergedCliStdout;
  const cliStdoutContent = cachedSpeechStdout ?? projectedCliStdout ?? (isStreamOrigin ? message.content : undefined);
  const hasCliBlock = context.hasCliBlock ?? toCliEvents(message.toolEvents, cliStdoutContent).length > 0;
  const hasCrossThreadSource =
    context.hasCrossThreadSource ??
    isCrossThreadProvenance(message.extra?.crossPost?.sourceThreadId, context.currentThreadId);

  return Boolean(
    hasTextContent ||
      hasCliBlock ||
      hasBlocks ||
      message.extra?.rich?.blocks?.length ||
      hasCrossThreadSource ||
      message.extra?.freshness ||
      message.extra?.freshnessSupplement ||
      message.extra?.turnExecution ||
      message.extra?.auxiliaryTurnExecutions?.length ||
      message.thinking,
  );
}
