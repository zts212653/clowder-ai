import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { WorkspaceSurfaceVisibilityProvider } from '@/components/workbench/WorkspaceSurfaceVisibility';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { SchedulePanel } from '../SchedulePanel';
import { formatTrigger, outcomeLabel, timeAgo } from '../schedule-helpers';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

function tasks(label: string, description?: string): Response {
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
        display: { label, category: 'system', description },
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
    writeShellLanguage('en');
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

  it('renders scheduler chrome in Chinese while preserving task data and raw timing expressions', async () => {
    const fixture = {
      id: 'owner-task',
      profile: 'normal',
      source: 'dynamic',
      dynamicTaskId: 'dynamic-1',
      enabled: false,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      lastRun: {
        task_id: 'owner-task',
        subject_key: 'thread:thread-a',
        outcome: 'RUN_DELIVERED',
        started_at: new Date().toISOString(),
        duration_ms: 120,
      },
      runStats: { total: 2, delivered: 2, failed: 0, skipped: 0 },
      display: { label: 'User label / 用户标题', category: 'system', description: 'Keep this original description.' },
      subjectPreview: null,
    };
    fetch.mockImplementation(async (path) => {
      if (path.includes('/control')) return Response.json({ global: { enabled: true } });
      if (path.includes('/runs')) return Response.json({ runs: [fixture.lastRun] });
      return Response.json({ tasks: [fixture] });
    });
    writeShellLanguage('zh');
    await act(async () => root.render(<SchedulePanel />));
    const text = container.textContent ?? '';
    for (const label of [
      '全部',
      '当前对话',
      '调度器运行中',
      '系统',
      '自建',
      '定时：0 9 * * *',
      '已送达',
      '2 次送达',
      '已暂停',
      '想安排定时任务？',
    ])
      expect(text).toContain(label);
    expect(text).toContain(fixture.display.label);
    expect(text).toContain(fixture.display.description);
    expect(text).not.toMatch(/Current Thread|Scheduler active|PAUSED|delivered|never run/);
    await act(async () => container.querySelector<HTMLElement>('[role="button"]')?.click());
    for (const label of ['调度目标', '最近运行', '恢复', '删除']) expect(container.textContent).toContain(label);
    expect(container.querySelector('[data-testid="schedule-subject-key-owner-task"]')?.textContent).toContain(
      'thread:thread-a',
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[title="调度器运行中，点击暂停"]')?.click(),
    );
    expect(fetch).toHaveBeenCalledWith('/api/schedule/control', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false, reason: '由调度面板暂停', updatedBy: 'user' }),
    });
  });

  it('changes language without replacing the expanded row, losing scope, or issuing another read', async () => {
    writeShellLanguage('zh');
    await act(async () => root.render(<SchedulePanel />));
    await click('当前对话');
    const row = container.querySelector<HTMLElement>('[role="button"]');
    await act(async () => row?.click());
    const detail = container.querySelector('[id^="schedule-task-detail-"]');
    expect(detail).not.toBeNull();
    fetch.mockClear();
    await act(async () => writeShellLanguage('en'));
    expect(container.textContent).toContain('Current Thread');
    expect(container.textContent).toContain('Showing tasks for:');
    expect(container.textContent).toContain('Recent runs:');
    expect(container.querySelector('[role="button"]')).toBe(row);
    expect(container.querySelector('[id^="schedule-task-detail-"]')).toBe(detail);
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => writeShellLanguage('zh'));
    expect(container.textContent).toContain('当前对话的任务');
    expect(container.textContent).toContain('最近运行');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('localizes an already failed read without refetching or claiming an empty healthy list', async () => {
    fetch.mockResolvedValue(new Response(null, { status: 503 }));
    writeShellLanguage('zh');
    await act(async () => root.render(<SchedulePanel />));
    expect(container.textContent).toContain('同步调度任务失败');
    expect(container.textContent).not.toContain('暂无定时任务');
    fetch.mockClear();
    await act(async () => writeShellLanguage('en'));
    expect(container.textContent).toContain('Schedule could not be refreshed');
    expect(container.textContent).not.toMatch(/同步调度任务失败|No scheduled tasks|All healthy/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('formats once, interval and relative-time states in the selected language without changing trigger data', () => {
    const now = Date.now(),
      trigger = { type: 'once' as const, fireAt: now + 120000 };
    expect(formatTrigger(trigger, 'zh')).toBe('单次，2 分钟后');
    expect(formatTrigger(trigger, 'en')).toBe('once in 2m');
    expect(formatTrigger({ type: 'once', fireAt: now - 1000 }, 'zh')).toBe('单次（已触发）');
    expect(formatTrigger({ type: 'interval', ms: 30000 }, 'zh')).toBe('每 30 秒');
    expect(timeAgo(new Date(now - 180000).toISOString(), 'zh')).toBe('3 分钟前');
    expect(outcomeLabel('RUN_FAILED', 'zh')).toBe('失败');
    expect(outcomeLabel('SKIP_NO_CANDIDATES', 'zh')).toBe('未执行');
    expect(outcomeLabel('UNRECOGNIZED_STATE', 'zh')).toBe('状态待确认');
    expect(trigger).toEqual({ type: 'once', fireAt: now + 120000 });
  });

  it('keeps the description fallback recoverable when subjectPreview is absent', async () => {
    const description = '定时任务的完整说明。'.repeat(40);
    fetch.mockImplementation(async (path) =>
      path.includes('/control') ? Response.json({ global: null }) : tasks('Fallback task', description),
    );
    await act(async () => root.render(<SchedulePanel />));
    const blocks = [...container.querySelectorAll('[data-overflow-measure="block"]')];
    expect(blocks.map((node) => node.textContent)).toContain(description);
  });

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
    expect(container.textContent).toContain('Schedule could not be refreshed');
    expect(container.textContent).not.toContain('All healthy');
    fetch.mockImplementation(async (path) =>
      path.includes('/control') ? Response.json({ global: null }) : tasks('Recovered task'),
    );
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(container.textContent).toContain('Recovered task');
    expect(container.textContent).not.toContain('Schedule could not be refreshed');
  });

  it('shows an initial read failure without claiming the task list is empty or healthy', async () => {
    fetch.mockResolvedValue(new Response(null, { status: 503 }));
    await act(async () => root.render(<SchedulePanel />));
    expect(container.textContent).toContain('Schedule could not be refreshed');
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
