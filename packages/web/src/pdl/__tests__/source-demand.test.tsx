import type { ActiveExecutionProjection, BacklogItem } from '@cat-cafe/shared';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { useWorkspace } from '@/hooks/useWorkspace';
import { activeExecutionKey, useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { type ProjectBindings, ProjectDataBinding } from '../ProjectDataBinding';
import { useMemoryBindings } from '../useMemoryBindings';
import { useSidebarBindings } from '../useSidebarBindings';
import { useWorkbenchBindings } from '../useWorkbenchBindings';
import { fixtureData, fixtureUi } from './chat-fixture';
import { act, cleanup, renderHook, waitFor } from './hook-host';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'https://api.test' }));
afterEach(cleanup);

it('pulls the sidebar full list and preferences when needed, not when its host mounts', async () => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path === '/api/threads?view=sidebar') return Response.json({ threads: [] });
    if (path === '/api/labels') return Response.json([]);
    if (path === '/api/config/thread-attention') return Response.json({ groups: [], open: {} });
    throw new Error('Unexpected source read: ' + path);
  });
  const data = fixtureData();
  let needed: boolean | number = false,
    commit!: () => void;
  renderHook(() => {
    const [, refresh] = useState(0);
    commit = () => refresh((n) => n + 1);
    return useSidebarBindings(data, needed);
  });
  await act(async () => {});
  expect(apiFetch).not.toHaveBeenCalled();
  needed = 1;
  await act(commit);
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.map(([path]) => path)
      .sort(),
  ).toEqual(['/api/config/thread-attention', '/api/labels', '/api/threads?view=sidebar']);
  vi.mocked(apiFetch).mockClear();
  await act(commit);
  expect(apiFetch).not.toHaveBeenCalled();
  needed = false;
  await act(commit);
  needed = 2;
  await act(commit);
  expect(apiFetch).toHaveBeenCalledTimes(3);
});

it('keeps unopened owners idle through boot and a conversation switch, then reads just the demanded board source', async () => {
  vi.mocked(apiFetch).mockReset();
  const items = Array.from(
    { length: 250 },
    (_, i) =>
      ({
        id: 'item-' + i,
        title: 'Feature ' + i,
        tags: ['F' + String(i + 1).padStart(3, '0')],
        userId: 'owner',
        summary: '',
        priority: 'p2',
        status: 'open',
        createdBy: 'user',
        createdAt: 0,
        updatedAt: 0,
        audit: [],
      }) satisfies BacklogItem,
  );
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    const url = new URL(String(path), 'https://api.test');
    if (url.pathname === '/api/external-projects') return Response.json({ projects: [] });
    if (url.pathname === '/api/backlog/items') return Response.json({ items });
    if (url.pathname === '/api/backlog/feature-doc-detail')
      return Response.json({ featureId: url.searchParams.get('featureId'), phases: [], dependencies: [] });
    if (url.pathname === '/api/threads') return Response.json({ threads: [] });
    if (url.pathname === '/api/tasks') return Response.json({ tasks: [] });
    throw new Error('Unexpected source read: ' + path);
  });
  const workspace = {
    worktreeId: null,
    worktrees: [],
    tree: [],
    file: null,
    loading: false,
    error: null,
  } as unknown as ReturnType<typeof useWorkspace>;
  const ui = fixtureUi();
  let data: ReturnType<typeof fixtureData> = { ...fixtureData(), threadId: 'default', messages: [] },
    needed: ReadonlySet<string> = new Set(),
    readGeneration = 1,
    binding!: ProjectBindings,
    commit!: () => void;
  const changed = (value: ProjectBindings) => {
    binding = value;
  };
  renderHook(
    () => {
      const [, refresh] = useState(0);
      commit = () => refresh((n) => n + 1);
    },
    () => (
      <ProjectDataBinding
        data={data}
        needed={needed}
        readGeneration={readGeneration}
        workspace={workspace}
        fields={ui.f}
        target={() => 'codex'}
        ui={ui}
        changed={changed}
      />
    ),
  );
  await act(async () => {});
  expect(vi.mocked(apiFetch).mock.calls).toEqual([]);
  data = fixtureData();
  await act(commit);
  expect(vi.mocked(apiFetch).mock.calls).toEqual([]);
  data = { ...data, threadId: 'other-thread', messages: [] };
  await act(commit);
  expect(vi.mocked(apiFetch).mock.calls).toEqual([]);
  needed = new Set(['project.board.items']);
  await act(commit);
  await waitFor(() => expect((binding.data.board as { read: { load: string } }).read.load).toBe(''));
  const calls = vi.mocked(apiFetch).mock.calls.map(([path]) => String(path));
  expect(calls).toHaveLength(2);
  expect([...new Set(calls.map((path) => new URL(path, 'https://api.test').pathname))].sort()).toEqual([
    '/api/backlog/items',
    '/api/external-projects',
  ]);
  window.clowderChat = { dataOk: vi.fn(), dataError: vi.fn() } as unknown as typeof window.clowderChat;
  needed = new Set(['project.board.items', 'project.board.docs.F001.value']);
  await act(commit);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
  expect(vi.mocked(apiFetch).mock.calls[2][0]).toBe('/api/backlog/feature-doc-detail?featureId=F001');
  await act(commit);
  expect(apiFetch).toHaveBeenCalledTimes(3);
  needed = new Set();
  await act(commit);
  needed = new Set(['project.board.items']);
  await act(commit);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(5));
  needed = new Set(['project.workbench.tasks']);
  vi.mocked(apiFetch).mockClear();
  await act(commit);
  await waitFor(() => expect((binding.data.workbench as { tasks: unknown }).tasks).toEqual([]));
  expect(vi.mocked(apiFetch).mock.calls.map(([path]) => path)).toEqual(['/api/tasks?threadId=other-thread&kind=work']);
  vi.mocked(apiFetch).mockClear();
  data = { ...data, threadId: 'next-thread' };
  await act(commit);
  await waitFor(() =>
    expect(vi.mocked(apiFetch).mock.calls.map(([path]) => path)).toEqual(['/api/tasks?threadId=next-thread&kind=work']),
  );
  vi.mocked(apiFetch).mockClear();
  readGeneration++;
  await act(commit);
  await waitFor(() =>
    expect(vi.mocked(apiFetch).mock.calls.map(([path]) => path)).toEqual(['/api/tasks?threadId=next-thread&kind=work']),
  );
  await act(commit);
  expect(apiFetch).toHaveBeenCalledTimes(1);
});

