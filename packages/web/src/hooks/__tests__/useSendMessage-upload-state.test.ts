import React, { act, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockApiFetch = vi.fn();
const mockAddMessage = vi.fn();
const mockAddMessageToThread = vi.fn();
const mockSetLoading = vi.fn();
const mockSetHasActiveInvocation = vi.fn();
const mockSetThreadLoading = vi.fn();
const mockSetThreadHasActiveInvocation = vi.fn();
const mockResetRefs = vi.fn();
const mockProcessCommand = vi.fn(async () => false);

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('@/hooks/useAgentMessages', () => ({
  useAgentMessages: () => ({ resetRefs: mockResetRefs }),
}));

vi.mock('@/hooks/useChatCommands', () => ({
  useChatCommands: () => ({ processCommand: mockProcessCommand }),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(
    () => ({
      addMessage: mockAddMessage,
      addMessageToThread: mockAddMessageToThread,
      setLoading: mockSetLoading,
      setHasActiveInvocation: mockSetHasActiveInvocation,
      setThreadLoading: mockSetThreadLoading,
      setThreadHasActiveInvocation: mockSetThreadHasActiveInvocation,
      currentThreadId: 'thread-stale',
    }),
    {
      getState: () => ({ currentThreadId: 'thread-stale' }),
    },
  ),
}));

import { useSendMessage } from '@/hooks/useSendMessage';

interface UploadSnapshot {
  status: string;
  error: string | null;
}

function SendWithImageRunner({
  onDone,
  onSnapshot,
}: {
  onDone: () => void;
  onSnapshot: (snapshot: UploadSnapshot) => void;
}) {
  const { handleSend, uploadStatus, uploadError } = useSendMessage('thread-route');
  const called = useRef(false);

  useEffect(() => {
    onSnapshot({ status: uploadStatus, error: uploadError });
  }, [uploadStatus, uploadError, onSnapshot]);

  useEffect(() => {
    if (called.current) return;
    called.current = true;
    const file = new File([new Uint8Array([1, 2, 3])], 'cat.png', { type: 'image/png' });
    handleSend('@布偶 看图', [file], undefined, undefined, 'queue', undefined, 'continue_current').then(onDone);
  }, [handleSend, onDone]);

  return null;
}

describe('useSendMessage upload status', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    if (!globalThis.URL.createObjectURL) {
      Object.defineProperty(globalThis.URL, 'createObjectURL', {
        value: vi.fn(() => 'blob:mock-image'),
        writable: true,
      });
    }
    if (!globalThis.URL.revokeObjectURL) {
      Object.defineProperty(globalThis.URL, 'revokeObjectURL', {
        value: vi.fn(),
        writable: true,
      });
    }
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    mockApiFetch.mockReset();
    mockAddMessage.mockReset();
    mockAddMessageToThread.mockReset();
    mockSetLoading.mockReset();
    mockSetHasActiveInvocation.mockReset();
    mockSetThreadLoading.mockReset();
    mockSetThreadHasActiveInvocation.mockReset();
    mockResetRefs.mockReset();
    mockProcessCommand.mockReset();
    mockProcessCommand.mockResolvedValue(false);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('transitions to uploading then failed for image send errors', async () => {
    let resolveFetch:
      | ((value: { ok: boolean; status: number; json: () => Promise<{ detail: string }> }) => void)
      | null = null;
    mockApiFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const snapshots: UploadSnapshot[] = [];

    await act(async () => {
      root.render(
        React.createElement(SendWithImageRunner, {
          onDone: () => {},
          onSnapshot: (s: UploadSnapshot) => snapshots.push(s),
        }),
      );
    });

    expect(snapshots.some((s) => s.status === 'uploading')).toBe(true);

    await act(async () => {
      resolveFetch?.({
        ok: false,
        status: 500,
        json: async () => ({ detail: '上传超时' }),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    const last = snapshots[snapshots.length - 1];
    expect(last.status).toBe('failed');
    expect(last.error).toContain('上传超时');
    expect(mockAddMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'system',
        variant: 'error',
        content: expect.stringContaining('Failed to send message: 上传超时'),
      }),
    );
  });

  it('sends the typed author disposition in multipart admission', async () => {
    mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({ userMessageId: 'message-1' }) });

    await act(async () => {
      root.render(
        React.createElement(SendWithImageRunner, {
          onDone: () => {},
          onSnapshot: () => {},
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const form = mockApiFetch.mock.calls[0]?.[1]?.body as FormData;
    expect(form.get('messageDisposition')).toBe('continue_current');
  });
});
