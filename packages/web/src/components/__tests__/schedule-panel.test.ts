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
});
