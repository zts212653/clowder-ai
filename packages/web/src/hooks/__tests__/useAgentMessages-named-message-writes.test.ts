/**
 * F117 contract: every event of a turn is written into the message it names. The server stores
 * the turn's response R empty at admission and stamps `messageId: R` on every event of the turn;
 * a post_message is its own message P. The client never invents, guesses, renames or merges
 * bubble identities — for the open thread and for background threads alike.
 */
import type { LifecycleStoredMessageMetadata } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writeStoredSnapshot } from '@/hooks/named-message-writer';
import { useAgentMessages } from '@/hooks/useAgentMessages';
import type { ChatMessage, LivenessWarningSnapshot, RichBlock } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';

type AgentEvent = Parameters<ReturnType<typeof useAgentMessages>['handleAgentMessage']>[0];

const OPEN = 'thread-open';
const BG = 'thread-bg';
const R = 'resp-1';
const CAT = 'opus';
const INV = 'inv-1';

let captured: ReturnType<typeof useAgentMessages> | undefined;
let clock = 10_000;

function Harness() {
  captured = useAgentMessages();
  return null;
}

function resetStore() {
  useChatStore.setState({
    messages: [],
    isLoading: false,
    hasMore: true,
    hasActiveInvocation: false,
    intentMode: null,
    targetCats: [],
    catStatuses: {},
    catInvocations: {},
    activeInvocations: {},
    threadStates: {},
    currentThreadId: OPEN,
  });
  useToastStore.setState({ toasts: [] });
}

function send(msg: AgentEvent) {
  act(() => {
    captured?.handleAgentMessage(msg);
  });
}

function event(threadId: string, fields: Partial<AgentEvent> & Pick<AgentEvent, 'type'>): AgentEvent {
  clock += 10;
  return { catId: CAT, threadId, invocationId: INV, timestamp: clock, ...fields };
}

function streamText(threadId: string, content: string, fields: Partial<AgentEvent> = {}): AgentEvent {
  return event(threadId, { type: 'text', origin: 'stream', content, messageId: R, ...fields });
}

/** A system_info event naming R (the server stamps it), or naming nothing when `messageId` is null. */
function systemInfo(threadId: string, payload: Record<string, unknown>, messageId: string | null = R) {
  return event(threadId, {
    type: 'system_info',
    content: JSON.stringify(payload),
    ...(messageId ? { messageId } : {}),
  });
}

function responseLifecycle(
  status: 'processing' | 'completed',
): Extract<LifecycleStoredMessageMetadata, { kind: 'response' }> {
  return {
    kind: 'response',
    orderKey: 'order-1',
    invocationId: INV,
    targetId: CAT,
    inputEntryIds: ['entry-1'],
    inputMessageIds: ['user-1'],
    status,
    startedAt: 1_000,
    ...(status === 'completed' ? { completedAt: 2_000 } : {}),
  };
}

/** What useSocket does with `message_lifecycle_updated`: write R's stored snapshot under its server id. */
function publishResponse(threadId: string, status: 'processing' | 'completed' = 'processing', content = '') {
  writeStoredSnapshot(threadId, {
    id: R,
    type: 'assistant',
    catId: CAT,
    content,
    lifecycle: responseLifecycle(status),
    timestamp: 1_000,
  });
}

const messagesOf = (threadId: string): ChatMessage[] => useChatStore.getState().getThreadState(threadId).messages;
const messageIn = (threadId: string, id: string) => messagesOf(threadId).find((message) => message.id === id);
const assistantIds = (threadId: string) =>
  messagesOf(threadId)
    .filter((message) => message.type === 'assistant')
    .map((message) => message.id);
const systemRows = (threadId: string) => messagesOf(threadId).filter((message) => message.type === 'system');

const card: RichBlock = { id: 'block-1', kind: 'card', v: 1, title: 'Result card' };

const silentWarning: LivenessWarningSnapshot = {
  level: 'alive_but_silent',
  state: 'busy-silent',
  silenceDurationMs: 120_000,
  processAlive: true,
  receivedAt: 5_000,
};

