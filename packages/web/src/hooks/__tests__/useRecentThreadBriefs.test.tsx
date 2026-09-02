import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRecentThreadBriefs } from '../useRecentThreadBriefs';

const apiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

describe('useRecentThreadBriefs', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    apiFetch.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('appends recent pages, refreshes current, and clears stale data when canonical refresh fails', async () => {
    apiFetch
      .mockResolvedValueOnce(response(collection([brief('current-1')], [brief('recent-1')], 'cursor-1')))
      .mockResolvedValueOnce(response(collection([brief('current-1')], [brief('recent-2')], null)))
      .mockRejectedValueOnce(new Error('unavailable'));

    await act(async () => root.render(<Probe />));
    await act(async () => Promise.resolve());
    expect(container.textContent).toContain('current-1|recent-1');

    const loadMore = container.querySelector('[data-testid="load-more"]');
    await act(async () => loadMore?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => Promise.resolve());
    expect(container.textContent).toContain('current-1|recent-1,recent-2');

    await act(async () => {
      window.dispatchEvent(new CustomEvent('catcafe:thread-brief-invalidated', { detail: { threadId: 'current-1' } }));
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('error');
    expect(container.querySelector('[data-testid="briefs"]')?.textContent).toBe('|');
  });
});

function Probe() {
  const state = useRecentThreadBriefs();
  return (
    <div>
      <span data-testid="status">{state.error ? 'error' : 'ok'}</span>
      <span data-testid="briefs">
        {state.current.map((item) => item.thread.id).join(',')}|{state.recent.map((item) => item.thread.id).join(',')}
      </span>
      <button type="button" data-testid="load-more" onClick={state.loadMore}>
        more
      </button>
    </div>
  );
}

function response(body: unknown) {
  return { ok: true, json: async () => body };
}

function collection(current: unknown[], recent: unknown[], nextCursor: string | null) {
  return { v: 1, current, recent, nextCursor, generatedAt: Date.now() };
}

function brief(threadId: string) {
  return {
    v: 1,
    thread: { id: threadId, title: threadId },
    contextHeading: { label: '会话', text: threadId },
    availability: 'ok',
    presentationState: 'idle',
    currentExecutions: [],
    attention: [],
    waits: [],
    recentProgress: [],
    lastProgressAt: 1,
    nextStep: null,
    openWorkTaskCount: 0,
    hasHistory: true,
    generatedAt: 1,
  };
}
