import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useLabelStore } from '@/stores/label-store';
import {
  createThreadSidebarHarness,
  defaultSidebarApiMock,
  installThreadSidebarGlobals,
  jsonOk,
  mockApiFetch,
  mockStore,
  resetThreadSidebarGlobals,
  resetThreadSidebarMocks,
  type ThreadSidebarHarness,
} from './thread-sidebar-test-helpers';

const anchor = 'group:attention_a';
const groups = [{ id: 'attention_a', name: 'F277', threadIds: ['a', 'b'] }];
const cacheKey = 'cat-cafe:f277:cluster-open:v1';

describe('Group header immediate interaction', () => {
  let harness: ThreadSidebarHarness;
  let savedOpen: Record<string, boolean>;
  let requests: Array<{ open: boolean; finish: (ok?: boolean) => void }>;

  beforeEach(() => {
    installThreadSidebarGlobals();
    resetThreadSidebarMocks();
    savedOpen = { [anchor]: false };
    requests = [];
    Object.assign(mockStore, {
      threads: ['a', 'b'].map((id) => ({
        id,
        title: `F277 member ${id}`,
        projectPath: '/project',
        participants: [],
        createdBy: 'user',
        createdAt: 1710000000000,
        lastActiveAt: 1710000000000,
      })),
      currentThreadId: 'default',
      threadStates: {},
      isLoadingThreads: false,
    });
    useLabelStore.setState({ labels: [], isLoading: false });
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/labels') return jsonOk([]);
      if (path !== '/api/config/thread-attention') return defaultSidebarApiMock(path);
      if (init?.method !== 'PUT') return jsonOk({ aliases: {}, open: savedOpen, groups });
      const body = JSON.parse(String(init.body)) as { anchor: string; open: boolean };
      return new Promise<Response>((resolve) => {
        requests.push({
          open: body.open,
          finish(ok = true) {
            if (ok) savedOpen = { ...savedOpen, [body.anchor]: body.open };
            resolve(new Response(JSON.stringify({ aliases: {}, open: savedOpen, groups }), { status: ok ? 200 : 500 }));
          },
        });
      });
    });
    harness = createThreadSidebarHarness();
  });

  afterEach(() => {
    harness.cleanup();
    resetThreadSidebarGlobals();
  });

  function header() {
    const element = harness.container.querySelector<HTMLElement>(`[data-attention-cluster="${anchor}"]`);
    if (!element) throw new Error('Group header missing');
    return element;
  }

  async function clickHeader() {
    const title = [...header().querySelectorAll('span')].find((span) => span.textContent === 'F277');
    if (!title) throw new Error('Group title missing');
    await act(async () => title.click());
  }

  async function search(query: string) {
    const input = harness.container.querySelector<HTMLInputElement>('input[placeholder="搜索对话、项目或 ID..."]');
    if (!input) throw new Error('Search input missing');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, query);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await harness.flush();
  }

  async function finish(index: number, ok = true) {
    await act(async () => requests[index]?.finish(ok));
    await harness.flush();
  }

  it('opens from the title before the server replies, while caching only confirmed preferences', async () => {
    await harness.render();
    expect(header().dataset.expanded).toBe('false');
    await clickHeader();
    expect(requests.map((request) => request.open)).toEqual([true]);
    expect(header().dataset.expanded).toBe('true');
    expect(JSON.parse(window.localStorage.getItem(cacheKey) ?? '{}')).toEqual({ [anchor]: false });
    await finish(0);
    expect(header().dataset.expanded).toBe('true');
    expect(JSON.parse(window.localStorage.getItem(cacheKey) ?? '{}')).toEqual({ [anchor]: true });
  });

  it('keeps rapid open-close intent visible when the older open response arrives', async () => {
    await harness.render();
    await clickHeader();
    await clickHeader();
    expect(header().dataset.expanded).toBe('false');
    await finish(0);
    expect(requests.map((request) => request.open)).toEqual([true, false]);
    expect(header().dataset.expanded).toBe('false');
    await finish(1);
    expect(header().dataset.expanded).toBe('false');
    expect(savedOpen[anchor]).toBe(false);
  });

  it('rolls back a failed toggle and leaves the durable cache unchanged', async () => {
    await harness.render();
    await clickHeader();
    expect(header().dataset.expanded).toBe('true');
    await finish(0, false);
    expect(header().dataset.expanded).toBe('false');
    expect(JSON.parse(window.localStorage.getItem(cacheKey) ?? '{}')).toEqual({ [anchor]: false });
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain('未能保存');
  });

  it('retains the newest intent when two clicks share a render and the older save fails', async () => {
    await harness.render();
    const toggle = header().querySelector<HTMLButtonElement>('button[aria-expanded]');
    await act(async () => {
      toggle?.click();
      toggle?.click();
    });
    expect(header().dataset.expanded).toBe('false');
    await finish(0, false);
    expect(requests.map((request) => request.open)).toEqual([true, false]);
    expect(header().dataset.expanded).toBe('false');
    await finish(1);
    expect(savedOpen[anchor]).toBe(false);
    expect(harness.container.querySelector('[role="alert"]')).toBeNull();
  });

  it('allows collapse during search and resets only the search override for a different query', async () => {
    await harness.render();
    await search('F277');
    expect(header().dataset.expanded).toBe('true');
    await clickHeader();
    expect(header().dataset.expanded).toBe('false');
    await finish(0);
    expect(header().dataset.expanded).toBe('false');
    await search('member');
    expect(header().dataset.expanded).toBe('true');
    await search('F277');
    expect(header().dataset.expanded).toBe('true');
    await search('');
    expect(header().dataset.expanded).toBe('false');
    expect(savedOpen[anchor]).toBe(false);
  });

  it('does not reuse an old search override when its delayed response arrives in a later search', async () => {
    await harness.render();
    await search('F277');
    await clickHeader();
    await search('member');
    await search('F277');
    await finish(0);
    expect(header().dataset.expanded).toBe('true');
    await search('');
    expect(header().dataset.expanded).toBe('false');
  });

  it('restores search recall if the first collapse cannot be saved', async () => {
    await harness.render();
    await search('F277');
    await clickHeader();
    expect(header().dataset.expanded).toBe('false');
    await finish(0, false);
    expect(header().dataset.expanded).toBe('true');
  });

  it('restores the last confirmed search choice if a later toggle fails', async () => {
    await harness.render();
    await search('F277');
    await clickHeader();
    await finish(0);
    await clickHeader();
    expect(header().dataset.expanded).toBe('true');
    await finish(1, false);
    expect(header().dataset.expanded).toBe('false');
    expect(savedOpen[anchor]).toBe(false);
  });
});
