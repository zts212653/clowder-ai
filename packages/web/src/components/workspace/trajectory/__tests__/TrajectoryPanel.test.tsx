import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  setCurrentThread: vi.fn(),
  setWorkspaceMode: vi.fn(),
  setRightPanelOpen: vi.fn(),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        currentThreadId: 'thread-f299',
        catInvocations: {},
        activeInvocations: {},
        setCurrentThread: mocks.setCurrentThread,
        setWorkspaceMode: mocks.setWorkspaceMode,
        setRightPanelOpen: mocks.setRightPanelOpen,
      }),
    {
      getState: () => ({
        currentThreadId: 'thread-f299',
        setCurrentThread: mocks.setCurrentThread,
        setWorkspaceMode: mocks.setWorkspaceMode,
        setRightPanelOpen: mocks.setRightPanelOpen,
      }),
    },
  ),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));

vi.mock('@/components/SessionChainPanel', () => ({
  SessionChainPanel: () => <div data-testid="session-chain" />,
}));

vi.mock('@/components/audit/SessionEventsViewer', () => ({
  SessionEventsViewer: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="session-events-viewer">{sessionId}</div>
  ),
}));

import { TrajectoryPanel } from '../TrajectoryPanel';

function summary(invocationId: string, sessionId: string, threadId = 'thread-f299') {
  return {
    invocationId,
    threadId,
    sessionId,
    sessionSeq: 0,
    sessionStatus: 'sealed' as const,
    catId: 'codex-sol',
    status: 'done' as const,
    startedAt: 1_000,
    endedAt: 1_010,
    durationMs: 10,
    eventCount: 1,
    statusEventCount: 0,
    toolUseCount: 0,
    toolResultCount: 0,
    messageCount: 0,
    errorCount: 0,
    toolNames: [],
    keyMessages: [],
  };
}

