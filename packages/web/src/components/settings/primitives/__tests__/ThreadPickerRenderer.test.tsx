/**
 * F202 W2-3 h1 follow-up — a generic `thread-picker` operation result.
 *
 * The Host renderer reuses the real Sidebar projection (rows, attention Groups, pin/order),
 * keeps checked rows in place, retains selections hidden by search, and saves the whole draft
 * through the operation's declared `choose` row action.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
// Use the real shared confirm provider rather than the suite-wide auto-accepting stub.
vi.mock('@/components/useConfirm', async (importOriginal) => importOriginal());

import { useLabelStore } from '@/stores/label-store';
import { type SidebarSnapshotRow, useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { apiFetch } from '@/utils/api-client';
import { markApiGetGeneration } from '@/utils/api-get-generation';
import type { PlatformOperationStatus } from '../../../HubConfigIcons';

vi.mock('@/utils/offline-store', () => ({
  loadSidebarSnapshot: vi.fn(async () => null),
  saveSidebarSnapshot: vi.fn(async () => undefined),
}));

const mockApiFetch = vi.mocked(apiFetch);
const { ActionRenderer } = await import('../ActionRenderer');
const { ConfirmProvider } = await import('../../../useConfirm');

const target = { kind: 'plugin', id: 'fixture' } as const;
const operation: PlatformOperationStatus = {
  name: 'threads',
  label: '监听会话',
  actions: [{ id: 'list', label: '读取会话', render: 'status', resultRender: 'thread-picker' }],
  rowActions: [{ id: 'choose', label: '保存', next: 'list' }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function snapshotResponse(threads: unknown[], generation: number): Response {
  const response = jsonResponse({ threads });
  markApiGetGeneration(response, generation);
  return response;
}

function row(
  id: string,
  options: Partial<Pick<SidebarSnapshotRow, 'pinned' | 'systemKind' | 'labels' | 'lastActiveAt'>> = {},
): SidebarSnapshotRow {
  return {
    id,
    title: `会话 ${id}`,
    participants: [],
    pinned: false,
    favorited: false,
    labels: [],
    preferredCats: [],
    projectPath: '/project/alpha',
    lastActiveAt: 100,
    systemKind: null,
    isHubThread: false,
    unreadCount: 0,
    hasUserMention: false,
    presence: { status: 'idle' },
    ...options,
  };
}

const attention = {
  aliases: {},
  memberSort: {},
  groups: [{ id: 'group-1', name: '客户跟进', threadIds: ['t1', 't2'] }],
  open: {},
  collapsedPeek: {},
  recentGroupIds: [],
};

function installFixture(rows: SidebarSnapshotRow[], selected: string[], excluded: string[] = []) {
  useSidebarProjectionStore.setState({
    rows,
    pendingThreadCommands: {},
    hasCanonicalSnapshot: true,
  });
  useLabelStore.setState({
    labels: [{ id: 'l1', name: '发布', color: '#000', sortOrder: 0, createdBy: 'u', createdAt: 1 }],
  });
  const calls: Array<{ url: string; body?: string }> = [];
  mockApiFetch.mockImplementation(async (url, init) => {
    const path = String(url);
    const body = typeof init?.body === 'string' ? init.body : undefined;
    calls.push({ url: path, ...(body === undefined ? {} : { body }) });
    if (path === '/api/config/thread-attention') return jsonResponse(attention);
    if (path === '/api/plugins/fixture/actions/threads/list') {
      return jsonResponse({ ok: true, render: 'thread-picker', data: { selected, excluded } });
    }
    if (path === '/api/plugins/fixture/actions/threads/choose') {
      const parsed = JSON.parse(body ?? '{}') as { selection: string; ids: string[] };
      return jsonResponse({
        ok: true,
        render: 'thread-picker',
        data: { selected: parsed.ids, excluded },
      });
    }
    return jsonResponse({ error: `unexpected request ${path}` }, 500);
  });
  return calls;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function byTestId(container: HTMLElement, id: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!element) throw new Error(`missing ${id}`);
  return element;
}

function button(container: HTMLElement, id: string): HTMLButtonElement {
  const element = byTestId(container, id);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`${id} is not a button`);
  return element;
}

function click(container: HTMLElement, id: string) {
  byTestId(container, id).click();
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('input value setter unavailable');
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function pickerRowIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-testid^="thread-picker-row-"]')).map((element) =>
    (element.getAttribute('data-testid') ?? '').replace('thread-picker-row-', ''),
  );
}

describe('generic thread-picker renderer', () => {
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
    useLabelStore.setState({ labels: [] });
    useSidebarProjectionStore.setState({ rows: [], pendingThreadCommands: {}, hasCanonicalSnapshot: true });
    localStorage.clear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useSidebarProjectionStore.setState({ rows: [], pendingThreadCommands: {}, hasCanonicalSnapshot: false });
    useLabelStore.setState({ labels: [] });
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('renders the real grouped Sidebar order without moving a checked row, then saves the whole draft', async () => {
    const calls = installFixture(
      [
        row('t1', { pinned: true, lastActiveAt: 300 }),
        row('t2', { labels: ['l1'], lastActiveAt: 200 }),
        row('t3', { systemKind: 'connector_hub', lastActiveAt: 400 }),
      ],
      ['t2'],
      ['t4'],
    );
    await act(async () => root.render(<ActionRenderer target={target} operation={operation} />));
    await flush();

    expect(byTestId(container, 'thread-picker-summary').textContent).toContain('已选 1 个');
    await act(async () => button(container, 'thread-picker-open').click());
    expect(byTestId(container, 'thread-picker-dialog')).toBeTruthy();
    expect(container.textContent).toContain('客户跟进');
    expect(pickerRowIds(container)).toEqual(['t1', 't2']);
    expect(container.querySelector('[data-testid="thread-picker-row-t3"]')).toBeNull();
    expect(container.querySelector('[data-testid="thread-picker-row-t4"]')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('[data-testid="thread-picker-check-t2"]')?.checked).toBe(true);
    expect(byTestId(container, 'thread-picker-count').textContent).toContain('已选 1 个');

    await act(async () => click(container, 'thread-picker-check-t1'));
    expect(pickerRowIds(container)).toEqual(['t1', 't2']);
    expect(byTestId(container, 'thread-picker-count').textContent).toContain('已选 2 个');

    await act(async () => button(container, 'thread-picker-save').click());
    await flush();
    const choose = calls.find((call) => call.url.endsWith('/actions/threads/choose'));
    if (!choose?.body) throw new Error('missing choose body');
    const body = JSON.parse(choose.body) as { selection: string; ids: string[] };
    expect(body.selection).toBe('threads');
    expect(new Set(body.ids)).toEqual(new Set(['t1', 't2']));
    expect(container.querySelector('[data-testid="thread-picker-dialog"]')).toBeNull();
    expect(byTestId(container, 'thread-picker-summary').textContent).toContain('已选 2 个');
  });

  it('keeps checked rows that search hides in the saved draft', async () => {
    const calls = installFixture([row('t1'), row('t2')], ['t1', 't2']);
    await act(async () => root.render(<ActionRenderer target={target} operation={operation} />));
    await flush();
    await act(async () => button(container, 'thread-picker-open').click());

    const search = byTestId(container, 'thread-picker-search') as HTMLInputElement;
    await act(async () => setInput(search, 't1'));
    expect(pickerRowIds(container)).toEqual(['t1']);
    expect(byTestId(container, 'thread-picker-count').textContent).toContain('已选 2 个');

    await act(async () => button(container, 'thread-picker-save').click());
    await flush();
    const choose = calls.find((call) => call.url.endsWith('/actions/threads/choose'));
    if (!choose?.body) throw new Error('missing choose body');
    const body = JSON.parse(choose.body) as { ids: string[] };
    expect(new Set(body.ids)).toEqual(new Set(['t1', 't2']));
  });

  it('cancels without writing and keeps the confirmed selection', async () => {
    const calls = installFixture([row('t1'), row('t2')], ['t1']);
    await act(async () => root.render(<ActionRenderer target={target} operation={operation} />));
    await flush();
    await act(async () => button(container, 'thread-picker-open').click());
    await act(async () => click(container, 'thread-picker-check-t2'));
    expect(byTestId(container, 'thread-picker-count').textContent).toContain('已选 2 个');
    await act(async () => button(container, 'thread-picker-cancel').click());
    expect(container.querySelector('[data-testid="thread-picker-dialog"]')).toBeNull();
    expect(byTestId(container, 'thread-picker-summary').textContent).toContain('已选 1 个');
    expect(calls.some((call) => call.url.endsWith('/actions/threads/choose'))).toBe(false);
  });

  it('asks the shared confirmation before saving a declared choose', async () => {
    const calls = installFixture([row('t1')], []);
    const confirmedOperation: PlatformOperationStatus = {
      ...operation,
      rowActions: [{ id: 'choose', label: '保存', confirm: '确认保存这些监听会话？', next: 'list' }],
    };
    await act(async () =>
      root.render(
        <ConfirmProvider>
          <ActionRenderer target={target} operation={confirmedOperation} />
        </ConfirmProvider>,
      ),
    );
    await flush();
    await act(async () => button(container, 'thread-picker-open').click());
    await act(async () => button(container, 'thread-picker-save').click());
    const confirm = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === '确认',
    );
    if (!confirm) throw new Error('missing shared confirmation');
    expect(calls.some((call) => call.url.endsWith('/actions/threads/choose'))).toBe(false);
    await act(async () => confirm.click());
    await flush();
    expect(calls.some((call) => call.url.endsWith('/actions/threads/choose'))).toBe(true);
  });

  it('does not auto-read a list action that declares confirmation', async () => {
    const calls = installFixture([row('t1'), row('t2')], ['t2']);
    const confirmedListOperation: PlatformOperationStatus = {
      ...operation,
      actions: [
        { id: 'list', label: '读取会话', render: 'status', resultRender: 'thread-picker', confirm: '读取这些会话？' },
      ],
    };
    await act(async () =>
      root.render(
        <ConfirmProvider>
          <ActionRenderer target={target} operation={confirmedListOperation} />
        </ConfirmProvider>,
      ),
    );
    await flush();
    expect(calls.some((call) => call.url.endsWith('/actions/threads/list'))).toBe(false);
    await act(async () => button(container, 'thread-picker-read').click());
    const confirm = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === '确认',
    );
    if (!confirm) throw new Error('missing shared confirmation');
    await act(async () => confirm.click());
    await flush();
    expect(calls.some((call) => call.url.endsWith('/actions/threads/list'))).toBe(true);
    expect(byTestId(container, 'thread-picker-summary').textContent).toContain('已选 1 个');
  });

  it('cleans legacy selected ids to the current selectable owner rows when opening', async () => {
    const calls = installFixture([row('t1'), row('t2'), row('own')], ['t2', 'own'], ['own']);
    await act(async () => root.render(<ActionRenderer target={target} operation={operation} />));
    await flush();
    expect(byTestId(container, 'thread-picker-summary').textContent).toContain('已选 1 个');
    await act(async () => button(container, 'thread-picker-open').click());
    expect(container.querySelector('[data-testid="thread-picker-row-own"]')).toBeNull();
    await act(async () => button(container, 'thread-picker-save').click());
    await flush();
    const choose = calls.find((call) => call.url.endsWith('/actions/threads/choose'));
    if (!choose?.body) throw new Error('missing choose body');
    const body = JSON.parse(choose.body) as { ids: string[] };
    expect(body.ids).toEqual(['t2']);
  });

  it('loads its own sidebar directory on a cold settings mount', async () => {
    useSidebarProjectionStore.setState({
      rows: [],
      appliedGeneration: 0,
      hasCanonicalSnapshot: false,
      pendingThreadCommands: {},
      refreshing: false,
    });
    useLabelStore.setState({
      labels: [{ id: 'l1', name: '发布', color: '#000', sortOrder: 0, createdBy: 'u', createdAt: 1 }],
    });
    let generation = 0;
    mockApiFetch.mockImplementation(async (url) => {
      const path = String(url);
      if (path.startsWith('/api/threads?view=sidebar')) {
        return snapshotResponse(
          [
            {
              id: 't1',
              title: '置顶的发布复盘',
              projectPath: '/project/alpha',
              participants: [],
              lastActiveAt: 300,
              pinned: true,
              labels: [],
              unreadCount: 0,
              hasUserMention: false,
              presence: { status: 'idle' },
            },
            {
              id: 't2',
              title: '导出失败调查',
              projectPath: '/project/alpha',
              participants: [],
              lastActiveAt: 200,
              pinned: false,
              labels: ['l1'],
              unreadCount: 0,
              hasUserMention: false,
              presence: { status: 'idle' },
            },
          ],
          ++generation,
        );
      }
      if (path === '/api/config/thread-attention') return jsonResponse(attention);
      if (path.endsWith('/actions/threads/list')) {
        return jsonResponse({ ok: true, render: 'thread-picker', data: { selected: ['t2'], excluded: [] } });
      }
      return jsonResponse({ error: `unexpected request ${path}` }, 500);
    });

    await act(async () => root.render(<ActionRenderer target={target} operation={operation} />));
    await flush();
    await flush();
    await flush();
    expect(byTestId(container, 'thread-picker-summary').textContent).toContain('已选 1 个');
    await act(async () => button(container, 'thread-picker-open').click());
    expect(pickerRowIds(container)).toEqual(['t1', 't2']);
  });

  it('reloads selected/excluded after a sibling refresh revision', async () => {
    useSidebarProjectionStore.setState({
      rows: [row('t1'), row('t2'), row('own')],
      pendingThreadCommands: {},
      hasCanonicalSnapshot: true,
    });
    useLabelStore.setState({ labels: [] });
    const calls: Array<{ url: string; body?: string }> = [];
    let listCalls = 0;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one route table covers cold start, refresh revision and save.
    mockApiFetch.mockImplementation(async (url, init) => {
      const path = String(url);
      const body = typeof init?.body === 'string' ? init.body : undefined;
      calls.push({ url: path, ...(body === undefined ? {} : { body }) });
      if (path === '/api/config/thread-attention') return jsonResponse(attention);
      if (path.endsWith('/actions/threads/list')) {
        listCalls += 1;
        return jsonResponse({
          ok: true,
          render: 'thread-picker',
          data: { selected: ['t2'], excluded: listCalls > 1 ? ['own'] : [] },
        });
      }
      if (path.endsWith('/actions/threads/choose')) {
        const parsed = JSON.parse(body ?? '{}') as { ids: string[] };
        return jsonResponse({ ok: true, render: 'thread-picker', data: { selected: parsed.ids, excluded: [] } });
      }
      return jsonResponse({ error: `unexpected request ${path}` }, 500);
    });

    await act(async () => root.render(<ActionRenderer target={target} operation={operation} refreshRevision={0} />));
    await flush();
    await act(async () => button(container, 'thread-picker-open').click());
    expect(container.querySelector('[data-testid="thread-picker-row-own"]')).toBeTruthy();
    await act(async () => button(container, 'thread-picker-cancel').click());

    await act(async () => root.render(<ActionRenderer target={target} operation={operation} refreshRevision={1} />));
    await flush();
    await act(async () => button(container, 'thread-picker-open').click());
    expect(container.querySelector('[data-testid="thread-picker-row-own"]')).toBeNull();
    await act(async () => button(container, 'thread-picker-save').click());
    await flush();
    const choose = calls.find((call) => call.url.endsWith('/actions/threads/choose'));
    if (!choose?.body) throw new Error('missing choose body');
    const body = JSON.parse(choose.body) as { ids: string[] };
    expect(body.ids).toEqual(['t2']);
  });

  it('offers a directory retry when the cold snapshot fails', async () => {
    useSidebarProjectionStore.setState({
      rows: [],
      appliedGeneration: 0,
      hasCanonicalSnapshot: false,
      pendingThreadCommands: {},
      refreshing: false,
    });
    useLabelStore.setState({ labels: [] });
    mockApiFetch.mockImplementation(async (url) => {
      const path = String(url);
      if (path.startsWith('/api/threads?view=sidebar')) return jsonResponse({ error: 'unavailable' }, 503);
      if (path === '/api/config/thread-attention') return jsonResponse(attention);
      if (path.endsWith('/actions/threads/list')) {
        return jsonResponse({ ok: true, render: 'thread-picker', data: { selected: [], excluded: [] } });
      }
      return jsonResponse({ error: `unexpected request ${path}` }, 500);
    });

    await act(async () => root.render(<ActionRenderer target={target} operation={operation} />));
    await flush();
    await flush();
    expect(byTestId(container, 'thread-picker-retry-directory')).toBeTruthy();
    expect(container.querySelector('[data-testid="thread-picker-open"]')).toBeNull();
  });

  it('does not save a cached-only directory when the canonical refresh fails', async () => {
    useSidebarProjectionStore.setState({
      rows: [row('t1')],
      appliedGeneration: 0,
      hasCanonicalSnapshot: false,
      pendingThreadCommands: {},
      refreshing: false,
    });
    useLabelStore.setState({ labels: [] });
    const calls: Array<{ url: string; body?: string }> = [];
    let refreshCalls = 0;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one route table covers the 503 recovery and successful canonical retry.
    mockApiFetch.mockImplementation(async (url, init) => {
      const path = String(url);
      const body = typeof init?.body === 'string' ? init.body : undefined;
      calls.push({ url: path, ...(body === undefined ? {} : { body }) });
      if (path.startsWith('/api/threads?view=sidebar')) {
        refreshCalls += 1;
        if (refreshCalls === 1) return jsonResponse({ error: 'unavailable' }, 503);
        return snapshotResponse(
          [
            {
              id: 't1',
              title: '缓存里的会话',
              projectPath: '/project/alpha',
              participants: [],
              lastActiveAt: 300,
              pinned: false,
              labels: [],
              unreadCount: 0,
              hasUserMention: false,
              presence: { status: 'idle' },
            },
            {
              id: 't2',
              title: '缓存外的旧监听会话',
              projectPath: '/project/alpha',
              participants: [],
              lastActiveAt: 200,
              pinned: false,
              labels: [],
              unreadCount: 0,
              hasUserMention: false,
              presence: { status: 'idle' },
            },
          ],
          2,
        );
      }
      if (path === '/api/config/thread-attention') return jsonResponse(attention);
      if (path.endsWith('/actions/threads/list')) {
        return jsonResponse({ ok: true, render: 'thread-picker', data: { selected: ['t2'], excluded: [] } });
      }
      if (path.endsWith('/actions/threads/choose')) {
        const parsed = JSON.parse(body ?? '{}') as { ids: string[] };
        return jsonResponse({ ok: true, render: 'thread-picker', data: { selected: parsed.ids, excluded: [] } });
      }
      return jsonResponse({ error: `unexpected request ${path}` }, 500);
    });

    await act(async () => root.render(<ActionRenderer target={target} operation={operation} />));
    await flush();
    await flush();
    expect(byTestId(container, 'thread-picker-retry-directory')).toBeTruthy();
    expect(container.querySelector('[data-testid="thread-picker-open"]')).toBeNull();
    expect(calls.some((call) => call.url.endsWith('/actions/threads/choose'))).toBe(false);

    await act(async () => button(container, 'thread-picker-retry-directory').click());
    await flush();
    await flush();
    await act(async () => button(container, 'thread-picker-open').click());
    expect(container.querySelector<HTMLInputElement>('[data-testid="thread-picker-check-t2"]')?.checked).toBe(true);
    await act(async () => button(container, 'thread-picker-save').click());
    await flush();
    const choose = calls.find((call) => call.url.endsWith('/actions/threads/choose'));
    if (!choose?.body) throw new Error('missing choose body');
    const body = JSON.parse(choose.body) as { ids: string[] };
    expect(body.ids).toEqual(['t2']);
  });

  it('does not truncate more than 200 selectable conversations', async () => {
    installFixture(
      Array.from({ length: 205 }, (_, index) => row(`t${String(index).padStart(3, '0')}`)),
      [],
    );
    await act(async () => root.render(<ActionRenderer target={target} operation={operation} />));
    await flush();
    await act(async () => button(container, 'thread-picker-open').click());
    expect(pickerRowIds(container)).toHaveLength(205);
    const search = byTestId(container, 'thread-picker-search') as HTMLInputElement;
    await act(async () => setInput(search, 't204'));
    expect(pickerRowIds(container)).toEqual(['t204']);
  });
});
