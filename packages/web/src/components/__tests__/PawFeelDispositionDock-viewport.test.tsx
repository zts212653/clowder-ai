import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PawFeelDispositionDock } from '../paw-feel/PawFeelDispositionDock';

const apiFetch = vi.fn();

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

describe('PawFeelDispositionDock viewport hydration', () => {
  let container: HTMLDivElement;
  let root: Root;
  let observerCallback: IntersectionObserverCallback;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    delete (globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ projectionStatus: 'available', items: [], degraded: false }),
    });
    class FakeIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        observerCallback = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
      root = null;
      rootMargin = '0px';
      thresholds = [0];
    }
    (globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver =
      FakeIntersectionObserver as unknown as typeof IntersectionObserver;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('does not fan out a source-ledger request until the marker is near the viewport', async () => {
    await act(async () => {
      root.render(<PawFeelDispositionDock messageId="message-offscreen" pollMs={0} />);
    });
    expect(apiFetch).not.toHaveBeenCalled();

    await act(async () => {
      observerCallback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/paw-feel/source/message-offscreen');
  });

  it('refreshes cached responsibility state immediately when the marker re-enters the viewport', async () => {
    await act(async () => {
      root.render(<PawFeelDispositionDock messageId="message-returning" pollMs={0} />);
    });

    await act(async () => {
      observerCallback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      observerCallback([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    await act(async () => {
      observerCallback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('keeps polling while the issue is open even after the duty review has a valid exit', async () => {
    vi.useFakeTimers();
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        projectionStatus: 'available',
        degraded: false,
        items: [
          {
            disposition: {
              signalId: 'signal-open',
              sourceMessageId: 'message-open',
              state: 'blocked',
              lastTransitionAt: '2026-09-07T00:00:00.000Z',
              blocker: { code: 'task_wait', ref: 'task:item:one' },
            },
            responsibility: {
              state: 'blocked',
              validExit: true,
              exitKind: 'explicit_blocker',
              evidenceRefs: ['task:item:one'],
            },
            issue: {
              resolution: 'open',
              continuation: { kind: 'blocked', evidenceRefs: ['task:item:one'] },
              ageMs: 3_600_000,
            },
            source: { availability: 'available' },
            ageMs: 1_000,
            overdue: false,
          },
        ],
      }),
    });
    await act(async () => {
      root.render(<PawFeelDispositionDock messageId="message-open" pollMs={100} />);
    });
    await act(async () => {
      observerCallback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => vi.advanceTimersByTimeAsync(100));

    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('问题仍开放');
    vi.useRealTimers();
  });

  it('shows the same complete terminal journey in the original-message disclosure', async () => {
    const evidenceRefs = [
      'task:item:journey',
      'proposal:journey',
      `main-commit:${'a'.repeat(40)}`,
      'loaded:journey',
      'freshness:journey',
    ];
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        projectionStatus: 'available',
        degraded: false,
        items: [
          {
            disposition: {
              signalId: 'signal-journey',
              sourceMessageId: 'message-journey',
              state: 'fix',
              lastTransitionAt: '2026-09-07T00:00:00.000Z',
              ownerCatId: 'opus',
            },
            responsibility: {
              state: 'unreviewed',
              validExit: false,
              exitKind: 'repair_binding',
              evidenceRefs: [],
            },
            issue: {
              resolution: 'resolved',
              continuation: {
                kind: 'verified_outcome',
                taskId: 'task:item:journey',
                proposalId: 'proposal:journey',
                evidenceRefs,
              },
              ageMs: 3_600_000,
            },
            source: { availability: 'available' },
            ageMs: 1_000,
            overdue: false,
          },
        ],
      }),
    });
    await act(async () => {
      root.render(<PawFeelDispositionDock messageId="message-journey" pollMs={0} />);
    });
    await act(async () => {
      observerCallback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      await Promise.resolve();
      await Promise.resolve();
    });
    const disclosure = container.querySelector('details');
    await act(async () => {
      disclosure?.setAttribute('open', '');
      disclosure?.dispatchEvent(new Event('toggle', { bubbles: true }));
    });

    for (const ref of evidenceRefs) expect(container.textContent).toContain(ref);
    expect(container.textContent).toContain('Approval proposal:journey');
  });

  it('fails closed instead of crashing on a pre-dual-axis response', async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        projectionStatus: 'available',
        degraded: false,
        items: [
          {
            disposition: { signalId: 'legacy', sourceMessageId: 'legacy', lastTransitionAt: '' },
            responsibility: { state: 'blocked', validExit: true },
          },
        ],
      }),
    });
    await act(async () => {
      root.render(<PawFeelDispositionDock messageId="legacy" pollMs={0} />);
    });
    await act(async () => {
      observerCallback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('爪感差处置状态暂不可读');
    expect(container.querySelector('[data-testid="paw-feel-disposition-dock"]')).toBeNull();
  });
});
