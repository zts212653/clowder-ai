import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { __resetChatScrollMemoryForTest, saveChatScrollState } from '@/utils/chat-scroll-memory';
import { CausalReplyProvider, useCausalReplies } from '../CausalReplyContext';

function Probe() {
  const value = useCausalReplies();
  return (
    <output>
      {JSON.stringify({
        originals: [...(value?.originals.keys() ?? [])],
        ranges: [...(value?.continuations.entries() ?? [])].flatMap(([input, slices]) =>
          slices.map((slice) => ({ input, start: slice.start, end: slice.end })),
        ),
      })}
    </output>
  );
}

it('keeps committed ranges while their response is being read and still appends current text', async ({
  onTestFinished,
}) => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('crypto', { subtle: { digest: async () => new Uint8Array(32).fill(0xaa).buffer } });
  __resetChatScrollMemoryForTest();
  const host = document.createElement('div');
  document.body.appendChild(host);
  let root = createRoot(host);
  onTestFinished(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    __resetChatScrollMemoryForTest();
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  const threadId = 'causal-reading-test';
  const input = (id: string, timestamp: number): ChatMessage => ({
    id,
    timestamp,
    type: 'assistant',
    catId: 'dsh',
    content: id,
    lifecycle: {
      kind: 'input',
      orderKey: `${timestamp}:${id}`,
      dispatchRefs: [{ targetId: 'codex', statusMessageId: 'R', phase: 'settled', dispatchedAt: timestamp }],
    },
  });
  const first = input('S1', 2),
    second = input('S2', 3),
    third = input('S3', 4);
  const boundary = (id: string, contentOffset: number) => ({
    inputMessageId: id,
    contentOffset,
    prefixSha256: 'a'.repeat(64),
  });
  const response: ChatMessage = {
    id: 'R',
    timestamp: 1,
    type: 'assistant',
    catId: 'codex',
    origin: 'stream',
    content: 'prefix\n\ntail',
    lifecycle: {
      kind: 'response',
      orderKey: '1:turn',
      invocationId: 'turn',
      targetId: 'codex',
      inputEntryIds: ['entry'],
      inputMessageIds: ['S1', 'S2', 'S3'],
      status: 'completed',
      startedAt: 1,
      completedAt: 4,
      appendBoundaries: [boundary('S1', 8)],
    },
  };
  const render = async (message: ChatMessage) =>
    act(async () =>
      root.render(
        <CausalReplyProvider threadId={threadId} messages={[message, first, second, third]}>
          <Probe />
        </CausalReplyProvider>,
      ),
    );
  const result = () =>
    JSON.parse(host.textContent ?? '{}') as {
      originals: string[];
      ranges: { input: string; start: number; end: number }[];
    };
  saveChatScrollState(threadId, {
    top: 100,
    anchor: 'offset',
    messageAnchor: { messageId: 'R', viewportOffsetPx: -100 },
  });
  await render(response);
  expect(result().originals).toEqual([]);
  saveChatScrollState(threadId, { top: 1000, anchor: 'bottom' });
  await render({ ...response });
  expect(result().ranges).toEqual([{ input: 'S1', start: 8, end: response.content.length }]);
  saveChatScrollState(threadId, {
    top: 200,
    anchor: 'offset',
    messageAnchor: { messageId: 'S1', viewportOffsetPx: -100 },
  });
  const updated = {
    ...response,
    content: response.content + ' new result',
    lifecycle: {
      ...response.lifecycle,
      appendBoundaries: [boundary('S1', 8), boundary('S2', response.content.length)],
    },
  } as ChatMessage;
  await render(updated);
  expect(result().ranges).toEqual([{ input: 'S1', start: 8, end: updated.content.length }]);
  saveChatScrollState(threadId, { top: 1000, anchor: 'bottom' });
  await render({ ...updated });
  expect(result().ranges.map((range) => range.input)).toEqual(['S1', 'S2']);
  saveChatScrollState(threadId, {
    top: 200,
    anchor: 'offset',
    messageAnchor: { messageId: 'S1', viewportOffsetPx: -100 },
  });
  act(() => root.unmount());
  root = createRoot(host);
  await render(response);
  expect(result().ranges).toEqual([{ input: 'S1', start: 8, end: response.content.length }]);
  saveChatScrollState(threadId, {
    top: 100,
    anchor: 'offset',
    messageAnchor: { messageId: 'R', viewportOffsetPx: -100 },
  });
  const replaced = {
    ...response,
    lifecycle: { ...response.lifecycle, appendBoundaries: [boundary('S2', 8)] },
  } as ChatMessage;
  await render(replaced);
  expect(result().ranges.map((range) => range.input)).toEqual(['S2']);
  const unrelatedGrowth = {
    ...response,
    lifecycle: { ...response.lifecycle, appendBoundaries: [boundary('S1', 8), boundary('S3', 10)] },
  } as ChatMessage;
  await render(unrelatedGrowth);
  expect(result().ranges.map((range) => range.input)).toEqual(['S1', 'S3']);
  await render({ ...response, lifecycle: { ...response.lifecycle, appendBoundaries: [] } } as ChatMessage);
  expect(result().ranges).toEqual([]);
});
