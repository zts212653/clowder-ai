import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { ChatMessage } from '../ChatMessage';

vi.mock('@/utils/api-client', () => ({ API_URL: 'http://api.test', apiFetch: vi.fn(async () => new Response('{}')) }));
(globalThis as { React?: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));
it('keeps recovery actions mounted on the real persisted routing receipt', async () => {
  await act(async () =>
    root.render(
      <ChatMessage
        threadId="thread-routing"
        getCatById={() => undefined}
        message={{
          id: 'receipt',
          type: 'system',
          content: '',
          timestamp: 1,
          extra: {
            systemInfo: {
              v: 1,
              payload: {
                type: 'routing_preflight',
                v: 1,
                ownerId: 'owner',
                observedAt: 1,
                resolverState: 'fresh',
                sourceMessageId: 'source',
                target: {
                  targetCatId: 'codex-astra',
                  disposition: 'rejected',
                  alternatives: [],
                  reasons: [{ code: 'quota_exhausted', summary: 'quota exhausted', sourceRefs: ['quota:1'] }],
                },
              },
            },
          },
        }}
      />,
    ),
  );
  expect(container.textContent).toContain('本次未执行');
  const team = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '查看其他成员');
  expect(team).toBeDefined();
  act(() => team?.click());
  expect(useChatStore.getState().workspaceMode).toBe('team');
});

it('hides a persisted advisory receipt after reload instead of falling back to its old visible content', async () => {
  const oldContent = '小太阳：已恢复 9 条历史状态记录；Execution capacity is unverified。本次仍按原目标尝试。';
  await act(async () =>
    root.render(
      <ChatMessage
        threadId="thread-routing"
        getCatById={() => undefined}
        message={{
          id: 'old-advisory-receipt',
          type: 'system',
          content: oldContent,
          timestamp: 1,
          extra: {
            systemInfo: {
              v: 1,
              payload: {
                type: 'routing_preflight',
                target: {
                  targetCatId: 'codex61-sol',
                  disposition: 'warned',
                  reasons: [{ code: 'routing_capacity_unverified', summary: oldContent, sourceRefs: [] }],
                },
              },
            },
          },
        }}
      />,
    ),
  );
  expect(container.textContent).toBe('');
  expect(container.querySelector('button')).toBeNull();
});
