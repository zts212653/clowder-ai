import { act } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addToastMock,
  createThreadSidebarHarness,
  defaultSidebarApiMock,
  installThreadSidebarGlobals,
  jsonOk,
  mockApiFetch,
  mockStore,
  resetThreadSidebarGlobals,
  resetThreadSidebarMocks,
  type ThreadSidebarHarness,
  textFail,
} from './thread-sidebar-test-helpers';

const testData = vi.hoisted(() => ({
  TEST_LABELS: [
    { id: 'lbl-a', name: '开源', color: '#5B8C5A', sortOrder: 0, createdBy: 'u1', createdAt: 1 },
    { id: 'lbl-b', name: '设计', color: '#C47F52', sortOrder: 1, createdBy: 'u1', createdAt: 2 },
  ],
}));

vi.mock('@/stores/label-store', () => {
  const store = {
    labels: testData.TEST_LABELS,
    isLoading: false,
    fetchLabels: vi.fn().mockResolvedValue(undefined),
    createLabel: vi.fn(),
    updateLabel: vi.fn(),
    deleteLabel: vi.fn(),
  };
  const hook = Object.assign((selector?: (s: typeof store) => unknown) => (selector ? selector(store) : store), {
    getState: () => store,
    setState: (partial: Partial<typeof store>) => Object.assign(store, partial),
  });
  return { useLabelStore: hook };
});

const ORGANIZER_THREAD = {
  id: 'org-thread-1',
  title: 'Thread 整理助手',
  projectPath: '/test',
  createdBy: 'u1',
  participants: [],
  lastActiveAt: 1000,
  createdAt: 1000,
};

function makeThread(id: string, labels?: string[]) {
  return {
    id,
    title: `Thread ${id}`,
    projectPath: '/test',
    createdBy: 'u1',
    participants: [],
    lastActiveAt: 1000,
    createdAt: 1000,
    labels,
  };
}

