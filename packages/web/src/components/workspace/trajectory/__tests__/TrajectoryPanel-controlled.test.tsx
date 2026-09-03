import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  setCurrentThread: vi.fn(),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({ currentThreadId: 'thread-f299', catInvocations: {}, activeInvocations: {} }),
    { getState: () => ({ setCurrentThread: mocks.setCurrentThread }) },
  ),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));

vi.mock('@/components/SessionChainPanel', () => ({ SessionChainPanel: () => <div /> }));
vi.mock('@/components/audit/SessionEventsViewer', () => ({ SessionEventsViewer: () => <div /> }));

import { TrajectoryPanel } from '../TrajectoryPanel';

function summary() {
  return {
    invocationId: 'inv-controlled',
    threadId: 'thread-f299',
    sessionId: 'session-controlled',
    sessionSeq: 0,
    sessionStatus: 'sealed' as const,
    catId: 'codex-sol',
    status: 'done' as const,
    startedAt: 1_000,
    endedAt: 1_010,
    durationMs: 10,
    eventCount: 0,
    statusEventCount: 0,
    toolUseCount: 0,
    toolResultCount: 0,
    messageCount: 0,
    errorCount: 0,
    toolNames: [],
    keyMessages: [],
  };
}

describe('F299 controlled trajectory adapter', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.history.replaceState({}, '', '/thread/thread-f299');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.apiFetch.mockImplementation(async (input: string) => {
      if (input === '/api/threads/thread-f299/invocations?limit=500') {
        return { ok: true, json: async () => ({ invocations: [summary()] }) };
      }
      if (input === '/api/invocations/inv-controlled/trajectory?threadId=thread-f299') {
        return {
          ok: true,
          json: async () => ({
            invocationId: 'inv-controlled',
            threadId: 'thread-f299',
            sessionId: 'session-controlled',
          }),
        };
      }
      if (input.includes('/request-generations?')) {
        return {
          ok: true,
          json: async () => ({ invocationId: 'inv-controlled', threadId: 'thread-f299', generations: [] }),
        };
      }
      if (input === '/api/sessions/session-controlled/invocations/inv-controlled') {
        return { ok: true, json: async () => ({ invocationId: 'inv-controlled', events: [], summary: summary() }) };
      }
      throw new Error(`Unexpected request: ${input}`);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('ignores global URL events and keeps the adapter-provided invocation instance-scoped', async () => {
    await act(async () =>
      root.render(
        <TrajectoryPanel
          threadId="thread-f299"
          targetOverride={{ threadId: 'thread-f299', invocationId: 'inv-controlled' }}
        />,
      ),
    );
    await act(async () => {});
    await act(async () =>
      window.dispatchEvent(
        new CustomEvent('cat-cafe:open-invocation-trajectory', {
          detail: { threadId: 'thread-f299', invocationId: 'inv-other' },
        }),
      ),
    );

    expect(container.textContent).toContain('inv-controlled');
    expect(mocks.apiFetch).not.toHaveBeenCalledWith(expect.stringContaining('inv-other'));
    expect(window.location.search).not.toContain('inv=');
  });
});
