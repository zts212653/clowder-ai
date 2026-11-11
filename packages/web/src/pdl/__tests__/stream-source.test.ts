import { afterEach, expect, it } from 'vitest';
import {
  finishHeldStream,
  holdStreamEvent,
  rememberHeldStream,
  resumeHeldStreams,
} from '@/hooks/agent-messages/background-handler';
import { useChatStore } from '@/stores/chatStore';
import { fixtureData } from './chat-fixture';

const threadId = 'stream-source';
const base = () => ({
  ...fixtureData().messages[0],
  id: 'streaming',
  threadId,
  type: 'assistant' as const,
  catId: 'codex',
  content: 'before',
  isStreaming: true,
});
const chunk = (content: string) => ({
  type: 'text' as const,
  threadId,
  messageId: 'streaming',
  catId: 'codex',
  content,
  timestamp: 1,
  origin: 'stream' as const,
});
afterEach(() => {
  finishHeldStream(threadId, 'streaming');
});
it('keeps off-screen deltas out of the held thread and overlays its complete in-flight body after history', () => {
  useChatStore.setState({ currentThreadId: threadId, messages: [base()] });
  rememberHeldStream(chunk(''));
  holdStreamEvent(chunk(' hidden'));
  holdStreamEvent(chunk(' tail'));
  expect(useChatStore.getState().messages[0].content).toBe('before');
  useChatStore.getState().patchThreadMessage(threadId, 'streaming', { content: 'partial from history' });
  resumeHeldStreams(threadId);
  expect(useChatStore.getState().messages[0].content).toBe('before hidden tail');
  useChatStore.getState().patchThreadMessage(threadId, 'streaming', { content: '' });
  resumeHeldStreams(threadId);
  expect(useChatStore.getState().messages[0].content).toBe('before hidden tail');
  finishHeldStream(threadId, 'streaming');
  useChatStore
    .getState()
    .patchThreadMessage(threadId, 'streaming', { content: 'final from history', isStreaming: false });
  resumeHeldStreams(threadId);
  expect(useChatStore.getState().messages[0].content).toBe('final from history');
});
it('does not append the same hidden chunks to a partial history body when the message started off screen', () => {
  useChatStore.setState({ currentThreadId: threadId, messages: [] });
  holdStreamEvent(chunk('first'));
  holdStreamEvent(chunk(' second'));
  useChatStore.setState({ messages: [{ ...base(), content: 'first' }] });
  resumeHeldStreams(threadId);
  expect(useChatStore.getState().messages[0].content).toBe('first second');
});
it('lets a terminal lifecycle in the full history retire the cache rather than reopen a final message', () => {
  useChatStore.setState({ currentThreadId: threadId, messages: [base()] });
  rememberHeldStream(chunk(''));
  holdStreamEvent(chunk(' hidden'));
  useChatStore.getState().patchThreadMessage(threadId, 'streaming', {
    content: 'committed',
    isStreaming: false,
    lifecycle: {
      kind: 'response',
      orderKey: '001',
      status: 'completed',
      invocationId: 'inv',
      targetId: 'codex',
      inputEntryIds: [],
      inputMessageIds: [],
      startedAt: 1,
      completedAt: 2,
    },
  });
  resumeHeldStreams(threadId);
  expect(useChatStore.getState().messages[0].content).toBe('committed');
});
