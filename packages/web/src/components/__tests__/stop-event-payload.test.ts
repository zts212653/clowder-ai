import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({
    state: 'idle',
    transcript: '',
    partialTranscript: '',
    error: null,
    duration: 0,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
  }),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: () => ({
    targetCats: ['codex', 'gemini'],
    catStatuses: { codex: 'streaming', gemini: 'pending' },
    catInvocations: {},
  }),
}));

import { ChatInputActionButton } from '@/components/ChatInputActionButton';
import { ParallelStatusBar } from '@/components/ParallelStatusBar';

describe('Stop event payload regression', () => {
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
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('ChatInputActionButton stop click does not pass MouseEvent to onStop', () => {
    const onStop = vi.fn();

    act(() => {
      root.render(
        React.createElement(ChatInputActionButton, {
          onTranscript: vi.fn(),
          onSend: vi.fn(),
          onStop,
          disabled: true,
          hasActiveInvocation: true,
          hasText: false,
        }),
      );
    });

    const stopBtn = container.querySelector('button[aria-label="Stop generation"]');
    expect(stopBtn).toBeTruthy();

    act(() => {
      stopBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStop.mock.calls[0]).toEqual([]);
  });

  it('ParallelStatusBar stop click does not pass MouseEvent to onStop', () => {
    const onStop = vi.fn();

    act(() => {
      root.render(React.createElement(ParallelStatusBar, { onStop, threadId: 'thread-test' }));
    });

    const stopBtn = container.querySelector('[data-testid="parallel-stop-button"]');
    expect(stopBtn).toBeTruthy();

    act(() => {
      stopBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStop.mock.calls[0]).toEqual([]);
  });
});
