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
import { SteerQueuedEntryModal } from '../SteerQueuedEntryModal';

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
    const onSteerSend = vi.fn();

    act(() => {
      root.render(
        React.createElement(ChatInputActionButton, {
          onTranscript: vi.fn(),
          onSend: vi.fn(),
          onQueueSend: vi.fn(),
          onSteerSend,
          steerTargets: [{ id: 'opus', label: '@布偶猫', canGuideReply: false, defaultSelected: true }],
          onStop: vi.fn(),
          disabled: false,
          hasActiveInvocation: true,
          activeExecutionKey: 'test-execution',
          hasText: true,
        }),
      );
    });

    const steerBtn = container.querySelector('button[aria-label="Steer 发送选项"]') as HTMLButtonElement;
    expect(steerBtn).toBeTruthy();
    act(() => steerBtn.click());

    expect(onSteerSend).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Steer');
    expect(container.textContent).toContain('@布偶猫');
    expect(container.textContent).toContain('立即发送，中断回复');

    expect((container.querySelector('[data-testid="steer-confirm"]') as HTMLButtonElement).disabled).toBe(false);
    act(() => {
      (container.querySelector('[data-testid="steer-confirm"]') as HTMLButtonElement).click();
    });
    expect(onSteerSend).toHaveBeenCalledTimes(1);
  });

  it('keeps the sole selected member focused and gives an unsupported target an immediate Steer action', () => {
    const onConfirm = vi.fn();
    const targets = [
      {
        id: 'codex',
        label: '缅因猫',
        canGuideReply: true,
        hasCurrentReply: true,
        disposition: 'continue_current' as const,
      },
      {
        id: 'kimi',
        label: '狸花猫',
        canGuideReply: false,
        hasCurrentReply: true,
        disposition: 'next_work' as const,
      },
    ];
    act(() => {
      root.render(
        React.createElement(SteerQueuedEntryModal, {
          targets,
          onCancel: vi.fn(),
          onConfirm,
        }),
      );
    });

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="steer-target-kimi"]')?.click());
    act(() => {
      root.render(
        React.createElement(SteerQueuedEntryModal, {
          targets: targets.map((target) => ({ ...target })),
          onCancel: vi.fn(),
          onConfirm,
        }),
      );
    });

    expect(container.textContent).toContain('发送给 狸花猫');
    expect(container.querySelector('[data-testid="steer-interrupt-reply"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector<HTMLButtonElement>('[data-testid="steer-confirm"]')?.disabled).toBe(false);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="steer-confirm"]')?.click());
    expect(onConfirm).toHaveBeenCalledWith({
      observedPendingTargetIds: [],
      actions: [{ targetId: 'kimi', strategy: 'interrupt_reply', membershipAtOpen: 'member' }],
    });
  });

  it('prefers guiding an active reply even when the member default is Queue', () => {
    const onConfirm = vi.fn();
    act(() => {
      root.render(
        React.createElement(SteerQueuedEntryModal, {
          targets: [
            {
              id: 'codex',
              label: '缅因猫',
              canGuideReply: true,
              hasCurrentReply: true,
              defaultSelected: true,
              disposition: 'next_work',
            },
          ],
          onCancel: vi.fn(),
          onConfirm,
        }),
      );
    });

    expect(container.querySelector('[data-testid="steer-guide-reply"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector<HTMLButtonElement>('[data-testid="steer-confirm"]')?.disabled).toBe(false);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="steer-confirm"]')?.click());
    expect(onConfirm).toHaveBeenCalledWith({
      observedPendingTargetIds: [],
      actions: [{ targetId: 'codex', strategy: 'guide_reply', membershipAtOpen: 'member' }],
    });
  });

  it('changes the focused member without dropping other selections and preserves mixed strategies', () => {
    const onConfirm = vi.fn();
    act(() => {
      root.render(
        React.createElement(SteerQueuedEntryModal, {
          targets: [
            {
              id: 'opus',
              label: '@布偶猫',
              canGuideReply: true,
              hasCurrentReply: true,
              defaultSelected: true,
              disposition: 'continue_current',
            },
            {
              id: 'codex',
              label: '@缅因猫',
              canGuideReply: true,
              hasCurrentReply: true,
              defaultSelected: true,
              disposition: 'continue_current',
            },
          ],
          onCancel: vi.fn(),
          onConfirm,
        }),
      );
    });

    const opus = container.querySelector<HTMLButtonElement>('[data-testid="steer-target-opus"]');
    const codex = container.querySelector<HTMLButtonElement>('[data-testid="steer-target-codex"]');
    expect(opus?.getAttribute('aria-pressed')).toBe('true');
    expect(codex?.getAttribute('aria-pressed')).toBe('true');

    act(() => codex?.click());
    expect(opus?.getAttribute('aria-pressed')).toBe('true');
    expect(codex?.getAttribute('aria-pressed')).toBe('true');
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="steer-interrupt-reply"]')?.click());
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="steer-confirm"]')?.click());

    expect(onConfirm).toHaveBeenCalledWith({
      observedPendingTargetIds: [],
      actions: [
        { targetId: 'opus', strategy: 'guide_reply', membershipAtOpen: 'member' },
        { targetId: 'codex', strategy: 'interrupt_reply', membershipAtOpen: 'member' },
      ],
    });
  });

  it('waits for the exact async fallback instead of guessing the first member', () => {
    const onConfirm = vi.fn();
    const renderTargets = (fallbackReady: boolean) =>
      React.createElement(SteerQueuedEntryModal, {
        targets: [
          {
            id: 'opus',
            label: '@布偶猫',
            canGuideReply: false,
            hasCurrentReply: false,
            disposition: 'next_work' as const,
          },
          {
            id: 'codex',
            label: '@缅因猫',
            canGuideReply: true,
            hasCurrentReply: fallbackReady,
            defaultSelected: fallbackReady,
            disposition: 'continue_current' as const,
          },
        ],
        onCancel: vi.fn(),
        onConfirm,
      });

    act(() => root.render(renderTargets(false)));
    expect(container.querySelector('[data-testid="steer-target-opus"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelector('[data-testid="steer-target-codex"]')?.getAttribute('aria-pressed')).toBe('false');

    act(() => root.render(renderTargets(true)));
    expect(container.querySelector('[data-testid="steer-target-opus"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelector('[data-testid="steer-target-codex"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[data-testid="steer-guide-reply"]')?.getAttribute('aria-pressed')).toBe('true');

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="steer-confirm"]')?.click());
    expect(onConfirm).toHaveBeenCalledWith({
      observedPendingTargetIds: [],
      actions: [{ targetId: 'codex', strategy: 'guide_reply', membershipAtOpen: 'member' }],
    });
  });

  it('does not turn an explicitly selected guide into an interrupt when the current reply disappears', () => {
    const onConfirm = vi.fn();
    const renderTarget = (hasCurrentReply: boolean) =>
      React.createElement(SteerQueuedEntryModal, {
        targets: [
          {
            id: 'codex',
            label: '@缅因猫',
            canGuideReply: true,
            hasCurrentReply,
            defaultSelected: true,
            disposition: 'continue_current' as const,
          },
        ],
        onCancel: vi.fn(),
        onConfirm,
      });

    act(() => root.render(renderTarget(true)));
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="steer-guide-reply"]')?.click());
    expect(container.querySelector('[data-testid="steer-guide-reply"]')?.getAttribute('aria-pressed')).toBe('true');

    act(() => root.render(renderTarget(false)));

    expect(container.querySelector('[data-testid="steer-interrupt-reply"]')?.getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(container.querySelector<HTMLButtonElement>('[data-testid="steer-confirm"]')?.disabled).toBe(true);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="steer-confirm"]')?.click());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('keeps unavailable members visible but outside the actionable target set', () => {
    const onConfirm = vi.fn();
    act(() => {
      root.render(
        React.createElement(SteerQueuedEntryModal, {
          targets: [
            {
              id: 'opus',
              label: '@布偶猫',
              canGuideReply: true,
              hasCurrentReply: true,
              defaultSelected: true,
              unavailable: true,
              disposition: 'continue_current',
            },
            {
              id: 'codex',
              label: '@缅因猫',
              canGuideReply: false,
              hasCurrentReply: true,
              defaultSelected: true,
              disposition: 'continue_current',
            },
          ],
          onCancel: vi.fn(),
          onConfirm,
        }),
      );
    });

    expect(container.querySelector<HTMLButtonElement>('[data-testid="steer-target-opus"]')?.disabled).toBe(true);
    expect(container.textContent).toContain('不可用');
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="steer-confirm"]')?.click());
    expect(onConfirm).toHaveBeenCalledWith({
      observedPendingTargetIds: [],
      actions: [{ targetId: 'codex', strategy: 'interrupt_reply', membershipAtOpen: 'member' }],
    });
  });

  it('rejects stale steer confirmation when execution identity changes (A→B)', () => {
    const onSteerSendA = vi.fn();

    // Render with execution A
    act(() => {
      root.render(
        React.createElement(ChatInputActionButton, {
          onTranscript: vi.fn(),
          onSend: vi.fn(),
          onQueueSend: vi.fn(),
          onSteerSend: onSteerSendA,
          steerTargets: [{ id: 'opus', label: '@布偶猫', canGuideReply: false, defaultSelected: true }],
          onStop: vi.fn(),
          disabled: false,
          hasActiveInvocation: true,
          activeExecutionKey: 'inv-a',
          hasText: true,
        }),
      );
    });

    // Open steer modal (bound to inv-a)
    const steerBtn = container.querySelector('button[aria-label="Steer 发送选项"]') as HTMLButtonElement;
    expect(steerBtn).toBeTruthy();
    act(() => steerBtn.click());

    // Modal should be open
    expect(container.querySelector('[data-testid="steer-confirm"]')).toBeTruthy();

    // Same-render A→B: execution changes while modal is open
    const onSteerSendB = vi.fn();
    act(() => {
      root.render(
        React.createElement(ChatInputActionButton, {
          onTranscript: vi.fn(),
          onSend: vi.fn(),
          onQueueSend: vi.fn(),
          onSteerSend: onSteerSendB,
          steerTargets: [{ id: 'opus', label: '@布偶猫', canGuideReply: false }],
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
    expect(onSteerSendA).not.toHaveBeenCalled();
    expect(onSteerSendB).not.toHaveBeenCalled();
  });

  it('does not offer Steer when execution identity is unverifiable', () => {
    act(() => {
      root.render(
        React.createElement(ChatInputActionButton, {
          onTranscript: vi.fn(),
          onSend: vi.fn(),
          onQueueSend: vi.fn(),
          onSteerSend: vi.fn(),
          steerTargets: [{ id: 'opus', label: '@布偶猫', canGuideReply: false }],
          onStop: vi.fn(),
          disabled: false,
          hasActiveInvocation: true,
          // activeExecutionKey intentionally omitted (undefined)
          hasText: true,
        }),
      );
    });

    // Queue send should still be available
    const queueBtn = container.querySelector('button[aria-label="排队等待"]');
    expect(queueBtn).not.toBeNull();

    // But force-send (Steer) button must NOT be offered — fail closed
    const steerBtn = container.querySelector('button[aria-label="Steer 发送选项"]');
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
