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

export interface EmptyResponseLifecycleNotice {
  label: string;
  tone: 'processing' | 'completed' | 'failed' | 'canceled';
}

function hasAssistantBody(message: ChatMessage, context: AssistantMessageRenderContext = {}): boolean {
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
  return Boolean(hasTextContent || hasCliBlock || hasBlocks || message.extra?.rich?.blocks?.length || message.thinking);
}

/** Copy owned by the lifecycle frame while no streamed body exists yet. */
export function projectEmptyResponseLifecycleNotice(
  message: ChatMessage,
  context: AssistantMessageRenderContext = {},
): EmptyResponseLifecycleNotice | null {
  const lifecycle = message.lifecycle;
  if (lifecycle?.kind !== 'response' || hasAssistantBody(message, context)) return null;
  switch (lifecycle.status) {
    case 'processing':
      return { label: '正在回复…', tone: 'processing' };
    case 'completed':
      return { label: '已完成，没有返回可显示内容。', tone: 'completed' };
    case 'failed':
      return { label: '回复失败。', tone: 'failed' };
    case 'canceled':
      return { label: '已停止回复。', tone: 'canceled' };
    case 'interrupted':
      return { label: '回复已中断。', tone: 'canceled' };
  }
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
  const hasResponseBody = hasAssistantBody(message, context);
  const hasCrossThreadSource =
    context.hasCrossThreadSource ??
    isCrossThreadProvenance(message.extra?.crossPost?.sourceThreadId, context.currentThreadId);

  const responseLifecycle = message.lifecycle?.kind === 'response' ? message.lifecycle : undefined;
  // Admission owns the execution tip, not an empty speech bubble. The stable
  // response frame takes over only once provider content starts streaming, or
  // when a terminal empty outcome needs an explicit user-visible explanation.
  if (responseLifecycle) return responseLifecycle.status !== 'processing' || hasResponseBody;
  if (message.isStreaming) return hasResponseBody;

  return Boolean(
    hasResponseBody ||
      hasCrossThreadSource ||
      message.extra?.freshness ||
      message.extra?.freshnessSupplement ||
      message.extra?.turnExecution ||
      message.extra?.auxiliaryTurnExecutions?.length,
  );
}
