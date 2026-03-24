import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MobileStatusSheet } from '@/components/MobileStatusSheet';
import type { CatStatus, IntentMode } from '@/components/status-helpers';
import type { CatInvocationInfo } from '@/stores/chatStore';

describe('MobileStatusSheet', () => {
  let container: HTMLDivElement;
  let root: Root;

  const baseProps = {
    open: false,
    onClose: () => {},
    intentMode: null as IntentMode,
    targetCats: [] as string[],
    catStatuses: {} as Record<string, CatStatus>,
    catInvocations: {} as Record<string, CatInvocationInfo>,
    threadId: 'thread-1',
    messageSummary: { total: 10, assistant: 5, system: 2, evidence: 1, followup: 0 },
  };

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders nothing visible when closed (translate-y-full)', () => {
    act(() => {
      root.render(React.createElement(MobileStatusSheet, baseProps));
    });
    // When closed, the sheet should have translate-y-full (hidden off-screen)
    // and the backdrop should have pointer-events-none
    const backdrop = container.querySelector('[class*="pointer-events-none"]');
    expect(backdrop).toBeTruthy();
  });

  it('renders visible when open (translate-y-0)', () => {
    act(() => {
      root.render(React.createElement(MobileStatusSheet, { ...baseProps, open: true }));
    });
    const sheet = container.querySelector('[class*="translate-y-0"]');
    expect(sheet).toBeTruthy();
  });

  it('displays thread ID and message summary', () => {
    act(() => {
      root.render(React.createElement(MobileStatusSheet, { ...baseProps, open: true }));
    });
    expect(container.textContent).toContain('thread-1');
    expect(container.textContent).toContain('10');
  });

  it('displays cat names when targetCats are set', () => {
    const props = {
      ...baseProps,
      open: true,
      targetCats: ['opus', 'codex'],
      catStatuses: { opus: 'pending' as CatStatus, codex: 'streaming' as CatStatus },
    };
    act(() => {
      root.render(React.createElement(MobileStatusSheet, props));
    });
    expect(container.textContent).toContain('布偶猫');
    expect(container.textContent).toContain('缅因猫');
  });

  it('shows close button that calls onClose', () => {
    let closed = false;
    const props = {
      ...baseProps,
      open: true,
      onClose: () => {
        closed = true;
      },
    };
    act(() => {
      root.render(React.createElement(MobileStatusSheet, props));
    });
    const closeBtn = container.querySelector('button[aria-label="关闭状态面板"]');
    expect(closeBtn).toBeTruthy();
    act(() => {
      closeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(closed).toBe(true);
  });

  it('does not mark completed snapshots as 当前调用', () => {
    const props = {
      ...baseProps,
      open: true,
      targetCats: [],
      catStatuses: { codex: 'done' as CatStatus },
      catInvocations: {
        codex: {
          startedAt: Date.now() - 1000,
          taskProgress: {
            tasks: [{ id: 't-1', subject: 'Done item', status: 'completed' as const }],
            lastUpdate: Date.now(),
            snapshotStatus: 'completed' as const,
          },
        },
      },
    };
    act(() => {
      root.render(React.createElement(MobileStatusSheet, props));
    });
    expect(container.textContent).toContain('猫猫状态');
    expect(container.textContent).not.toContain('当前调用');
  });
});
