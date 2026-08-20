/**
 * F24: Mid-invocation message injection regression tests.
 * Verifies that when hasActiveInvocation=true but disabled=false,
 * both Stop and Send (or Mic) buttons coexist.
 */
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

import { ChatInputActionButton } from '../ChatInputActionButton';

describe('F24: mid-invocation message injection', () => {
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

  it('shows both Stop and Mic buttons when hasActiveInvocation=true, disabled=false, no text', () => {
    const onStop = vi.fn();

    act(() => {
      root.render(
        React.createElement(ChatInputActionButton, {
          onTranscript: vi.fn(),
          onSend: vi.fn(),
          onStop,
          disabled: false,
          hasActiveInvocation: true,
          hasText: false,
        }),
      );
    });

    const stopBtn = container.querySelector('button[aria-label="Stop generation"]');
    const micBtn = container.querySelector('button[aria-label*="voice input"]');
    expect(stopBtn).not.toBeNull();
    expect(micBtn).not.toBeNull();
  });

  it('shows both Stop and Send buttons when hasActiveInvocation=true, disabled=false, has text', () => {
    const onStop = vi.fn();
    const onSend = vi.fn();

    act(() => {
      root.render(
        React.createElement(ChatInputActionButton, {
          onTranscript: vi.fn(),
          onSend,
          onStop,
          disabled: false,
          hasActiveInvocation: true,
          hasText: true,
        }),
      );
    });

    const stopBtn = container.querySelector('button[aria-label="Stop generation"]');
    const sendBtn = container.querySelector('button[aria-label="Send message"]');
    expect(stopBtn).not.toBeNull();
    expect(sendBtn).not.toBeNull();
  });

  it('Send button is clickable during active invocation', () => {
    const onSend = vi.fn();

    act(() => {
      root.render(
        React.createElement(ChatInputActionButton, {
          onTranscript: vi.fn(),
          onSend,
          onStop: vi.fn(),
          disabled: false,
          hasActiveInvocation: true,
          hasText: true,
        }),
      );
    });

    const sendBtn = container.querySelector('button[aria-label="Send message"]');
    expect(sendBtn).not.toBeNull();

    act(() => {
      sendBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('only shows full-size Stop when disabled=true (loading state)', () => {
    act(() => {
      root.render(
        React.createElement(ChatInputActionButton, {
          onTranscript: vi.fn(),
          onSend: vi.fn(),
          onStop: vi.fn(),
          disabled: true,
          hasActiveInvocation: true,
          hasText: true,
        }),
      );
    });

    const stopBtns = container.querySelectorAll('button[aria-label="Stop generation"]');
    const sendBtn = container.querySelector('button[aria-label="Send message"]');
    // When disabled=true, only the primary (large) Stop button should exist
    expect(stopBtns.length).toBe(1);
    expect(sendBtn).toBeNull();
  });
});
