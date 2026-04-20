import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuideOverlay } from '@/components/GuideOverlay';
import type { OrchestrationFlow } from '@/stores/guideStore';
import { useGuideStore } from '@/stores/guideStore';

const apiFetchMock = vi.fn();

vi.mock('@/hooks/useGuideEngine', () => ({
  useGuideEngine: () => {},
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const FLOW: OrchestrationFlow = {
  id: 'listener-cleanup',
  name: 'Listener Cleanup',
  steps: [
    { id: 'step-1', target: 'hub.trigger', tips: 'step 1', advance: 'click' },
    { id: 'step-2', target: 'hub.trigger', tips: 'step 2', advance: 'click' },
    { id: 'step-3', target: 'hub.trigger', tips: 'step 3', advance: 'click' },
  ],
};

const CONFIRM_FLOW: OrchestrationFlow = {
  id: 'confirm-flow',
  name: 'Confirm Flow',
  steps: [{ id: 'step-confirm', target: 'member-editor.profile', tips: 'fill profile', advance: 'confirm' }],
};

const INPUT_FLOW: OrchestrationFlow = {
  id: 'input-flow',
  name: 'Input Flow',
  steps: [{ id: 'step-input', target: 'member-editor.name', tips: 'type name', advance: 'input' }],
};

const TARGET_SUBTREE_FLOW: OrchestrationFlow = {
  id: 'target-subtree-flow',
  name: 'Target Subtree Flow',
  steps: [{ id: 'step-subtree', target: 'accounts.create-details', tips: 'fill account details', advance: 'confirm' }],
};

const CARD_FLOW: OrchestrationFlow = {
  id: 'card-flow',
  name: 'Card Flow',
  steps: [
    {
      id: 'step-card',
      target: 'hub.trigger',
      tips: 'preview async card',
      advance: 'click',
      tipsMetadata: {
        type: 'card',
        target: 'async.card',
        alt: '异步卡片预览',
      },
    },
  ],
};

const INTERACTIVE_CARD_FLOW: OrchestrationFlow = {
  id: 'interactive-card-flow',
  name: 'Interactive Card Flow',
  steps: [
    {
      id: 'step-card',
      target: 'hub.trigger',
      tips: 'preview interactive card',
      advance: 'click',
      tipsMetadata: {
        type: 'card',
        target: 'interactive.card',
        alt: '交互卡片预览',
      },
    },
  ],
};

describe('GuideOverlay auto-advance lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root;
  let target: HTMLButtonElement;
  let confirmTarget: HTMLDivElement;
  let inputTarget: HTMLInputElement;
  let formTarget: HTMLDivElement;
  let formTargetInputs: HTMLInputElement[];
  let formTargetButton: HTMLButtonElement;
  let delayedCardTarget: HTMLDivElement;
  let interactiveCardTarget: HTMLDivElement;
  let rafId = 0;
  const rafHandles = new Map<number, ReturnType<typeof setTimeout>>();

  beforeAll(() => {
    (globalThis as Record<string, unknown>).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as Record<string, unknown>).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    apiFetchMock.mockReset();
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = ++rafId;
      const handle = setTimeout(() => cb(performance.now()), 16);
      rafHandles.set(id, handle);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      const handle = rafHandles.get(id);
      if (handle) {
        clearTimeout(handle);
        rafHandles.delete(id);
      }
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    target = document.createElement('button');
    target.setAttribute('data-guide-id', 'hub.trigger');
    target.textContent = 'Hub';
    document.body.appendChild(target);

    confirmTarget = document.createElement('div');
    confirmTarget.setAttribute('data-guide-id', 'member-editor.profile');
    confirmTarget.textContent = 'Member Editor';
    document.body.appendChild(confirmTarget);

    inputTarget = document.createElement('input');
    inputTarget.setAttribute('data-guide-id', 'member-editor.name');
    document.body.appendChild(inputTarget);

    formTarget = document.createElement('div');
    formTarget.setAttribute('data-guide-id', 'accounts.create-details');
    formTarget.innerHTML = `
      <input type="text" aria-label="display name" />
      <input type="url" aria-label="base url" />
      <button type="button">Create</button>
    `;
    formTargetInputs = Array.from(formTarget.querySelectorAll('input'));
    formTargetButton = formTarget.querySelector('button') as HTMLButtonElement;
    document.body.appendChild(formTarget);

    delayedCardTarget = document.createElement('div');
    delayedCardTarget.setAttribute('data-guide-id', 'async.card');
    delayedCardTarget.textContent = 'Delayed Card Content';

    interactiveCardTarget = document.createElement('div');
    interactiveCardTarget.setAttribute('data-guide-id', 'interactive.card');
    interactiveCardTarget.innerHTML = `
      <div class="rounded-xl border p-3">
        <p>Interactive Card Content</p>
        <button type="button" tabindex="0">Do thing</button>
        <a href="https://example.com">Open docs</a>
        <div data-guide-id="interactive.card.child">
          <span data-guide-id="interactive.card.grandchild">Nested helper</span>
        </div>
      </div>
    `;

    act(() => {
      root.render(React.createElement(GuideOverlay));
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    target.remove();
    confirmTarget.remove();
    inputTarget.remove();
    formTarget.remove();
    delayedCardTarget.remove();
    interactiveCardTarget.remove();
    act(() => {
      useGuideStore.getState().exitGuide();
    });
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    rafHandles.clear();
  });

  it('does not accumulate click listeners across exit + restart', () => {
    act(() => {
      useGuideStore.getState().startGuide(FLOW);
      useGuideStore.getState().setPhase('active');
    });
    act(() => {
      vi.advanceTimersByTime(120);
    });

    act(() => {
      useGuideStore.getState().exitGuide();
    });

    act(() => {
      useGuideStore.getState().startGuide(FLOW);
      useGuideStore.getState().setPhase('active');
    });
    act(() => {
      vi.advanceTimersByTime(120);
    });

    act(() => {
      target.click();
    });
    act(() => {
      vi.advanceTimersByTime(350);
    });

    expect(useGuideStore.getState().session?.currentStepIndex).toBe(1);
  });

  it('persists guide cancellation before closing the overlay', async () => {
    apiFetchMock.mockResolvedValue({ ok: true });

    act(() => {
      useGuideStore.getState().startGuide(FLOW, 'thread-1');
      useGuideStore.getState().setPhase('active');
    });
    act(() => {
      vi.advanceTimersByTime(120);
    });

    const exitButton = container.querySelector('[aria-label="退出引导"]');
    expect(exitButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      (exitButton as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/guide-actions/cancel',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: 'thread-1', guideId: 'listener-cleanup' }),
      }),
    );
    expect(useGuideStore.getState().session).toBeNull();
  });

  it('keeps the overlay open when guide cancellation returns a non-2xx response', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    apiFetchMock.mockResolvedValue({ ok: false, status: 500 });

    act(() => {
      useGuideStore.getState().startGuide(FLOW, 'thread-1');
      useGuideStore.getState().setPhase('active');
    });
    act(() => {
      vi.advanceTimersByTime(120);
    });

    const exitButton = container.querySelector('[aria-label="退出引导"]');
    expect(exitButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      (exitButton as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(useGuideStore.getState().session?.flow.id).toBe('listener-cleanup');

    consoleErrorSpy.mockRestore();
  });

  it('advances confirm steps only after a matching guide:confirm event', () => {
    act(() => {
      useGuideStore.getState().startGuide(CONFIRM_FLOW);
    });
    act(() => {
      vi.advanceTimersByTime(120);
    });

    expect(useGuideStore.getState().session?.phase).toBe('active');
    expect(useGuideStore.getState().session?.currentStepIndex).toBe(0);

    act(() => {
      window.dispatchEvent(new CustomEvent('guide:confirm', { detail: { target: 'other.target' } }));
      vi.advanceTimersByTime(180);
    });

    expect(useGuideStore.getState().session?.currentStepIndex).toBe(0);

    act(() => {
      window.dispatchEvent(new CustomEvent('guide:confirm', { detail: { target: 'member-editor.profile' } }));
      vi.advanceTimersByTime(180);
    });

    expect(useGuideStore.getState().session?.phase).toBe('complete');
  });

  it('attaches confirm listeners when the target appears after the step starts', () => {
    act(() => {
      confirmTarget.remove();
      useGuideStore.getState().startGuide(CONFIRM_FLOW);
    });
    act(() => {
      vi.advanceTimersByTime(120);
    });

    expect(useGuideStore.getState().session?.phase).toBe('locating');

    act(() => {
      document.body.appendChild(confirmTarget);
      vi.advanceTimersByTime(120);
    });

    expect(useGuideStore.getState().session?.phase).toBe('active');

    act(() => {
      vi.advanceTimersByTime(120);
      window.dispatchEvent(new CustomEvent('guide:confirm', { detail: { target: 'member-editor.profile' } }));
    });

    expect(useGuideStore.getState().session?.phase).toBe('complete');
  });

  it('renders valid Chinese aria labels for the HUD dialog and confirm action', () => {
    act(() => {
      useGuideStore.getState().startGuide(CONFIRM_FLOW);
      useGuideStore.getState().setPhase('active');
    });
    act(() => {
      vi.advanceTimersByTime(120);
    });

    expect(container.querySelector('[aria-label="引导面板"]')).toBeInstanceOf(HTMLDivElement);
    expect(container.querySelector('[aria-label="已完成该步骤"]')).toBeInstanceOf(HTMLButtonElement);
  });

  it('does not block UI interaction while target is still unresolved', () => {
    act(() => {
      confirmTarget.remove();
      useGuideStore.getState().startGuide(CONFIRM_FLOW);
    });
    act(() => {
      vi.advanceTimersByTime(120);
    });

    expect(useGuideStore.getState().session?.phase).toBe('locating');
    const fallbackShield = container.querySelector('[data-guide-click-shield="fallback"]');
    expect(fallbackShield).toBeInstanceOf(HTMLDivElement);
    expect((fallbackShield as HTMLDivElement).style.pointerEvents).toBe('none');
  });

  it('blocks unrelated UI interaction after the guide target is resolved', () => {
    act(() => {
      useGuideStore.getState().startGuide(FLOW);
      useGuideStore.getState().setPhase('active');
    });
    act(() => {
      vi.advanceTimersByTime(120);
    });

    const panels = Array.from(container.querySelectorAll('[data-guide-click-shield="panel"]'));
    expect(panels.length).toBeGreaterThan(0);
    for (const panel of panels) {
      expect((panel as HTMLDivElement).style.pointerEvents).toBe('auto');
    }
  });

  it('debounces input auto-advance from the latest keystroke', () => {
    act(() => {
      useGuideStore.getState().startGuide(INPUT_FLOW);
      useGuideStore.getState().setPhase('active');
    });
    act(() => {
      vi.advanceTimersByTime(120);
    });

    expect(useGuideStore.getState().session?.phase).toBe('active');

    act(() => {
      inputTarget.value = 'A';
      inputTarget.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(400);
    });

    act(() => {
      inputTarget.value = 'Al';
      inputTarget.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });

    expect(useGuideStore.getState().session?.phase).toBe('active');

    act(() => {
      vi.advanceTimersByTime(350);
    });

    expect(useGuideStore.getState().session?.phase).toBe('complete');
  });

  it('cycles between the HUD and focusable descendants inside the target subtree without hijacking inner tab order', () => {
    act(() => {
      useGuideStore.getState().startGuide(TARGET_SUBTREE_FLOW);
    });
    act(() => {
      vi.advanceTimersByTime(120);
    });

    const confirmButton = container.querySelector('[aria-label="已完成该步骤"]') as HTMLButtonElement | null;
    const exitButton = container.querySelector('[aria-label="退出引导"]') as HTMLButtonElement | null;
    expect(confirmButton).toBeTruthy();
    expect(exitButton).toBeTruthy();

    act(() => {
      confirmButton?.focus();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(formTargetInputs[0]);

    formTargetInputs[1].focus();
    const middleTabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(middleTabEvent);
    });
    expect(middleTabEvent.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(formTargetInputs[1]);

    act(() => {
      formTargetButton.focus();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(exitButton);

    act(() => {
      formTargetInputs[0].focus();
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(document.activeElement).toBe(confirmButton);
  });

  it('captures card media after the source target appears asynchronously', () => {
    act(() => {
      useGuideStore.getState().startGuide(CARD_FLOW);
      useGuideStore.getState().setPhase('active');
    });
    act(() => {
      vi.advanceTimersByTime(120);
    });

    expect(container.textContent).toContain('preview async card');
    expect(container.textContent).not.toContain('Delayed Card Content');

    act(() => {
      document.body.appendChild(delayedCardTarget);
      vi.advanceTimersByTime(120);
    });

    expect(container.textContent).toContain('Delayed Card Content');
    expect(container.querySelector('[aria-label="异步卡片预览"]')).toBeTruthy();
  });

  it('strips interactive descendants from captured card previews', () => {
    act(() => {
      document.body.appendChild(interactiveCardTarget);
      useGuideStore.getState().startGuide(INTERACTIVE_CARD_FLOW);
      useGuideStore.getState().setPhase('active');
    });
    act(() => {
      vi.advanceTimersByTime(120);
    });

    const preview = container.querySelector('[aria-label="交互卡片预览"]');
    expect(preview).toBeTruthy();
    expect(preview?.textContent).toContain('Interactive Card Content');
    expect(preview?.textContent).toContain('Do thing');
    expect(preview?.textContent).toContain('Open docs');
    expect(preview?.textContent).toContain('Nested helper');
    expect(preview?.querySelector('button')).toBeNull();
    expect(preview?.querySelector('a')).toBeNull();
    expect(preview?.querySelector('[tabindex]')).toBeNull();
    expect(preview?.querySelector('[data-guide-id]')).toBeNull();
  });
});
