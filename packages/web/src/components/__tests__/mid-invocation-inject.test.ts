/**
 * F24: Mid-invocation message injection regression tests.
 * Verifies that when hasActiveInvocation=true but disabled=false,
 * both Stop and Send (or Mic) buttons coexist.
 *
 * Plus F1306 steer-confirmation identity regressions:
 *  - canonical-key A→B rejection at the component boundary
 *  - active-without-verifiable-identity fail-closed
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

  it('confirms that draft Steer stops the target reply before sending', () => {
    const onForceSend = vi.fn();

    act(() => {
      root.render(
        React.createElement(ChatInputActionButton, {
          onTranscript: vi.fn(),
          onSend: vi.fn(),
          onQueueSend: vi.fn(),
          onForceSend,
          onStop: vi.fn(),
          disabled: false,
          hasActiveInvocation: true,
          activeExecutionKey: 'test-execution',
          hasText: true,
        }),
      );
    });

    const steerBtn = container.querySelector('button[aria-label="强制停止并发送此消息"]') as HTMLButtonElement;
    expect(steerBtn).toBeTruthy();
    act(() => steerBtn.click());

    expect(onForceSend).not.toHaveBeenCalled();
    // Modal content assertions: use actual Unicode chars from SteerQueuedEntryModal
    expect(container.textContent).toContain('停止目标当前回复');
    expect(container.textContent).toContain('立即发送当前输入的消息');
    expect(container.textContent).toContain('这不是“追加到当前回复”');

    act(() => {
      (container.querySelector('[data-testid="steer-confirm"]') as HTMLButtonElement).click();
    });
    expect(onForceSend).toHaveBeenCalledTimes(1);
  });

  it('rejects stale steer confirmation when execution identity changes (A→B)', () => {
    const onForceSendA = vi.fn();

    // Render with execution A
    act(() => {
      root.render(
        React.createElement(ChatInputActionButton, {
          onTranscript: vi.fn(),
          onSend: vi.fn(),
          onQueueSend: vi.fn(),
          onForceSend: onForceSendA,
          onStop: vi.fn(),
          disabled: false,
          hasActiveInvocation: true,
          activeExecutionKey: 'inv-a',
          hasText: true,
        }),
      );
    });

    // Open steer modal (bound to inv-a)
    const steerBtn = container.querySelector('button[aria-label="强制停止并发送此消息"]') as HTMLButtonElement;
    expect(steerBtn).toBeTruthy();
    act(() => steerBtn.click());

    // Modal should be open
    expect(container.querySelector('[data-testid="steer-confirm"]')).toBeTruthy();

    // Same-render A→B: execution changes while modal is open
    const onForceSendB = vi.fn();
    act(() => {
      root.render(
        React.createElement(ChatInputActionButton, {
          onTranscript: vi.fn(),
          onSend: vi.fn(),
          onQueueSend: vi.fn(),
          onForceSend: onForceSendB,
          onStop: vi.fn(),
          disabled: false,
          hasActiveInvocation: true,
          activeExecutionKey: 'inv-b',
          hasText: true,
        }),
      );
    });

    // Modal should be dismissed — neither handler should have been called
    expect(container.querySelector('[data-testid="steer-confirm"]')).toBeNull();
    expect(onForceSendA).not.toHaveBeenCalled();
    expect(onForceSendB).not.toHaveBeenCalled();
  });

  it('does not offer Steer when execution identity is unverifiable', () => {
    act(() => {
      root.render(
        React.createElement(ChatInputActionButton, {
          onTranscript: vi.fn(),
          onSend: vi.fn(),
          onQueueSend: vi.fn(),
          onForceSend: vi.fn(),
          onStop: vi.fn(),
          disabled: false,
          hasActiveInvocation: true,
          // activeExecutionKey intentionally omitted (undefined)
          hasText: true,
        }),
      );
    });

    // Queue send should still be available
    const queueBtn = container.querySelector('button[aria-label="排队发送"]');
    expect(queueBtn).not.toBeNull();

    // But force-send (Steer) button must NOT be offered — fail closed
    const steerBtn = container.querySelector('button[aria-label="强制停止并发送此消息"]');
    expect(steerBtn).toBeNull();
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
