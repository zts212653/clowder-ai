import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceSurfaceVisibilityProvider } from '@/components/workbench/WorkspaceSurfaceVisibility';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { SchedulePanel } from '../SchedulePanel';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

function tasks(label: string): Response {
  return Response.json({
    tasks: [
      {
        id: label,
        profile: 'normal',
        source: 'builtin',
        enabled: true,
        trigger: { type: 'interval', ms: 30000 },
        lastRun: null,
        subjectPreview: null,
        runStats: { total: 0, delivered: 0, failed: 0, skipped: 0 },
        display: { label, category: 'system' },
      },
    ],
  });
}

describe('SchedulePanel resource scope', () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetch = vi.mocked(apiFetch);

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    fetch.mockReset();
    fetch.mockImplementation(async (path) =>
      path.includes('/control') ? Response.json({ global: null }) : tasks('All task'),
    );
    useChatStore.setState({ currentThreadId: 'thread-a' });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  async function click(label: string) {
    const target = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === label);
    expect(target).toBeDefined();
    await act(async () => target?.click());
  }

  it('retains All across navigation without refetching while regular polling still updates', async () => {
    await act(async () => root.render(<SchedulePanel />));
    fetch.mockClear();

    await act(async () => useChatStore.setState({ currentThreadId: 'thread-b' }));

    expect(container.textContent).toContain('All task');
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/api/schedule/tasks', '/api/schedule/control']);
  });

  it('does zero retained reads while hidden, preserves data, and catches up once on return', async () => {
    const render = async (visible: boolean) => {
      await act(async () =>
        root.render(
          <WorkspaceSurfaceVisibilityProvider visible={visible}>
            <SchedulePanel />
          </WorkspaceSurfaceVisibilityProvider>,
        ),
      );
    };
    const paths = () => fetch.mock.calls.map(([path]) => path);

    await render(false);
    expect(fetch).not.toHaveBeenCalled();

    await render(true);
    expect(paths()).toEqual(['/api/schedule/tasks', '/api/schedule/control']);
    expect(container.textContent).toContain('All task');
    fetch.mockClear();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(paths()).toEqual([
      '/api/schedule/tasks',
      '/api/schedule/control',
      '/api/schedule/tasks',
      '/api/schedule/control',
    ]);
    fetch.mockClear();

    await render(false);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(container.textContent).toContain('All task');

    await render(true);
    expect(paths()).toEqual(['/api/schedule/tasks', '/api/schedule/control']);
  });

  it('refreshes Current Thread without refreshing global control or accepting the departed response', async () => {
    await act(async () => root.render(<SchedulePanel />));
    let resolveA!: (response: Response) => void;
    fetch.mockImplementation(async (path) => {
      if (path === '/api/schedule/tasks?threadId=thread-a')
        return new Promise((resolve) => {
          resolveA = resolve;
        });
      if (path === '/api/schedule/tasks?threadId=thread-b') return tasks('Thread B task');
      return Response.json({ global: null });
    });
    await click('Current Thread');
    fetch.mockClear();
    await act(async () => useChatStore.setState({ currentThreadId: 'thread-b' }));
    await act(async () => resolveA(tasks('Thread A stale task')));

    expect(container.textContent).toContain('Thread B task');
    expect(container.textContent).not.toContain('Thread A stale task');
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/api/schedule/tasks?threadId=thread-b']);
  });

  it('keeps same-scope tasks after a failed poll and clears the error on recovery', async () => {
    await act(async () => root.render(<SchedulePanel />));
    fetch.mockImplementation(async (path) =>
      path.includes('/control') ? Response.json({ global: null }) : new Response(null, { status: 503 }),
    );
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(container.textContent).toContain('All task');
    expect(container.textContent).toContain('同步调度任务失败');
    expect(container.textContent).not.toContain('All healthy');
    fetch.mockImplementation(async (path) =>
      path.includes('/control') ? Response.json({ global: null }) : tasks('Recovered task'),
    );
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(container.textContent).toContain('Recovered task');
    expect(container.textContent).not.toContain('同步调度任务失败');
  });

  it('shows an initial read failure without claiming the task list is empty or healthy', async () => {
    fetch.mockResolvedValue(new Response(null, { status: 503 }));
    await act(async () => root.render(<SchedulePanel />));
    expect(container.textContent).toContain('同步调度任务失败');
    expect(container.textContent).not.toContain('No scheduled tasks');
    expect(container.textContent).not.toContain('All healthy');
  });

  it('does not reuse a previous scope or read All when Current Thread is unresolved', async () => {
    await act(async () => root.render(<SchedulePanel />));
    await act(async () => useChatStore.setState({ currentThreadId: '' }));
    fetch.mockClear();
    await click('Current Thread');
    expect(container.textContent).not.toContain('All task');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps an expanded All task across navigation and revalidates after its mutation', async () => {
    fetch.mockImplementation(async (path) =>
      path.includes('/runs')
        ? Response.json({ runs: [] })
        : path.includes('/control')
          ? Response.json({ global: null })
          : tasks('All task'),
    );
    await act(async () => root.render(<SchedulePanel />));
    await act(async () => container.querySelector<HTMLElement>('[role="button"]')?.click());
    expect(container.textContent).toContain('Recent runs:');
    fetch.mockClear();
    await act(async () => useChatStore.setState({ currentThreadId: 'thread-b' }));
    expect(container.textContent).toContain('Recent runs:');
    expect(fetch).not.toHaveBeenCalled();
    const pause = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Pause'),
    );
    await act(async () => pause?.click());
    expect(fetch).toHaveBeenCalledWith('/api/schedule/tasks', undefined, { afterCurrentGet: true });
    expect(fetch).toHaveBeenCalledWith('/api/schedule/control', undefined, { afterCurrentGet: true });
  });

  it('discards run history from a task whose detail was closed', async () => {
    await act(async () => root.render(<SchedulePanel />));
    let release!: (response: Response) => void;
    fetch.mockImplementation(
      async () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await act(async () => container.querySelector<HTMLElement>('[role="button"]')?.click());
    await act(async () => container.querySelector<HTMLElement>('[role="button"]')?.click());
    await act(async () =>
      release(
        Response.json({ runs: [{ outcome: 'RUN_DELIVERED', duration_ms: 123, started_at: '2026-09-12T00:00:00Z' }] }),
      ),
    );
    expect(container.textContent).not.toContain('Recent runs:');
    expect(container.textContent).not.toContain('123ms');
  });
});