describe('F117 named-message writes', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    resetStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(React.createElement(Harness));
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    captured = undefined;
  });

  describe.each([
    ['open thread', OPEN],
    ['background thread', BG],
  ])('%s', (_label, threadId) => {
    it('appends stream text into R and replaces it for textMode=replace', () => {
      publishResponse(threadId);
      send(streamText(threadId, 'Hello'));
      send(streamText(threadId, ' world'));
      expect(messageIn(threadId, R)).toMatchObject({ content: 'Hello world', isStreaming: true });

      send(streamText(threadId, 'Rewritten', { textMode: 'replace' }));
      expect(messageIn(threadId, R)?.content).toBe('Rewritten');
      expect(assistantIds(threadId)).toEqual([R]);
    });

    it('writes tool_use, tool_result, web_search, thinking and rich_block into R', () => {
      publishResponse(threadId);
      send(event(threadId, { type: 'tool_use', messageId: R, toolName: 'Read', toolInput: { path: 'a.ts' } }));
      send(event(threadId, { type: 'tool_result', messageId: R, content: 'file body' }));
      send(systemInfo(threadId, { type: 'web_search', count: 2 }));
      send(systemInfo(threadId, { type: 'thinking', text: 'Considering options' }));
      send(systemInfo(threadId, { type: 'rich_block', block: card }));

      const response = messageIn(threadId, R);
      expect(response?.toolEvents?.map((toolEvent) => toolEvent.label)).toEqual([
        'opus → Read',
        'opus ← result',
        'opus → web_search x2',
      ]);
      expect(response?.toolEvents?.[0]?.detail).toBe('{"path":"a.ts"}');
      expect(response?.toolEvents?.[1]?.detail).toBe('file body');
      expect(response?.thinking).toBe('Considering options');
      expect(response?.extra?.rich?.blocks.map((block) => block.id)).toEqual(['block-1']);
      expect(assistantIds(threadId)).toEqual([R]);
    });

    it('creates R under its server id when the first body event arrives before its snapshot', () => {
      send(event(threadId, { type: 'tool_use', messageId: R, toolName: 'Grep' }));
      send(streamText(threadId, 'first words'));

      expect(assistantIds(threadId)).toEqual([R]);
      expect(messageIn(threadId, R)).toMatchObject({
        id: R,
        type: 'assistant',
        catId: CAT,
        content: 'first words',
        isStreaming: true,
      });
    });

    it('keeps each post_message as its own message beside R; replay adds nothing; later chunks land in R', () => {
      publishResponse(threadId);
      send(streamText(threadId, 'Working'));
      const post = event(threadId, {
        type: 'text',
        origin: 'callback',
        content: 'Posted update',
        messageId: 'post-1',
        extra: { isExplicitPost: true },
      });
      send(post);
      send(post);
      send(
        event(threadId, {
          type: 'text',
          origin: 'callback',
          content: 'Second post',
          messageId: 'post-2',
          extra: { isExplicitPost: true },
        }),
      );
      send(systemInfo(threadId, { type: 'rich_block', block: card, messageId: 'post-1' }));
      send(streamText(threadId, ' and done'));

      expect(assistantIds(threadId)).toEqual([R, 'post-1', 'post-2']);
      expect(messageIn(threadId, R)?.content).toBe('Working and done');
      expect(messageIn(threadId, R)?.extra?.rich).toBeUndefined();
      expect(messageIn(threadId, 'post-1')).toMatchObject({
        content: 'Posted update',
        origin: 'callback',
        isStreaming: false,
      });
      expect(messageIn(threadId, 'post-1')?.extra?.rich?.blocks.map((block) => block.id)).toEqual(['block-1']);
    });

    it('writes no bubble for events without messageId (status only)', () => {
      send(event(threadId, { type: 'text', origin: 'stream', content: 'orphan text' }));
      send(event(threadId, { type: 'tool_use', toolName: 'Read' }));
      send(event(threadId, { type: 'text', origin: 'callback', content: 'orphan post' }));
      send(systemInfo(threadId, { type: 'thinking', text: 'orphan thought' }, null));
      send(systemInfo(threadId, { type: 'rich_block', block: card }, null));

      expect(messagesOf(threadId)).toEqual([]);
      expect(useChatStore.getState().getThreadState(threadId).catStatuses[CAT]).toBe('streaming');
    });

    it('changes nothing for stream events after R is committed — not R, not status, liveness or activity', () => {
      publishResponse(threadId, 'completed', 'Final answer');
      const store = useChatStore.getState();
      store.updateThreadCatStatus(threadId, CAT, 'done');
      store.setThreadCatInvocation(threadId, CAT, { livenessWarning: silentWarning });
      const committed = messageIn(threadId, R);
      const before = useChatStore.getState().getThreadState(threadId);

      send(streamText(threadId, ' late chunk'));
      send(event(threadId, { type: 'tool_use', messageId: R, toolName: 'Read' }));
      send(event(threadId, { type: 'tool_result', messageId: R, content: 'late output' }));
      send(systemInfo(threadId, { type: 'web_search', count: 1 }));
      send(systemInfo(threadId, { type: 'thinking', text: 'late thought' }));

      // Same object: body, streaming flag and timeline activity (timestamp / timelineOrderAt) untouched.
      expect(messageIn(threadId, R)).toBe(committed);
      expect(committed).toMatchObject({ content: 'Final answer' });
      const after = useChatStore.getState().getThreadState(threadId);
      expect(after.catStatuses[CAT]).toBe('done');
      expect(after.catInvocations[CAT]?.livenessWarning).toEqual(silentWarning);
      expect(after.activeInvocations).toEqual(before.activeInvocations);
      expect(after.isLoading).toBe(before.isLoading);
    });

    it('stops R streaming on done', () => {
      publishResponse(threadId);
      send(streamText(threadId, 'answer'));
      expect(messageIn(threadId, R)?.isStreaming).toBe(true);

      send(event(threadId, { type: 'done', messageId: R, isFinal: true }));
      expect(messageIn(threadId, R)).toMatchObject({ content: 'answer', isStreaming: false });
      expect(systemRows(threadId)).toEqual([]);
    });

    it('keeps R streamed text when done carries empty content; the committed snapshot is the final truth', () => {
      publishResponse(threadId);
      send(streamText(threadId, 'streamed answer'));

      send(event(threadId, { type: 'done', messageId: R, content: '', isFinal: true }));
      expect(messageIn(threadId, R)).toMatchObject({ content: 'streamed answer', isStreaming: false });

      publishResponse(threadId, 'completed', 'committed answer');
      expect(messageIn(threadId, R)).toMatchObject({ content: 'committed answer', isStreaming: false });
    });

    it('adds no row for an error naming R; R stops streaming unless the error is recoverable in flight', () => {
      publishResponse(threadId);
      send(streamText(threadId, 'partial'));

      send(event(threadId, { type: 'error', messageId: R, error: 'tool hiccup', errorCode: 'tool_error' }));
      expect(messageIn(threadId, R)?.isStreaming).toBe(true);

      send(event(threadId, { type: 'error', messageId: R, error: 'provider exploded', isFinal: true }));
      expect(systemRows(threadId)).toEqual([]);
      expect(messageIn(threadId, R)).toMatchObject({ content: 'partial', isStreaming: false });
    });

    it('writes timeout diagnostics into the response they name, not into an error row', () => {
      publishResponse(threadId);
      send(
        systemInfo(threadId, {
          type: 'timeout_diagnostics',
          silenceDurationMs: 1_800_000,
          processAlive: true,
          lastEventType: 'thread.started',
          invocationId: INV,
        }),
      );

      expect(messageIn(threadId, R)?.extra?.timeoutDiagnostics).toMatchObject({
        silenceDurationMs: 1_800_000,
        processAlive: true,
        lastEventType: 'thread.started',
        invocationId: INV,
      });
      expect(systemRows(threadId)).toEqual([]);
    });

    it('keeps reconnect attempts on R, silently recovers and ignores a late reconnect after terminal', () => {
      publishResponse(threadId);
      send(
        systemInfo(threadId, {
          type: 'provider_recovery',
          provider: 'codex',
          phase: 'reconnecting',
          attempt: 1,
          attempts: ['socket disconnected'],
        }),
      );
      expect(messageIn(threadId, R)?.extra?.providerRecovery).toMatchObject({
        phase: 'reconnecting',
        attempts: ['socket disconnected'],
      });
      expect(systemRows(threadId)).toEqual([]);
      expect(useChatStore.getState().getThreadState(threadId).catStatuses[CAT]).toBe('spawning');
      send(
        systemInfo(threadId, {
          type: 'provider_recovery',
          provider: 'codex',
          phase: 'recovered',
          attempts: ['socket disconnected'],
          evidence: 'item.completed',
        }),
      );
      expect(messageIn(threadId, R)?.extra?.providerRecovery).toMatchObject({
        phase: 'recovered',
        evidence: 'item.completed',
      });
      expect(systemRows(threadId)).toEqual([]);
      publishResponse(threadId, 'completed', 'answer');
      const committed = messageIn(threadId, R);
      send(
        systemInfo(threadId, {
          type: 'provider_recovery',
          provider: 'codex',
          phase: 'failed',
          attempts: ['late reconnect'],
        }),
      );
      expect(messageIn(threadId, R)).toBe(committed);
      expect(systemRows(threadId)).toEqual([]);
    });

    it.each([
      { catId: 'codex-sol' },
      { invocationId: 'other-invocation' },
    ])('does not attach a foreign recovery event to R: %j', (foreignIdentity) => {
      publishResponse(threadId);
      const before = messageIn(threadId, R);
      send({
        ...systemInfo(threadId, { type: 'provider_recovery', provider: 'codex', phase: 'failed' }),
        ...foreignIdentity,
      });
      expect(messageIn(threadId, R)).toBe(before);
      expect(messageIn(threadId, R)?.extra?.providerRecovery).toBeUndefined();
      expect(systemRows(threadId)).toEqual([]);
    });

    it('binds recovery to the exact child response while the event carries its outer parent', () => {
      publishResponse(threadId);
      useChatStore.getState().patchThreadMessage(threadId, R, {
        lifecycle: { ...responseLifecycle('processing'), invocationId: 'exact-child' },
        extra: { stream: { invocationId: INV, turnInvocationId: 'exact-child' } },
      });
      send({
        ...systemInfo(threadId, { type: 'provider_recovery', provider: 'codex', phase: 'recovered' }),
        turnInvocationId: 'exact-child',
      });
      expect(messageIn(threadId, R)?.extra?.providerRecovery).toMatchObject({
        invocationId: 'exact-child',
        parentInvocationId: INV,
        phase: 'recovered',
      });
      const before = messageIn(threadId, R);
      send({
        ...systemInfo(threadId, { type: 'provider_recovery', provider: 'codex', phase: 'failed' }),
        turnInvocationId: 'sibling-child',
      });
      expect(messageIn(threadId, R)).toBe(before);
      expect(systemRows(threadId)).toEqual([]);
    });

    it('retains failed reconnect evidence without inventing a failure result before the canonical snapshot', () => {
      publishResponse(threadId);
      send(
        systemInfo(threadId, {
          type: 'provider_recovery',
          provider: 'codex',
          phase: 'failed',
          evidence: 'cli_error',
          attempts: ['disconnected'],
        }),
      );
      expect(messageIn(threadId, R)?.extra?.providerRecovery).toMatchObject({ phase: 'failed', evidence: 'cli_error' });
      expect(messageIn(threadId, R)?.lifecycle).toMatchObject({ kind: 'response', status: 'processing' });
      expect(systemRows(threadId)).toEqual([]);
    });

    it('keeps automatic retry and session handoff inside the invocation rather than chat or unread', () => {
      publishResponse(threadId);
      send({
        ...systemInfo(threadId, {
          type: 'warning',
          presentation: 'transient_status',
          message: 'capacity retry in 20s',
        }),
        type: 'provider_signal',
      });
      expect(useChatStore.getState().getThreadState(threadId).catStatusDetails[CAT]).toBe('capacity retry in 20s');
      send(
        systemInfo(threadId, {
          type: 'session_seal_requested',
          catId: CAT,
          sessionSeq: 3,
          continuityDiagnostics: { source: 'runtime_replacement' },
        }),
      );
      expect(useChatStore.getState().getThreadState(threadId).catInvocations[CAT]).toMatchObject({
        sessionSeq: 3,
        sessionSealed: true,
      });
      expect(messagesOf(threadId).map((message) => message.id)).toEqual([R]);
      expect(useChatStore.getState().getThreadState(threadId).unreadCount).toBe(0);
    });

    it('keeps no-text completion diagnostics on R without adding another result notification', () => {
      publishResponse(threadId);
      const cliDiagnostics = {
        reasonCode: 'silent_completion' as const,
        publicSummary: '无正文输出',
        publicHint: '可查看工具结果',
        debugRef: { command: 'codex', exitCode: 0, signal: null },
      };
      send({
        ...systemInfo(threadId, { type: 'silent_completion', detail: 'no text' }),
        metadata: { provider: 'openai', model: 'fixture', cliDiagnostics },
      });
      expect(systemRows(threadId)).toEqual([]);
      expect(messageIn(threadId, R)?.extra?.cliDiagnostics).toEqual(cliDiagnostics);
    });

    it('an unnamed completion diagnostic cannot create a second result or guess a response', () => {
      publishResponse(threadId);
      send(systemInfo(threadId, { type: 'silent_completion', detail: 'no text' }, null));
      expect(systemRows(threadId)).toEqual([]);
      expect(messageIn(threadId, R)?.extra?.cliDiagnostics).toBeUndefined();
    });

    it('adds one error row with its own id for an error without messageId, even when repeated', () => {
      publishResponse(threadId);
      send(event(threadId, { type: 'error', error: 'member unavailable' }));
      send(event(threadId, { type: 'error', error: 'member unavailable', isFinal: true }));

      const rows = systemRows(threadId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ variant: 'error', content: 'Error: member unavailable', catId: CAT });
      expect(rows[0]?.id).not.toBe(R);
      expect(messageIn(threadId, R)).toMatchObject({ type: 'assistant', content: '' });
    });
  });

  describe('background thread unread', () => {
    const unread = () => useChatStore.getState().getThreadState(BG).unreadCount;

    it('counts one unread when the published R first gains a body', () => {
      publishResponse(BG);
      expect(unread()).toBe(0);

      send(event(BG, { type: 'tool_use', messageId: R, toolName: 'Read' }));
      expect(unread()).toBe(1);
      send(streamText(BG, 'more output'));
      send(systemInfo(BG, { type: 'thinking', text: 'still thinking' }));
      expect(unread()).toBe(1);
    });

    it('counts one unread when the first body event creates R', () => {
      send(streamText(BG, 'first'));
      send(streamText(BG, ' second'));
      expect(unread()).toBe(1);
    });

    it('counts one unread when the committed snapshot first gives R a body (no streamed output reached here)', () => {
      publishResponse(BG);
      expect(unread()).toBe(0);

      publishResponse(BG, 'completed', 'final answer');
      expect(unread()).toBe(1);

      send(streamText(BG, 'late chunk'));
      expect(unread()).toBe(1);
      expect(messageIn(BG, R)?.content).toBe('final answer');
    });

    it('counts one unread when the committed snapshot overtakes buffered output and creates R', () => {
      publishResponse(BG, 'completed', 'final answer');
      expect(unread()).toBe(1);

      send(streamText(BG, 'buffered chunk'));
      expect(unread()).toBe(1);
      expect(messageIn(BG, R)?.content).toBe('final answer');
    });

    it('never double counts when streamed output gives R its body before the committed snapshot', () => {
      publishResponse(BG);
      send(streamText(BG, 'streamed'));
      expect(unread()).toBe(1);

      publishResponse(BG, 'completed', 'streamed');
      expect(unread()).toBe(1);
    });

    it('never double counts when the first streamed event creates R before the committed snapshot', () => {
      send(streamText(BG, 'streamed'));
      expect(unread()).toBe(1);

      publishResponse(BG, 'completed', 'streamed');
      expect(unread()).toBe(1);
    });

    it('counts nothing for a committed snapshot that has nothing to show', () => {
      publishResponse(BG);
      publishResponse(BG, 'completed', '');
      expect(unread()).toBe(0);
    });

    it('never counts unread for the open thread', () => {
      publishResponse(OPEN);
      send(streamText(OPEN, 'visible now'));
      publishResponse(OPEN, 'completed', 'visible now');
      expect(useChatStore.getState().getThreadState(OPEN).unreadCount).toBe(0);
    });
  });
});
