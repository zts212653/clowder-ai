import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { primeCoCreatorConfigCache, resetCoCreatorConfigCacheForTest } from '@/hooks/useCoCreatorConfig';
import type { ChatMessage as Message } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { ChatMessage } from '../ChatMessage';

vi.mock('@/utils/api-client', () => ({ API_URL: 'http://api.test', apiFetch: vi.fn(async () => new Response('{}')) }));

describe('actual response owns its complete error without duplicate diagnostics', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeAll(() => Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true }));
  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    primeCoCreatorConfigCache({ name: 'lang', aliases: [], mentionPatterns: [] });
    useChatStore.setState({ currentThreadId: 'thread', messages: [], threads: [], isLoadingThreads: false });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetCoCreatorConfigCacheForTest();
  });

  // Unknown provider reason codes can arrive over the wire; exercise that boundary too.
  const cli = (reasonCode: string): NonNullable<Message['extra']> =>
    JSON.parse(
      JSON.stringify({
        cliDiagnostics: {
          reasonCode,
          publicSummary: 'provider exit cause',
          publicHint: 'check credentials',
          debugRef: { command: 'codex', exitCode: 1, signal: null, invocationId: 'turn' },
        },
      }),
    );
  const timeout = { timeoutDiagnostics: { silenceDurationMs: 1846576, processAlive: true, invocationId: 'turn' } };
  it.each([
    ['classified CLI', cli('auth_failed')],
    ['unknown CLI', cli('future_reason')],
    ['timeout', timeout],
  ] as const)('%s renders the full failure once in the response', (_name, extra) => {
    const message: Message = {
      id: 'response',
      type: 'assistant',
      catId: 'opus',
      content: 'complete provider error\nwith the original detailed failure',
      timestamp: 1,
      extra,
      lifecycle: {
        kind: 'response',
        orderKey: '1:response',
        invocationId: 'turn',
        targetId: 'opus',
        inputEntryIds: ['entry'],
        inputMessageIds: ['source'],
        status: 'failed',
        startedAt: 1,
        completedAt: 2,
      },
    };
    act(() => root.render(<ChatMessage message={message} threadId="thread" getCatById={() => undefined} />));
    expect(container.textContent).toContain('complete provider error');
    expect(container.textContent).toContain('with the original detailed failure');
    expect(container.textContent?.match(/complete provider error/g)).toHaveLength(1);
    expect(container.querySelector('[data-testid="cli-diagnostics"]')).toBeNull();
    expect(container.querySelector('[data-testid="timeout-diagnostics"]')).toBeNull();
    expect(container.textContent).not.toContain('查看详细错误');
    expect(container.textContent).not.toContain('provider exit cause');
    expect(container.textContent).not.toContain('check credentials');
    expect(message.extra).toBe(extra);
  });

  it('a standalone admission failure still shows its only error banner', () => {
    const message: Message = {
      id: 'admission-failure',
      type: 'system',
      variant: 'error',
      catId: 'opus',
      content: 'admission rejected',
      timestamp: 1,
      extra: cli('auth_failed'),
    };
    act(() => root.render(<ChatMessage message={message} threadId="thread" getCatById={() => undefined} />));
    expect(container.querySelector('[data-testid="cli-diagnostics-banner"]')?.textContent).toContain(
      'provider exit cause',
    );
  });
});
