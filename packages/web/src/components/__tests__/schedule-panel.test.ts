import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { SchedulePanel } from '../workspace/SchedulePanel';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

const mockApiFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const TASK_FIXTURE = {
  id: 'task-1',
  profile: 'default',
  trigger: { type: 'interval', ms: 60000 },
  enabled: true,
  lastRun: null,
  runStats: { total: 0, delivered: 0, failed: 0, skipped: 0 },
  display: { label: 'Thread summary', category: 'thread', description: 'summarize current thread' },
  subjectPreview: 'thread-A',
  source: 'dynamic',
  dynamicTaskId: 'dyn-1',
};

function defaultApiFetch(path: string): Promise<Response> {
  if (path === '/api/schedule/tasks' || path === '/api/schedule/tasks?threadId=thread-A') {
    return Promise.resolve(jsonResponse({ tasks: [TASK_FIXTURE] }));
  }
  if (path === '/api/schedule/control') {
    return Promise.resolve(
      jsonResponse({
        global: { enabled: true, reason: null, updatedBy: 'opus', updatedAt: '2026-03-31T19:03:59Z' },
      }),
    );
  }
  if (path.startsWith('/api/schedule/tasks/task-1/runs')) {
    return Promise.resolve(jsonResponse({ runs: [] }));
  }
  throw new Error(`Unexpected apiFetch path: ${path}`);
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('SchedulePanel', () => {
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
    mockApiFetch.mockReset();
    mockApiFetch.mockImplementation(defaultApiFetch);
    useChatStore.setState({ currentThreadId: 'thread-A' });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('scopes run-history fetches to the selected thread', async () => {
    await act(async () => {
      root.render(React.createElement(SchedulePanel));
    });
    await flush();

    const currentThreadButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Current Thread',
    );
    expect(currentThreadButton).toBeTruthy();
    await act(async () => {
      currentThreadButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const taskRow = Array.from(container.querySelectorAll('[role="button"]')).find((node) =>
      node.textContent?.includes('Thread summary'),
    );
    expect(taskRow).toBeTruthy();
    await act(async () => {
      taskRow?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(mockApiFetch).toHaveBeenCalledWith('/api/schedule/tasks/task-1/runs?limit=5&threadId=thread-A');
  });

  it('does not present an eight-character subject preview as full text and exposes the canonical subject by keyboard', async () => {
    const subjectKey = `thread:${'canonical-thread-id-'.repeat(8)}subject-tail`;
    const taskWithCanonicalSubject = {
      ...TASK_FIXTURE,
      subjectPreview: 'Thread canonica…',
      lastRun: {
        task_id: TASK_FIXTURE.id,
        subject_key: subjectKey,
        outcome: 'RUN_DELIVERED',
        started_at: Date.now(),
        duration_ms: 42,
      },
    };
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/schedule/tasks') {
        return Promise.resolve(jsonResponse({ tasks: [taskWithCanonicalSubject] }));
      }
      if (path === '/api/schedule/control') {
        return Promise.resolve(
          jsonResponse({ global: { enabled: true, reason: null, updatedBy: 'opus', updatedAt: 'now' } }),
        );
      }
      if (path === '/api/schedule/tasks/task-1/runs?limit=5') {
        return Promise.resolve(jsonResponse({ runs: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => root.render(React.createElement(SchedulePanel)));
    await flush();

    const preview = container.querySelector<HTMLElement>('[data-testid="schedule-subject-preview-task-1"]');
    expect(preview?.textContent).toBe('Thread canonica…');
    expect(preview?.querySelector('button')).toBeNull();

    const taskRow = Array.from(container.querySelectorAll<HTMLElement>('[role="button"]')).find((node) =>
      node.textContent?.includes('Thread summary'),
    );
    expect(taskRow?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      taskRow?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    await flush();

    expect(taskRow?.getAttribute('aria-expanded')).toBe('true');
    const canonical = container.querySelector<HTMLElement>('[data-testid="schedule-subject-key-task-1"]');
    expect(canonical?.textContent).toContain('subject-tail');
    expect(canonical?.querySelector('[data-overflow-measure="inline"]')?.textContent).toBe(subjectKey);
  });

  it('keeps pause reasons and failed-run diagnostics reachable through bounded disclosures', async () => {
    const pauseReason = `维护窗口：${'必须等待数据校验完成'.repeat(20)}：pause-tail`;
    const taskError = `执行失败：${'上游服务拒绝请求'.repeat(20)}：task-tail`;
    const historyError = `历史失败：${'完整诊断链'.repeat(20)}：history-tail`;
    const failedTask = {
      ...TASK_FIXTURE,
      lastRun: { outcome: 'RUN_FAILED', started_at: Date.now(), error_summary: taskError },
      runStats: { total: 1, delivered: 0, failed: 1, skipped: 0 },
    };
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/schedule/tasks') return Promise.resolve(jsonResponse({ tasks: [failedTask] }));
      if (path === '/api/schedule/control') {
        return Promise.resolve(
          jsonResponse({ global: { enabled: false, reason: pauseReason, updatedBy: 'user', updatedAt: 'now' } }),
        );
      }
      if (path === '/api/schedule/tasks/task-1/runs?limit=5') {
        return Promise.resolve(
          jsonResponse({
            runs: [{ outcome: 'RUN_FAILED', started_at: Date.now(), duration_ms: 42, error_summary: historyError }],
          }),
        );
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => root.render(React.createElement(SchedulePanel)));
    await flush();

    const pause = container.querySelector<HTMLElement>('[data-testid="schedule-global-reason"]');
    const latest = container.querySelector<HTMLElement>('[data-testid="schedule-latest-error-task-1"]');
    await act(async () => pause?.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click());
    await act(async () => latest?.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click());
    expect(pause?.querySelector('pre')?.className).toContain('overflow-auto');
    expect(latest?.querySelector('pre')?.className).toContain('overflow-auto');
    expect(pause?.textContent).toContain('pause-tail');
    expect(latest?.textContent).toContain('task-tail');

    const taskRow = Array.from(container.querySelectorAll('[role="button"]')).find((node) =>
      node.textContent?.includes('Thread summary'),
    );
    await act(async () => taskRow?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();

    const history = container.querySelector<HTMLElement>('[data-testid="schedule-history-error-task-1-0"]');
    await act(async () => history?.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click());
    expect(history?.querySelector('pre')?.className).toContain('overflow-auto');
    expect(history?.textContent).toContain('history-tail');
  });
});
