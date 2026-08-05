import type { ChatMessage } from '@/stores/chat-types';
import { doesAssistantMessageRenderBubble } from './assistant-message-renderability';

type ActiveInvocationSlots = Record<string, { catId: string; mode: string; startedAt?: number }>;

export interface PendingMemberInvocation {
  invocationId: string;
  catId: string;
}

function normalizeActiveInvocationId(invocationId: string, catId: string): string {
  const fanoutSuffix = `-${catId}`;
  return invocationId.endsWith(fanoutSuffix) ? invocationId.slice(0, -fanoutSuffix.length) : invocationId;
}

function addVisibleInvocationIds(message: ChatMessage, visible: Set<string>, currentThreadId?: string): void {
  if (!message.catId || message.extra?.isExplicitPost) return;
  if (!doesAssistantMessageRenderBubble(message, { currentThreadId })) return;

  const parentInvocationId = message.extra?.stream?.invocationId;
  const turnInvocationId = message.extra?.stream?.turnInvocationId;
  if (parentInvocationId) visible.add(`${message.catId}:${parentInvocationId}`);
  if (turnInvocationId) visible.add(`${message.catId}:${turnInvocationId}`);
  for (const execution of message.extra?.auxiliaryTurnExecutions ?? []) {
    visible.add(`${message.catId}:${execution.invocationId}`);
  }

  if (message.id.startsWith('draft-')) {
    visible.add(`${message.catId}:${message.id.slice('draft-'.length)}`);
  }
}

/**
 * Project a pending avatar only until that exact active invocation has a real
 * assistant bubble. A later user message must not reset the association.
 */
export function derivePendingMemberInvocations(
  activeInvocations: ActiveInvocationSlots,
  messages: readonly ChatMessage[],
  currentThreadId?: string,
): PendingMemberInvocation[] {
  const visibleInvocations = new Set<string>();
  for (const message of messages) addVisibleInvocationIds(message, visibleInvocations, currentThreadId);

  return Object.entries(activeInvocations)
    .filter(([invocationId]) => !invocationId.startsWith('hydrated-'))
    .filter(([invocationId, invocation]) => {
      const normalizedInvocationId = normalizeActiveInvocationId(invocationId, invocation.catId);
      return (
        !visibleInvocations.has(`${invocation.catId}:${invocationId}`) &&
        !visibleInvocations.has(`${invocation.catId}:${normalizedInvocationId}`)
      );
    })
    .map(([invocationId, invocation]) => ({ invocationId, catId: invocation.catId }));
}
