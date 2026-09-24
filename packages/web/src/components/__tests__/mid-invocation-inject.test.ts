/**
 * F24: Mid-invocation message injection regression tests.
 * During active work the composer stays simple: Stop is always available,
 * and one ordinary Send appears only after the author types. Queue-owned
 * Steer remains a separate operation on a persisted Queue entry.
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

  it('shows only Stop when hasActiveInvocation=true, disabled=false, no text', () => {
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
    expect(micBtn).toBeNull();
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

  it('keeps the sole selected member focused and gives an unsupported target an immediate Steer action', () => {
    const onConfirm = vi.fn();
    const targets = [
      {
        id: 'codex',
        label: '缅因猫',
        canGuideReply: true,
        disposition: 'continue_current' as const,
      },
      {
        id: 'kimi',
        label: '狸花猫',
        canGuideReply: false,
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

    expect(container.textContent).not.toContain('发送给 狸花猫');
    expect(container.textContent).not.toContain('调整这条队列消息的接收成员与发送方式');
    expect(container.querySelector('[data-testid="steer-interrupt-reply"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector<HTMLButtonElement>('[data-testid="steer-confirm"]')?.disabled).toBe(false);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="steer-confirm"]')?.click());
    expect(onConfirm).toHaveBeenCalledWith({
      observedPendingTargetIds: [],
      actions: [{ targetId: 'kimi', strategy: 'interrupt_reply', membershipAtOpen: 'member' }],
    });
    expect(container.querySelector('[role="dialog"]')?.className).toContain('rounded-2xl');
    const tooltip = container.querySelector('[data-testid="steer-guide-unavailable-tooltip"]');
    expect(tooltip?.getAttribute('role')).toBe('tooltip');
    expect(tooltip?.textContent).toBe('当前成员的接入方式不支持引导回复');
    expect(tooltip?.className).toContain('bg-[var(--cafe-text)]');
    expect(tooltip?.className).toContain('text-[var(--cafe-surface-canvas)]');
  });

  it('uses the layer-four modal surface and marks target selection only in the leading control', () => {
    act(() => {
      root.render(
        React.createElement(SteerQueuedEntryModal, {
          targets: [
            {
              id: 'codex',
              label: '缅因猫',
              canGuideReply: true,
              defaultSelected: true,
            },
          ],
          onCancel: vi.fn(),
          onConfirm: vi.fn(),
        }),
      );
    });

    const dialog = container.querySelector('[role="dialog"]');
    const target = container.querySelector('[data-testid="steer-target-codex"]');
    const indicator = container.querySelector('[data-testid="steer-target-indicator-codex"]');
    const strategyOptions = container.querySelector('[data-testid="steer-strategy-options"]');
    const guideStrategy = container.querySelector('[data-testid="steer-guide-reply"]');
    expect(dialog?.className).toContain('bg-cafe-surface-canvas');
    expect(dialog?.className).toContain('max-w-md');
    expect(dialog?.className).not.toContain('max-w-lg');
    expect(target?.className).not.toContain('color-cocreator-surface');
    expect(target?.className).not.toContain('border-[var(--color-cocreator-primary)]');
    expect(indicator?.className).toContain('bg-[var(--color-cocreator-primary)]');
    expect(strategyOptions?.className).not.toContain('bg-cafe-surface');
    expect(guideStrategy?.className).toContain('bg-cafe-surface-sunken');
    const footer = container.querySelector('[data-testid="steer-confirm"]')?.parentElement;
    expect(footer?.className).not.toContain('border-t');
  });

  it('derives guide availability from member configuration without live-run input', () => {
    act(() => {
      root.render(
        React.createElement(SteerQueuedEntryModal, {
          targets: [
            {
              id: 'codex',
              label: '缅因猫',
              canGuideReply: true,
              defaultSelected: true,
              disposition: 'continue_current',
            },
          ],
          onCancel: vi.fn(),
          onConfirm: vi.fn(),
        }),
      );
    });

    expect(container.querySelector<HTMLButtonElement>('[data-testid="steer-guide-reply"]')?.disabled).toBe(false);
    expect(container.querySelector('[data-testid="steer-guide-reply"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[data-testid="steer-guide-unavailable-tooltip"]')).toBeNull();
  });

  it('uses the saved next-work default even when the member supports guide delivery', () => {
    const onConfirm = vi.fn();
    act(() => {
      root.render(
        React.createElement(SteerQueuedEntryModal, {
          targets: [
            {
              id: 'codex',
              label: '缅因猫',
              canGuideReply: true,
              defaultSelected: true,
              disposition: 'next_work',
            },
          ],
          onCancel: vi.fn(),
          onConfirm,
        }),
      );
    });

    expect(container.querySelector('[data-testid="steer-interrupt-reply"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector<HTMLButtonElement>('[data-testid="steer-confirm"]')?.disabled).toBe(false);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="steer-confirm"]')?.click());
    expect(onConfirm).toHaveBeenCalledWith({
      observedPendingTargetIds: [],
      actions: [{ targetId: 'codex', strategy: 'interrupt_reply', membershipAtOpen: 'member' }],
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
              defaultSelected: true,
              disposition: 'continue_current',
            },
            {
              id: 'codex',
              label: '@缅因猫',
              canGuideReply: true,
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
            disposition: 'next_work' as const,
          },
          {
            id: 'codex',
            label: '@缅因猫',
            canGuideReply: true,
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

  it('keeps an explicit guide choice across an equivalent configured-target refresh', () => {
    const onConfirm = vi.fn();
    const renderTarget = () =>
      React.createElement(SteerQueuedEntryModal, {
        targets: [
          {
            id: 'codex',
            label: '@缅因猫',
            canGuideReply: true,
            defaultSelected: true,
            disposition: 'continue_current' as const,
          },
        ],
        onCancel: vi.fn(),
        onConfirm,
      });

    act(() => root.render(renderTarget()));
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="steer-guide-reply"]')?.click());
    expect(container.querySelector('[data-testid="steer-guide-reply"]')?.getAttribute('aria-pressed')).toBe('true');

    act(() => root.render(renderTarget()));

    expect(container.querySelector('[data-testid="steer-guide-reply"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector<HTMLButtonElement>('[data-testid="steer-confirm"]')?.disabled).toBe(false);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="steer-confirm"]')?.click());
    expect(onConfirm).toHaveBeenCalledWith({
      observedPendingTargetIds: [],
      actions: [{ targetId: 'codex', strategy: 'guide_reply', membershipAtOpen: 'member' }],
    });
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
              defaultSelected: true,
              unavailable: true,
              disposition: 'continue_current',
            },
            {
              id: 'codex',
              label: '@缅因猫',
              canGuideReply: false,
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
