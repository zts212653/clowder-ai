import type { ChatMessage, ThreadState } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

const CAT = 'codex61-sol';
const PARENT = 'preview-native-parent';
const SESSION = 'preview-native-session';

async function readMessages(threadId: string): Promise<ChatMessage[]> {
  const response = await apiFetch(`/api/messages?threadId=${encodeURIComponent(threadId)}`);
  if (!response.ok) throw new Error(`Preview messages: ${response.status}`);
  return ((await response.json()) as { messages: ChatMessage[] }).messages;
}

/** Isolated development scenario: persisted message identity, telemetry without invocation IDs. */
export async function preparePostRunPreview(state: ThreadState, threadId: string): Promise<ThreadState> {
  const messages = await readMessages(threadId);
  const completed = messages.some(
    (message) => message.catId === CAT && message.type === 'assistant' && !message.isStreaming,
  );
  const startedAt = Date.now() - 10000;
  return {
    ...state,
    messages,
    targetCats: [CAT],
    catInvocations: completed ? {} : { [CAT]: { sessionId: SESSION, startedAt } },
    catStatuses: { [CAT]: completed ? 'done' : 'streaming' },
    activeInvocations: completed ? {} : { [PARENT]: { catId: CAT, mode: 'execute', startedAt } },
    hasActiveInvocation: !completed,
  };
}

export function startPostRunPreview(threadId: string): void {
  const store = useChatStore.getState();
  if (store.currentThreadId !== threadId) return;
  const startedAt = Date.now();
  store.setCatInvocation(CAT, { sessionId: SESSION, startedAt, durationMs: undefined });
  store.setCatStatus(CAT, 'streaming');
  store.addActiveInvocation(PARENT, CAT, 'execute', startedAt);
}

/** Simulate the original invocation_created identity patch, sourced from the live fixture message. */
export async function bindPostRunPreviewChild(threadId: string): Promise<void> {
  const messages = await readMessages(threadId);
  const child = messages.find((message) => message.catId === CAT && message.isStreaming)?.extra?.stream
    ?.turnInvocationId;
  if (!child) throw new Error('Preview child identity is not available');
  const store = useChatStore.getState();
  if (store.currentThreadId !== threadId) return;
  store.setThreadCatInvocation(threadId, CAT, { invocationId: PARENT, turnInvocationId: child });
}

export async function finishPostRunPreview(threadId: string): Promise<void> {
  const messages = await readMessages(threadId);
  const store = useChatStore.getState();
  if (store.currentThreadId !== threadId) return;
  for (const message of messages) store.addMessage(message);
  store.setCatInvocation(CAT, {
    invocationId: undefined,
    turnInvocationId: undefined,
    sessionId: SESSION,
    durationMs: Date.now() - (store.catInvocations[CAT]?.startedAt ?? Date.now()),
  });
  store.setCatStatus(CAT, 'done');
  store.removeActiveInvocation(PARENT);
}