it('does not publish stable owner data again on a parent render or a viewport-only store update', async () => {
  vi.mocked(apiFetch).mockClear();
  const data = fixtureData(),
    ui = fixtureUi();
  const workspace = {
    worktreeId: null,
    worktrees: [],
    tree: [],
    file: null,
    loading: false,
    error: null,
  } as unknown as ReturnType<typeof useWorkspace>;
  const changed = vi.fn();
  let commit!: () => void;
  renderHook(
    () => {
      const [, refresh] = useState(0);
      commit = () => refresh((n) => n + 1);
    },
    () => (
      <ProjectDataBinding
        data={data}
        workspace={workspace}
        fields={ui.f}
        target={() => 'codex'}
        ui={ui}
        changed={changed}
      />
    ),
  );
  await act(async () => {});
  changed.mockClear();
  await act(commit);
  await act(() => useChatStore.getState().setWorkspaceViewport(120));
  expect(changed).not.toHaveBeenCalled();
  expect(apiFetch).not.toHaveBeenCalled();
});

it.each(['unlisted', 'nogit'])('does not issue Git reads for a %s worktree', async (kind) => {
  vi.mocked(apiFetch).mockClear();
  const workspace = {
    worktreeId: 'wt',
    worktrees: kind === 'nogit' ? [{ id: 'wt', root: '/project', head: 'nogit', branch: 'exported' }] : [],
    tree: [],
    file: null,
    loading: false,
    error: null,
  } as unknown as ReturnType<typeof useWorkspace>;
  renderHook(() =>
    useWorkbenchBindings(fixtureData(), workspace, { git: true, native: false, execution: false, recall: false }),
  );
  await act(async () => {});
  expect(apiFetch).not.toHaveBeenCalled();
});

it('reads the requested memory family only, and leaves an unavailable taste read idle until requested again', async () => {
  const calls: string[] = [];
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    calls.push(String(path));
    if (String(path).startsWith('/api/memory/people'))
      return Response.json({ entries: [], meta: { hasMore: false }, readStatus: 'ready' });
    if (String(path).startsWith('/api/memory/taste'))
      return Response.json({ error: 'taste_repo_not_configured' }, { status: 503 });
    throw new Error('Unexpected memory source ' + path);
  });
  let source = 'reads.person';
  const hook = renderHook(() => useMemoryBindings((name) => name === source));
  await waitFor(() => expect(hook.result.current.data.reads.person.loading).toBe(false));
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain('/api/memory/people');
  source = 'reads.taste';
  await act(hook.rerender);
  await waitFor(() => expect(hook.result.current.data.reads.taste.error).toBe(true));
  const reads = calls.length;
  await act(hook.rerender);
  await act(() => hook.result.current.action('memoryBrowse', {}));
  expect(calls).toHaveLength(reads);
  source = '';
  await act(hook.rerender);
  source = 'reads.taste';
  await act(hook.rerender);
  await waitFor(() => expect(calls.filter((path) => path.startsWith('/api/memory/taste'))).toHaveLength(2));
});

it('retains unchanged execution records from a full HTTP receipt, changing only the matching id', () => {
  const store = useActiveExecutionStore.getState();
  store.reset();
  const execution = {
    executionId: 'run-a',
    threadId: 'owner',
    threadTitle: 'Thread',
    catId: 'codex',
    kind: 'live_invocation' as const,
    startedAt: 1,
    cancelability: {
      state: 'cancelable' as const,
      target: { kind: 'live_invocation' as const, executionId: 'run-a', threadId: 'owner', catId: 'codex' },
    },
  };
  const sibling = {
    ...execution,
    executionId: 'run-b',
    cancelability: { ...execution.cancelability, target: { ...execution.cancelability.target, executionId: 'run-b' } },
  };
  const push = (executions: ActiveExecutionProjection[]) => {
    const revision = store.beginHydration('owner', null);
    store.applySnapshot('owner', revision, { scope: 'all', executions, unavailableProjectPaths: [] });
  };
  push([execution, sibling]);
  const first = useActiveExecutionStore.getState();
  push(structuredClone([execution, sibling]));
  expect(useActiveExecutionStore.getState().executionsByKey).toBe(first.executionsByKey);
  expect(useActiveExecutionStore.getState().unavailableProjectPaths).toBe(first.unavailableProjectPaths);
  push([{ ...execution, threadTitle: 'Updated' }, sibling]);
  const next = useActiveExecutionStore.getState().executionsByKey;
  expect(next[activeExecutionKey(sibling)]).toBe(first.executionsByKey[activeExecutionKey(sibling)]);
  expect(next[activeExecutionKey(execution)]).not.toBe(first.executionsByKey[activeExecutionKey(execution)]);
  store.reset();
});