describe('F299 trajectory search navigation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.history.replaceState({}, '', '/thread/thread-f299');
    mocks.apiFetch.mockReset();
    mocks.setCurrentThread.mockReset();
    mocks.setWorkspaceMode.mockReset();
    mocks.setRightPanelOpen.mockReset();
    mocks.apiFetch.mockImplementation(async (input: string) => {
      if (input.includes('/invocations?limit=500')) {
        return { ok: true, json: async () => ({ invocations: [summary('inv-loaded', 'session-loaded')] }) };
      }
      if (input.includes('/sessions/search?')) {
        return {
          ok: true,
          json: async () => ({
            hits: [
              {
                score: 0.8,
                sessionId: 'session-hidden',
                kind: 'event',
                snippet: 'hidden invocation match',
                pointer: { eventNo: 700, invocationId: 'inv-hidden' },
              },
            ],
          }),
        };
      }
      if (input.startsWith('/api/invocations/')) {
        const requestUrl = new URL(input, 'http://localhost');
        const invocationId = requestUrl.pathname.split('/')[3];
        const resolved =
          invocationId === 'inv-loaded'
            ? { threadId: 'thread-f299', sessionId: 'session-loaded' }
            : { threadId: 'thread-f299', sessionId: 'session-hidden' };
        return { ok: true, json: async () => ({ invocationId, ...resolved }) };
      }
      if (input.includes('/api/sessions/session-hidden/invocations/inv-hidden')) {
        return {
          ok: true,
          json: async () => ({
            invocationId: 'inv-hidden',
            events: [],
            total: 0,
            summary: summary('inv-hidden', 'session-hidden'),
          }),
        };
      }
      throw new Error(`Unexpected request: ${input}`);
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function openHiddenSearchResult() {
    await act(async () => {
      root.render(<TrajectoryPanel threadId="thread-f299" />);
    });
    await act(async () => {});

    const searchTab = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '搜索');
    await act(async () => searchTab?.click());
    const input = container.querySelector<HTMLInputElement>('input[type="text"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'hidden');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    await act(async () => submit?.click());
    await act(async () => {});
    const result = container.querySelector<HTMLButtonElement>('[data-testid="search-result-session"]');
    await act(async () => result?.click());
    await act(async () => {});
    await act(async () => {});
  }

  it('resolves an inv-only anchor to its canonical cross-thread session before detail fetch', async () => {
    window.history.replaceState({}, '', '/thread/thread-f299?workspaceMode=trajectory&inv=inv-cross');
    mocks.apiFetch.mockImplementation(async (input: string) => {
      if (input === '/api/threads/thread-f299/invocations?limit=500') {
        return { ok: true, json: async () => ({ invocations: [] }) };
      }
      if (input === '/api/invocations/inv-cross/trajectory') {
        return {
          ok: true,
          json: async () => ({ invocationId: 'inv-cross', threadId: 'thread-canonical', sessionId: 'session-cross' }),
        };
      }
      if (input === '/api/invocations/inv-cross/trajectory?threadId=thread-canonical&sessionId=session-cross') {
        return {
          ok: true,
          json: async () => ({ invocationId: 'inv-cross', threadId: 'thread-canonical', sessionId: 'session-cross' }),
        };
      }
      throw new Error(`Unexpected request: ${input}`);
    });

    await act(async () => root.render(<TrajectoryPanel threadId="thread-f299" />));
    await act(async () => {});

    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/invocations/inv-cross/trajectory');
    expect(mocks.setCurrentThread).toHaveBeenCalledWith('thread-canonical');
    expect(mocks.apiFetch).not.toHaveBeenCalledWith('/api/sessions/session-cross/invocations/inv-cross');
    const canonicalUrl = new URL(window.location.href);
    expect(canonicalUrl.pathname).toBe('/thread/thread-canonical');
    expect(canonicalUrl.searchParams.get('trajectoryThread')).toBe('thread-canonical');
    expect(canonicalUrl.searchParams.get('session')).toBe('session-cross');
  });

  it('renders typed denied and hint-mismatch states without guessing a session', async () => {
    window.history.replaceState({}, '', '/thread/thread-f299?workspaceMode=trajectory&inv=inv-denied');
    mocks.apiFetch.mockImplementation(async (input: string) => {
      if (input === '/api/threads/thread-f299/invocations?limit=500') {
        return { ok: true, json: async () => ({ invocations: [] }) };
      }
      if (input === '/api/invocations/inv-denied/trajectory') {
        return {
          ok: false,
          status: 403,
          json: async () => ({ code: 'INVOCATION_RECORD_ACCESS_DENIED' }),
        };
      }
      throw new Error(`Unexpected request: ${input}`);
    });

    await act(async () => root.render(<TrajectoryPanel threadId="thread-f299" />));
    await act(async () => {});

    expect(container.querySelector('[data-testid="trajectory-resolution-error"]')?.textContent).toContain('没有权限');
    expect(mocks.apiFetch).not.toHaveBeenCalledWith(expect.stringContaining('/api/sessions/'));

    window.history.replaceState(
      {},
      '',
      '/thread/thread-f299?workspaceMode=trajectory&trajectoryThread=thread-stale&session=session-stale&inv=inv-mismatch',
    );
    mocks.apiFetch.mockImplementation(async (input: string) => {
      if (input === '/api/threads/thread-f299/invocations?limit=500') {
        return { ok: true, json: async () => ({ invocations: [] }) };
      }
      if (input === '/api/invocations/inv-mismatch/trajectory?threadId=thread-stale&sessionId=session-stale') {
        return {
          ok: false,
          status: 409,
          json: async () => ({ code: 'INVOCATION_THREAD_HINT_MISMATCH' }),
        };
      }
      throw new Error(`Unexpected request: ${input}`);
    });
    await act(async () => window.dispatchEvent(new PopStateEvent('popstate')));
    await act(async () => {});

    expect(container.querySelector('[data-testid="trajectory-resolution-error"]')?.textContent).toContain(
      '证据坐标与 canonical 记录不一致',
    );
  });

  it('opens an invocation search hit that is outside the first 500 summaries', async () => {
    await openHiddenSearchResult();

    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/sessions/session-hidden/invocations/inv-hidden');
    expect(container.querySelector('[data-testid="invocation-trajectory-detail"]')?.textContent).toContain(
      'inv-hidden',
    );
  });

  it('clears a direct search target when the workspace switches threads', async () => {
    await openHiddenSearchResult();
    expect(container.querySelector('[data-testid="invocation-trajectory-detail"]')?.textContent).toContain(
      'inv-hidden',
    );

    mocks.apiFetch.mockImplementation(async (input: string) => {
      if (input === '/api/threads/thread-b/invocations?limit=500') {
        return { ok: true, json: async () => ({ invocations: [] }) };
      }
      throw new Error(`Unexpected request after thread switch: ${input}`);
    });
    window.history.replaceState({}, '', '/thread/thread-b?workspaceMode=trajectory');
    await act(async () => {
      root.render(<TrajectoryPanel threadId="thread-b" />);
    });
    await act(async () => {});

    expect(container.querySelector('[data-testid="invocation-trajectory-detail"]')).toBeNull();
    expect(window.location.search).not.toContain('inv=');
  });

  it('does not let a slow old-thread list overwrite the current thread', async () => {
    let resolveA!: (value: { ok: true; json: () => Promise<{ invocations: ReturnType<typeof summary>[] }> }) => void;
    const slowA = new Promise<{ ok: true; json: () => Promise<{ invocations: ReturnType<typeof summary>[] }> }>(
      (resolve) => {
        resolveA = resolve;
      },
    );
    mocks.apiFetch.mockImplementation(async (input: string) => {
      if (input === '/api/threads/thread-a/invocations?limit=500') return slowA;
      if (input === '/api/threads/thread-b/invocations?limit=500') {
        return { ok: true, json: async () => ({ invocations: [summary('inv-b', 'session-b', 'thread-b')] }) };
      }
      throw new Error(`Unexpected request: ${input}`);
    });

    await act(async () => {
      root.render(<TrajectoryPanel threadId="thread-a" />);
    });
    await act(async () => {
      root.render(<TrajectoryPanel threadId="thread-b" />);
    });
    await act(async () => {});
    await act(async () => {
      resolveA({
        ok: true,
        json: async () => ({ invocations: [summary('inv-a', 'session-a', 'thread-a')] }),
      });
      await slowA;
    });
    await act(async () => {});

    expect(container.querySelector('[data-invocation-id="inv-b"]')).not.toBeNull();
    expect(container.querySelector('[data-invocation-id="inv-a"]')).toBeNull();
  });

  it('re-resolves a generic target without inheriting the previous direct session hint', async () => {
    await openHiddenSearchResult();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('cat-cafe:open-invocation-trajectory', {
          detail: { threadId: 'thread-f299', invocationId: 'inv-hidden' },
        }),
      );
    });
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/invocations/inv-hidden/trajectory?threadId=thread-f299');

    window.history.replaceState({}, '', '/thread/thread-f299?workspaceMode=trajectory&inv=inv-loaded');
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(container.querySelector('[data-testid="invocation-trajectory-detail"]')?.textContent).toContain(
      'inv-loaded',
    );
    expect(mocks.apiFetch).not.toHaveBeenLastCalledWith('/api/sessions/session-hidden/invocations/inv-hidden');
  });

  it('opens a pointer-less search hit in the active thread session viewer', async () => {
    mocks.apiFetch.mockImplementation(async (input: string) => {
      if (input.includes('/invocations?limit=500')) {
        return { ok: true, json: async () => ({ invocations: [] }) };
      }
      if (input.includes('/sessions/search?')) {
        return {
          ok: true,
          json: async () => ({
            hits: [
              {
                score: 0.8,
                sessionId: 'session-without-pointer',
                kind: 'digest',
                snippet: 'session-only match',
                pointer: { eventNo: 700 },
              },
            ],
          }),
        };
      }
      throw new Error(`Unexpected request: ${input}`);
    });

    await act(async () => {
      root.render(<TrajectoryPanel threadId="thread-f299" />);
    });
    await act(async () => {});
    const searchTab = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '搜索');
    await act(async () => searchTab?.click());
    const input = container.querySelector<HTMLInputElement>('input[type="text"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'session-only');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());
    await act(async () => {});
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="search-result-session"]')?.click());

    expect(container.querySelector('[data-testid="session-events-viewer"]')?.textContent).toBe(
      'session-without-pointer',
    );
  });

  it('invalidates pointer-less search hits when the workspace switches threads', async () => {
    mocks.apiFetch.mockImplementation(async (input: string) => {
      if (input === '/api/threads/thread-a/invocations?limit=500') {
        return { ok: true, json: async () => ({ invocations: [] }) };
      }
      if (input.startsWith('/api/threads/thread-a/sessions/search?')) {
        return {
          ok: true,
          json: async () => ({
            hits: [
              {
                score: 0.8,
                sessionId: 'session-a',
                kind: 'digest',
                snippet: 'thread A only',
                pointer: {},
              },
            ],
          }),
        };
      }
      if (input === '/api/threads/thread-b/invocations?limit=500') {
        return { ok: true, json: async () => ({ invocations: [] }) };
      }
      throw new Error(`Unexpected request: ${input}`);
    });

    await act(async () => {
      root.render(<TrajectoryPanel threadId="thread-a" />);
    });
    await act(async () => {});
    const searchTab = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '搜索');
    await act(async () => searchTab?.click());
    const input = container.querySelector<HTMLInputElement>('input[type="text"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'thread-a');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());
    await act(async () => {});
    expect(container.querySelector('[data-testid="search-result-session"]')).not.toBeNull();

    await act(async () => {
      root.render(<TrajectoryPanel threadId="thread-b" />);
    });
    await act(async () => {});
    const staleHit = container.querySelector<HTMLButtonElement>('[data-testid="search-result-session"]');
    if (staleHit) await act(async () => staleHit.click());

    expect(staleHit).toBeNull();
    expect(container.querySelector('[data-testid="session-events-viewer"]')).toBeNull();
    expect(mocks.apiFetch).not.toHaveBeenCalledWith(expect.stringContaining('/api/sessions/session-a/events'));
  });

  it('rejects a direct detail whose response belongs to another thread', async () => {
    window.history.replaceState(
      {},
      '',
      '/thread/thread-b?workspaceMode=trajectory&trajectoryThread=thread-b&session=session-a&inv=inv-a',
    );
    mocks.apiFetch.mockImplementation(async (input: string) => {
      if (input === '/api/threads/thread-b/invocations?limit=500') {
        return { ok: true, json: async () => ({ invocations: [] }) };
      }
      if (input === '/api/invocations/inv-a/trajectory?threadId=thread-b&sessionId=session-a') {
        return {
          ok: true,
          json: async () => ({ invocationId: 'inv-a', threadId: 'thread-b', sessionId: 'session-a' }),
        };
      }
      if (input === '/api/sessions/session-a/invocations/inv-a') {
        return {
          ok: true,
          json: async () => ({
            invocationId: 'inv-a',
            events: [],
            total: 0,
            summary: summary('inv-a', 'session-a', 'thread-a'),
          }),
        };
      }
      throw new Error(`Unexpected request: ${input}`);
    });

    await act(async () => {
      root.render(<TrajectoryPanel threadId="thread-b" />);
    });
    await act(async () => {});

    expect(container.querySelector('[data-testid="invocation-trajectory-detail"]')).toBeNull();
    expect(container.querySelector('[data-testid="trajectory-direct-open"]')).toBeNull();
    expect(window.location.search).not.toContain('inv=');
    expect(window.location.search).not.toContain('session=');
  });

  it('does not open an unverified direct session after detail lookup fails', async () => {
    window.history.replaceState(
      {},
      '',
      '/thread/thread-b?workspaceMode=trajectory&trajectoryThread=thread-b&session=session-a&inv=inv-missing',
    );
    mocks.apiFetch.mockImplementation(async (input: string) => {
      if (input === '/api/threads/thread-b/invocations?limit=500') {
        return { ok: true, json: async () => ({ invocations: [] }) };
      }
      if (input === '/api/invocations/inv-missing/trajectory?threadId=thread-b&sessionId=session-a') {
        return {
          ok: true,
          json: async () => ({ invocationId: 'inv-missing', threadId: 'thread-b', sessionId: 'session-a' }),
        };
      }
      if (input === '/api/sessions/session-a/invocations/inv-missing') {
        return { ok: false, status: 404 };
      }
      throw new Error(`Unexpected request: ${input}`);
    });

    await act(async () => {
      root.render(<TrajectoryPanel threadId="thread-b" />);
    });
    await act(async () => {});
    const back = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '轨迹读取失败，返回列表',
    );
    await act(async () => back?.click());

    expect(container.querySelector('[data-testid="session-events-viewer"]')).toBeNull();
    expect(window.location.search).not.toContain('inv=');
    expect(window.location.search).not.toContain('session=');
  });

  it('monotonically reconciles a stale zero-tool list row from canonical detail', async () => {
    const detailedSummary = {
      ...summary('inv-loaded', 'session-loaded'),
      eventCount: 2,
      toolUseCount: 1,
      toolResultCount: 1,
      messageCount: 1,
      toolNames: ['command_execution'],
    };
    mocks.apiFetch.mockImplementation(async (input: string) => {
      if (input === '/api/threads/thread-f299/invocations?limit=500') {
        return { ok: true, json: async () => ({ invocations: [summary('inv-loaded', 'session-loaded')] }) };
      }
      if (input === '/api/invocations/inv-loaded/trajectory?threadId=thread-f299&sessionId=session-loaded') {
        return {
          ok: true,
          json: async () => ({
            invocationId: 'inv-loaded',
            threadId: 'thread-f299',
            sessionId: 'session-loaded',
          }),
        };
      }
      if (input === '/api/sessions/session-loaded/invocations/inv-loaded') {
        return {
          ok: true,
          json: async () => ({
            invocationId: 'inv-loaded',
            events: [],
            total: 2,
            summary: detailedSummary,
          }),
        };
      }
      throw new Error(`Unexpected request: ${input}`);
    });

    await act(async () => root.render(<TrajectoryPanel threadId="thread-f299" />));
    await act(async () => {});
    await act(async () => container.querySelector<HTMLButtonElement>('[data-invocation-id="inv-loaded"]')?.click());
    await act(async () => {});

    expect(container.textContent).toContain('1 / 1');
    const back = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '← 返回');
    await act(async () => back?.click());
    expect(container.querySelector('[data-invocation-id="inv-loaded"]')?.textContent).toContain('1 tools');
  });
});
