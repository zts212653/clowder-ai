/**
 * F212 Phase B 云端 codex P2 regression (2026-05-27):
 *
 * Cold history hydration (F5 / re-fetch) must copy `metadata.cliDiagnostics`
 * from stored error messages into `extra.cliDiagnostics`, otherwise the
 * `ChatMessage` folded panel disappears after page reload even though the
 * stored payload still carries the data.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { useChatHistory } from '../useChatHistory';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

let capturedHook: ReturnType<typeof useChatHistory> | null = null;

function HookHost({ threadId }: { threadId: string }) {
  capturedHook = useChatHistory(threadId);
  return React.createElement('div', {
    ref: capturedHook.scrollContainerRef,
    style: { height: '100px', overflow: 'auto' },
  });
}

const STORED_DIAGNOSTICS = {
  reasonCode: 'auth_failed' as const,
  publicSummary: 'API 认证失败',
  publicHint: '检查 .env API key',
  safeExcerpt: '401 Unauthorized: invalid api key',
  debugRef: { command: 'codex', exitCode: 1, signal: null, invocationId: 'inv-stored-1' },
};

describe('F212 Phase B — cold hydration restores cliDiagnostics (云端 codex P2)', () => {
  const apiFetchMock = vi.mocked(apiFetch);
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
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useChatStore.setState({
      messages: [],
      hasMore: false,
      isLoadingHistory: false,
      currentThreadId: 'thread-cli-diag',
      threadStates: {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    apiFetchMock.mockReset();
    capturedHook = null;
  });

  it('copies metadata.cliDiagnostics to extra.cliDiagnostics on initial hydration', async () => {
    // Stored payload as /api/messages returns it: cliDiagnostics on metadata,
    // not on extra (Phase A providers stamp metadata; api persists as-is).
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        messages: [
          {
            id: 'msg-err-1',
            type: 'system',
            variant: 'error',
            catId: 'opus',
            content: 'Error: CLI 异常退出 (code: 1)',
            metadata: { provider: 'anthropic', model: 'claude-opus', cliDiagnostics: STORED_DIAGNOSTICS },
            timestamp: 1700000000000,
          },
        ],
        tasks: [],
        hasMore: false,
      }),
    } as Response);

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId: 'thread-cli-diag' }));
    });
    // Allow useEffect microtask to flush
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const messages = useChatStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].extra?.cliDiagnostics).toEqual(STORED_DIAGNOSTICS);
  });

  it('prefers extra.cliDiagnostics when both extra and metadata carry diagnostics', async () => {
    const extraVersion = { ...STORED_DIAGNOSTICS, publicSummary: 'extra-path summary' };
    const metadataVersion = { ...STORED_DIAGNOSTICS, publicSummary: 'metadata-path summary' };
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        messages: [
          {
            id: 'msg-err-2',
            type: 'system',
            variant: 'error',
            catId: 'opus',
            content: 'Error: ...',
            metadata: { provider: 'anthropic', model: 'claude-opus', cliDiagnostics: metadataVersion },
            extra: { cliDiagnostics: extraVersion },
            timestamp: 1700000000000,
          },
        ],
        tasks: [],
        hasMore: false,
      }),
    } as Response);

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId: 'thread-cli-diag' }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const messages = useChatStore.getState().messages;
    expect(messages[0].extra?.cliDiagnostics?.publicSummary).toBe('extra-path summary');
  });

  it('no-op when neither metadata nor extra carries cliDiagnostics (regression guard)', async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        messages: [
          {
            id: 'msg-err-3',
            type: 'system',
            variant: 'error',
            catId: 'opus',
            content: 'Error: ...',
            metadata: { provider: 'anthropic', model: 'claude-opus' },
            timestamp: 1700000000000,
          },
        ],
        tasks: [],
        hasMore: false,
      }),
    } as Response);

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId: 'thread-cli-diag' }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const messages = useChatStore.getState().messages;
    expect(messages[0].extra?.cliDiagnostics).toBeUndefined();
  });

  it('preserves the durable F254 accident-recovery marker on cold hydration', async () => {
    const recovery = {
      kind: 'f254_withheld_message',
      cvoDecisionRef: '0001783820437069-000027-a6cebcce',
      recoveredAt: 1700000005000,
    };
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        messages: [
          {
            id: 'msg-recovered-1',
            type: 'assistant',
            catId: 'fable-5',
            content: '买到了，正在回家。',
            extra: { recovery },
            timestamp: 1700000000000,
          },
        ],
        tasks: [],
        hasMore: false,
      }),
    } as Response);

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId: 'thread-cli-diag' }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const hydrated = useChatStore.getState().messages[0].extra as { recovery?: typeof recovery } | undefined;
    expect(hydrated?.recovery).toEqual(recovery);
  });

  it('preserves the durable F254 supplement projection on cold hydration', async () => {
    const freshnessSupplement = {
      type: 'freshness_supplement' as const,
      supplementId: 'f254-supplement:msg-original:1',
      lineageId: 'msg-original',
      originalMessageId: 'msg-original',
      threadId: 'thread-cli-diag',
      catId: 'codex-sol',
      seq: 1 as const,
      status: 'declined' as const,
      requiredCount: 1,
      terminalReason: 'checked_no_supplement_needed',
      updatedAt: 1700000005000,
    };
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        messages: [
          {
            id: 'msg-original',
            type: 'assistant',
            catId: 'codex-sol',
            content: '原回复持续可见。',
            extra: { freshnessSupplement },
            timestamp: 1700000000000,
          },
        ],
        tasks: [],
        hasMore: false,
      }),
    } as Response);

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId: 'thread-cli-diag' }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useChatStore.getState().messages[0].extra?.freshnessSupplement).toEqual(freshnessSupplement);
  });
});