describe('ThreadSidebar ✨ organize flow', () => {
  let harness: ThreadSidebarHarness;

  beforeAll(() => {
    installThreadSidebarGlobals();
  });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    resetThreadSidebarMocks();
    harness = createThreadSidebarHarness();
  });

  afterEach(() => {
    harness.cleanup();
    vi.useRealTimers();
  });

  afterAll(() => {
    resetThreadSidebarGlobals();
  });

  function findOrganizeButton(container: HTMLElement) {
    return Array.from(container.querySelectorAll('button')).find((b) => b.getAttribute('title') === '猫猫帮你分类');
  }

  it('✨ button opens organizer modal, pre-fills from SUGGESTIONS_JSON, and apply sends filtered payload', async () => {
    const uncatThreads = [makeThread('t1'), makeThread('t2')];
    const catThread = makeThread('t3', ['lbl-a']);
    mockStore.threads = [...uncatThreads, catThread];
    (mockStore.updateThreadLabels as ReturnType<typeof vi.fn>).mockClear();

    const suggestionsJson = JSON.stringify({
      t1: ['lbl-a', 'bad'],
      t2: ['lbl-b'],
      hidden: ['lbl-a'],
    });
    const catMessage = {
      id: 'msg-cat-1',
      catId: 'opus',
      timestamp: Date.now() + 5000,
      isDraft: false,
      content: `分类建议如下...\n<!-- SUGGESTIONS_JSON:${suggestionsJson} -->`,
    };

    let pollCount = 0;
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/threads' && init?.method === 'POST') {
        return jsonOk(ORGANIZER_THREAD);
      }
      if (path === '/api/messages' && init?.method === 'POST') {
        return jsonOk({ id: 'msg-trigger', ok: true });
      }
      if (path.startsWith('/api/messages?')) {
        pollCount++;
        if (pollCount >= 2) {
          return jsonOk({ messages: [catMessage] });
        }
        return jsonOk({ messages: [] });
      }
      if (path === '/api/threads') {
        return jsonOk({ threads: [...uncatThreads, catThread, ORGANIZER_THREAD] });
      }
      return defaultSidebarApiMock(path);
    });

    await harness.render();

    const btn = findOrganizeButton(harness.container);
    expect(btn).toBeTruthy();

    await act(async () => {
      btn!.click();
    });
    await harness.flush();

    expect(harness.container.textContent).toContain('整理未分类');
    expect(harness.container.textContent).toContain('分析中');

    for (let tick = 0; tick < 4; tick++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await harness.flush();
      if (pollCount >= 2) break;
    }

    expect(pollCount).toBeGreaterThanOrEqual(2);
    for (let flushAttempt = 0; flushAttempt < 5; flushAttempt++) {
      await harness.flush();
      if (harness.container.textContent?.includes('已选 2 个 thread')) break;
    }

    for (let settle = 0; settle < 10 && !harness.container.textContent?.includes('已选 2 个 thread'); settle++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await harness.flush();
    }
    expect(harness.container.textContent).toContain('已选 2 个 thread');
    expect(harness.container.textContent).toContain('批量应用 (2)');

    const applyBtn = Array.from(harness.container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('批量应用'),
    );
    expect(applyBtn).toBeTruthy();

    await act(async () => {
      applyBtn!.click();
    });
    await harness.flush();

    const updateFn = mockStore.updateThreadLabels as ReturnType<typeof vi.fn>;
    expect(updateFn).toHaveBeenCalledTimes(2);

    const calls = updateFn.mock.calls.map((c) => [c[0] as string, c[1] as string[]]);
    calls.sort((a, b) => (a[0] as string).localeCompare(b[0] as string));
    expect(calls).toEqual([
      ['t1', ['lbl-a']],
      ['t2', ['lbl-b']],
    ]);
  });

  it('keeps polling when cat message lacks SUGGESTIONS_JSON', async () => {
    const uncatThreads = [makeThread('t1'), makeThread('t2')];
    mockStore.threads = [...uncatThreads];
    (mockStore.updateThreadLabels as ReturnType<typeof vi.fn>).mockClear();

    const noJsonMessage = {
      id: 'msg-cat-1',
      catId: 'opus',
      timestamp: Date.now() + 3000,
      isDraft: false,
      content: '让我看看这些 thread...',
    };

    const suggestionsJson = JSON.stringify({ t1: ['lbl-a'], t2: ['lbl-b'] });
    const jsonMessage = {
      id: 'msg-cat-2',
      catId: 'opus',
      timestamp: Date.now() + 8000,
      isDraft: false,
      content: `分类建议\n<!-- SUGGESTIONS_JSON:${suggestionsJson} -->`,
    };

    let pollCount = 0;
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/threads' && init?.method === 'POST') return jsonOk(ORGANIZER_THREAD);
      if (path === '/api/messages' && init?.method === 'POST') return jsonOk({ id: 'msg-trigger', ok: true });
      if (path.startsWith('/api/messages?')) {
        pollCount++;
        if (pollCount <= 2) return jsonOk({ messages: [noJsonMessage] });
        return jsonOk({ messages: [noJsonMessage, jsonMessage] });
      }
      if (path === '/api/threads') return jsonOk({ threads: [...uncatThreads, ORGANIZER_THREAD] });
      return defaultSidebarApiMock(path);
    });

    await harness.render();
    const btn = findOrganizeButton(harness.container);
    expect(btn).toBeTruthy();

    await act(async () => {
      btn!.click();
    });
    await harness.flush();

    for (let tick = 0; tick < 6; tick++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await harness.flush();
    }

    expect(pollCount).toBeGreaterThanOrEqual(3);

    for (let settle = 0; settle < 10; settle++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await harness.flush();
      if (harness.container.textContent?.includes('已选 2 个 thread')) break;
    }

    expect(harness.container.textContent).toContain('已选 2 个 thread');
    expect(harness.container.textContent).toContain('批量应用 (2)');
  });

  it('defers label creation to Apply click in newLabels format', async () => {
    const { useLabelStore } = await import('@/stores/label-store');
    type LabelStoreExt = ReturnType<typeof vi.fn> & {
      setState: (p: Record<string, unknown>) => void;
      getState: () => Record<string, unknown>;
    };
    (useLabelStore as unknown as LabelStoreExt).setState({ labels: [] });

    const uncatThreads = [makeThread('t1'), makeThread('t2')];
    mockStore.threads = [...uncatThreads];
    (mockStore.updateThreadLabels as ReturnType<typeof vi.fn>).mockClear();

    let labelIdCounter = 0;
    const createLabelMock = vi.fn().mockImplementation(async (name: string, color: string) => {
      const label = {
        id: `auto-${++labelIdCounter}`,
        name,
        color,
        sortOrder: 0,
        createdBy: 'u1',
        createdAt: Date.now(),
      };
      const store = (useLabelStore as unknown as LabelStoreExt).getState();
      (useLabelStore as unknown as LabelStoreExt).setState({ labels: [...(store.labels as unknown[]), label] });
      return label;
    });
    (useLabelStore as unknown as LabelStoreExt).setState({ createLabel: createLabelMock });

    const suggestionsJson = JSON.stringify({
      newLabels: [
        { name: '开发', color: '#5B8C5A' },
        { name: '闲聊', color: '#C47F52' },
      ],
      assignments: { t1: ['开发'], t2: ['闲聊'] },
    });
    const catMessage = {
      id: 'msg-cat-1',
      catId: 'opus',
      timestamp: Date.now() + 5000,
      isDraft: false,
      content: `建议标签体系\n<!-- SUGGESTIONS_JSON:${suggestionsJson} -->`,
    };

    let pollCount = 0;
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/threads' && init?.method === 'POST') return jsonOk(ORGANIZER_THREAD);
      if (path === '/api/messages' && init?.method === 'POST') return jsonOk({ id: 'msg-trigger', ok: true });
      if (path.startsWith('/api/messages?')) {
        pollCount++;
        if (pollCount >= 2) return jsonOk({ messages: [catMessage] });
        return jsonOk({ messages: [] });
      }
      if (path === '/api/threads') return jsonOk({ threads: [...uncatThreads, ORGANIZER_THREAD] });
      return defaultSidebarApiMock(path);
    });

    await harness.render();
    const btn = findOrganizeButton(harness.container);
    expect(btn).toBeTruthy();

    await act(async () => {
      btn!.click();
    });
    await harness.flush();

    for (let tick = 0; tick < 6; tick++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await harness.flush();
    }

    for (let settle = 0; settle < 10; settle++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await harness.flush();
      if (harness.container.textContent?.includes('已选 2 个 thread')) break;
    }

    expect(createLabelMock).not.toHaveBeenCalled();
    expect(harness.container.textContent).toContain('已选 2 个 thread');
    expect(harness.container.textContent).toContain('批量应用 (2)');

    const applyBtn = Array.from(harness.container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('批量应用'),
    );
    expect(applyBtn).toBeTruthy();

    await act(async () => {
      applyBtn!.click();
    });
    await harness.flush();

    expect(createLabelMock).toHaveBeenCalledTimes(2);
    expect(createLabelMock).toHaveBeenCalledWith('开发', '#5B8C5A');
    expect(createLabelMock).toHaveBeenCalledWith('闲聊', '#C47F52');

    const updateFn = mockStore.updateThreadLabels as ReturnType<typeof vi.fn>;
    expect(updateFn).toHaveBeenCalledTimes(2);
    const calls = updateFn.mock.calls.map((c) => [c[0] as string, c[1] as string[]]);
    calls.sort((a, b) => (a[0] as string).localeCompare(b[0] as string));
    expect(calls).toEqual([
      ['t1', ['auto-1']],
      ['t2', ['auto-2']],
    ]);

    (useLabelStore as unknown as LabelStoreExt).setState({ labels: testData.TEST_LABELS });
  });

  it('respects user modifications — deselected pending labels are not created or applied', async () => {
    const { useLabelStore } = await import('@/stores/label-store');
    type LabelStoreExt = ReturnType<typeof vi.fn> & {
      setState: (p: Record<string, unknown>) => void;
      getState: () => Record<string, unknown>;
    };
    (useLabelStore as unknown as LabelStoreExt).setState({ labels: [] });

    const uncatThreads = [makeThread('t1'), makeThread('t2')];
    mockStore.threads = [...uncatThreads];
    (mockStore.updateThreadLabels as ReturnType<typeof vi.fn>).mockClear();

    let labelIdCounter = 0;
    const createLabelMock = vi.fn().mockImplementation(async (name: string, color: string) => {
      const label = {
        id: `auto-${++labelIdCounter}`,
        name,
        color,
        sortOrder: 0,
        createdBy: 'u1',
        createdAt: Date.now(),
      };
      const store = (useLabelStore as unknown as LabelStoreExt).getState();
      (useLabelStore as unknown as LabelStoreExt).setState({ labels: [...(store.labels as unknown[]), label] });
      return label;
    });
    (useLabelStore as unknown as LabelStoreExt).setState({ createLabel: createLabelMock });

    const suggestionsJson = JSON.stringify({
      newLabels: [
        { name: '开发', color: '#5B8C5A' },
        { name: '闲聊', color: '#C47F52' },
      ],
      assignments: { t1: ['开发'], t2: ['闲聊'] },
    });
    const catMessage = {
      id: 'msg-cat-1',
      catId: 'opus',
      timestamp: Date.now() + 5000,
      isDraft: false,
      content: `建议标签体系\n<!-- SUGGESTIONS_JSON:${suggestionsJson} -->`,
    };

    let pollCount = 0;
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/threads' && init?.method === 'POST') return jsonOk(ORGANIZER_THREAD);
      if (path === '/api/messages' && init?.method === 'POST') return jsonOk({ id: 'msg-trigger', ok: true });
      if (path.startsWith('/api/messages?')) {
        pollCount++;
        if (pollCount >= 2) return jsonOk({ messages: [catMessage] });
        return jsonOk({ messages: [] });
      }
      if (path === '/api/threads') return jsonOk({ threads: [...uncatThreads, ORGANIZER_THREAD] });
      return defaultSidebarApiMock(path);
    });

    await harness.render();
    const btn = findOrganizeButton(harness.container);
    await act(async () => {
      btn!.click();
    });
    await harness.flush();

    for (let tick = 0; tick < 6; tick++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await harness.flush();
    }
    for (let settle = 0; settle < 10; settle++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await harness.flush();
      if (harness.container.textContent?.includes('已选 2 个 thread')) break;
    }
    expect(harness.container.textContent).toContain('已选 2 个 thread');

    // Find t1's organizer row and click the "开发" label to deselect it
    const modal = harness.container.querySelector('[data-testid="thread-organizer-modal"]') as HTMLElement | null;
    expect(modal).toBeTruthy();
    const t1Row = modal!.querySelector('[data-thread-id="t1"]');
    expect(t1Row).toBeTruthy();
    const devBtnInT1 = Array.from(t1Row!.querySelectorAll('button')).find((b) => b.textContent?.includes('开发'));
    expect(devBtnInT1).toBeTruthy();

    await act(async () => {
      devBtnInT1!.click();
    });
    await harness.flush();

    expect(harness.container.textContent).toContain('已选 1 个 thread');
    expect(harness.container.textContent).toContain('批量应用 (1)');

    const applyBtn = Array.from(harness.container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('批量应用'),
    );
    await act(async () => {
      applyBtn!.click();
    });
    await harness.flush();

    // Only 闲聊 should be created (开发 was deselected by user)
    expect(createLabelMock).toHaveBeenCalledTimes(1);
    expect(createLabelMock).toHaveBeenCalledWith('闲聊', '#C47F52');

    const updateFn = mockStore.updateThreadLabels as ReturnType<typeof vi.fn>;
    expect(updateFn).toHaveBeenCalledTimes(1);
    expect(updateFn).toHaveBeenCalledWith('t2', ['auto-1']);

    (useLabelStore as unknown as LabelStoreExt).setState({ labels: testData.TEST_LABELS });
  });

  it('retry after partial failure uses real label IDs without re-creating labels', async () => {
    const { useLabelStore } = await import('@/stores/label-store');
    type LabelStoreExt = ReturnType<typeof vi.fn> & {
      setState: (p: Record<string, unknown>) => void;
      getState: () => Record<string, unknown>;
    };
    (useLabelStore as unknown as LabelStoreExt).setState({ labels: [] });

    const uncatThreads = [makeThread('t1'), makeThread('t2')];
    mockStore.threads = [...uncatThreads];
    const updateFn = mockStore.updateThreadLabels as ReturnType<typeof vi.fn>;
    updateFn.mockClear();

    let labelIdCounter = 0;
    const createLabelMock = vi.fn().mockImplementation(async (name: string, color: string) => {
      const label = {
        id: `auto-${++labelIdCounter}`,
        name,
        color,
        sortOrder: 0,
        createdBy: 'u1',
        createdAt: Date.now(),
      };
      const store = (useLabelStore as unknown as LabelStoreExt).getState();
      (useLabelStore as unknown as LabelStoreExt).setState({ labels: [...(store.labels as unknown[]), label] });
      return label;
    });
    (useLabelStore as unknown as LabelStoreExt).setState({ createLabel: createLabelMock });

    // First apply: t1 fails, t2 succeeds
    let applyCallCount = 0;
    updateFn.mockImplementation((threadId: string) => {
      applyCallCount++;
      if (threadId === 't1' && applyCallCount <= 2) return Promise.reject(new Error('network'));
      return Promise.resolve(undefined);
    });

    const suggestionsJson = JSON.stringify({
      newLabels: [
        { name: '开发', color: '#5B8C5A' },
        { name: '闲聊', color: '#C47F52' },
      ],
      assignments: { t1: ['开发'], t2: ['闲聊'] },
    });
    const catMessage = {
      id: 'msg-cat-1',
      catId: 'opus',
      timestamp: Date.now() + 5000,
      isDraft: false,
      content: `建议标签\n<!-- SUGGESTIONS_JSON:${suggestionsJson} -->`,
    };

    let pollCount = 0;
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/threads' && init?.method === 'POST') return jsonOk(ORGANIZER_THREAD);
      if (path === '/api/messages' && init?.method === 'POST') return jsonOk({ id: 'msg-trigger', ok: true });
      if (path.startsWith('/api/messages?')) {
        pollCount++;
        if (pollCount >= 2) return jsonOk({ messages: [catMessage] });
        return jsonOk({ messages: [] });
      }
      if (path === '/api/threads') return jsonOk({ threads: [...uncatThreads, ORGANIZER_THREAD] });
      return defaultSidebarApiMock(path);
    });

    await harness.render();
    const btn = findOrganizeButton(harness.container);
    await act(async () => {
      btn!.click();
    });
    await harness.flush();

    for (let tick = 0; tick < 6; tick++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await harness.flush();
    }
    for (let settle = 0; settle < 10; settle++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await harness.flush();
      if (harness.container.textContent?.includes('已选 2 个 thread')) break;
    }
    expect(harness.container.textContent).toContain('批量应用 (2)');

    // First Apply — t1 fails
    const applyBtn = Array.from(harness.container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('批量应用'),
    );
    await act(async () => {
      applyBtn!.click();
    });
    await harness.flush();

    // Labels created once
    expect(createLabelMock).toHaveBeenCalledTimes(2);
    // Modal stays open (partial failure)
    expect(harness.container.textContent).toContain('应用失败');

    // Retry — click Apply again
    const retryBtn = Array.from(harness.container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('批量应用'),
    );
    expect(retryBtn).toBeTruthy();

    // Let retry succeed for all
    updateFn.mockResolvedValue(undefined);

    await act(async () => {
      retryBtn!.click();
    });
    await harness.flush();

    // Labels should NOT be created again (still 2 total)
    expect(createLabelMock).toHaveBeenCalledTimes(2);

    // Retry must have called updateThreadLabels with real label IDs (auto-*), not pending:*
    const retryCalls = updateFn.mock.calls.slice(2);
    expect(retryCalls.length).toBeGreaterThan(0);
    const retryCallMap = new Map(retryCalls.map((c: unknown[]) => [c[0] as string, c[1] as string[]]));
    expect(retryCallMap.has('t1')).toBe(true);
    const t1Labels = retryCallMap.get('t1')!;
    expect(t1Labels[0]).toMatch(/^auto-/);
    expect(t1Labels[0]).not.toMatch(/^pending:/);

    (useLabelStore as unknown as LabelStoreExt).setState({ labels: testData.TEST_LABELS });
  });

  it('shows error toast when trigger message fails', async () => {
    mockStore.threads = [makeThread('t1')];

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/threads' && init?.method === 'POST') {
        return jsonOk(ORGANIZER_THREAD);
      }
      if (path === '/api/messages' && init?.method === 'POST') {
        return textFail(500, 'send failed');
      }
      if (path === '/api/threads') {
        return jsonOk({ threads: [makeThread('t1'), ORGANIZER_THREAD] });
      }
      return defaultSidebarApiMock(path);
    });

    await harness.render();

    const btn = findOrganizeButton(harness.container);
    expect(btn).toBeTruthy();

    await act(async () => {
      btn!.click();
    });
    await harness.flush();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    await harness.flush();

    expect(addToastMock).toHaveBeenCalled();
    expect(addToastMock.mock.calls[0]?.[0]).toMatchObject({
      type: 'error',
      title: '发送失败',
    });
  });
});
