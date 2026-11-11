import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { useWorkspace } from '@/hooks/useWorkspace';
import { apiFetch } from '@/utils/api-client';
import { invalidateSidebarProjection } from '@/utils/sidebar-thread-snapshot';
import { request } from '../owner-api';
import { FirstMessageBinding } from '../PdlAppHost';
import { type ProjectBindings, ProjectDataBinding } from '../ProjectDataBinding';
import { fixtureData, fixtureUi } from './chat-fixture';
import { act, cleanup, renderHook, waitFor } from './hook-host';
import {
  createOwnerConsole,
  fixtureWorkbenchSource,
  fixtureWorkspace,
  ownerConsole,
  projectOwner,
} from './owner-console';

const owners = vi.hoisted(() => {
  const names = [
    'workbench',
    'terminal',
    'home',
    'recentWorks',
    'desktop',
    'sidebar',
    'general',
    'board',
    'schedule',
    'evaluation',
    'signals',
    'team',
    'ops',
    'preview',
    'replay',
    'evolution',
    'voice',
    'reviews',
    'memory',
    'trash',
    'film',
    'canon',
    'document',
  ];
  return Object.fromEntries(
    names.map((name) => [
      name,
      {
        models: vi.fn<() => Record<string, unknown>>(),
        action: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
        state: {},
        data: undefined as unknown,
        opened: null,
        reviewId: null,
      },
    ]),
  );
});
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/new-conversation/new-conversation-intent-store', () => ({
  loadNewConversationIntent: vi.fn(async () => null),
  saveNewConversationIntent: vi.fn(async () => {}),
  clearNewConversationIntent: vi.fn(async () => {}),
  getNewConversationIntentSaveState: vi.fn(() => 'idle'),
  subscribeNewConversationIntentSaveState: vi.fn(() => () => {}),
  canCancelNewConversationIntentSave: vi.fn(() => false),
  cancelNewConversationIntentSave: vi.fn(),
  retryNewConversationIntentSave: vi.fn(async () => {}),
}));
vi.mock('../useWorkbenchBindings', () => ({ useWorkbenchBindings: () => owners.workbench }));
vi.mock('../useTerminalBindings', () => ({ useTerminalBindings: () => owners.terminal }));
vi.mock('../useHomeBindings', () => ({ useHomeBindings: () => owners.home }));
vi.mock('../useRecentWorks', () => ({ useRecentWorks: () => owners.recentWorks }));
vi.mock('../useDesktopUpdateBindings', () => ({ useDesktopUpdateBindings: () => owners.desktop }));
vi.mock('../useSidebarBindings', () => ({ useSidebarBindings: () => owners.sidebar }));
vi.mock('../useGeneralBindings', () => ({ useGeneralBindings: () => owners.general }));
vi.mock('../useBoardBindings', () => ({ useBoardBindings: () => owners.board }));
vi.mock('../useScheduleBindings', () => ({ useScheduleBindings: () => owners.schedule }));
vi.mock('../useEvaluationBindings', () => ({ useEvaluationBindings: () => owners.evaluation }));
vi.mock('../useSignalBindings', () => ({ useSignalBindings: () => owners.signals }));
vi.mock('../useTeamBindings', () => ({ useTeamBindings: () => owners.team }));
vi.mock('../useOpsBindings', () => ({ useOpsBindings: () => owners.ops }));
vi.mock('../usePreviewBindings', () => ({ usePreviewBindings: () => owners.preview }));
vi.mock('../useReplayBindings', () => ({ useReplayBindings: () => owners.replay }));
vi.mock('../useEvolutionBindings', () => ({ useEvolutionBindings: () => owners.evolution }));
vi.mock('../useVoiceBindings', () => ({ useVoiceBindings: () => owners.voice }));
vi.mock('../useReviewBindings', () => ({ useReviewBindings: () => owners.reviews, ReviewOwnerBinding: () => null }));
vi.mock('../useMemoryBindings', () => ({ useMemoryBindings: () => owners.memory }));
vi.mock('../useTrashBindings', () => ({ useTrashBindings: () => owners.trash }));
vi.mock('@/utils/sidebar-thread-snapshot', () => ({ invalidateSidebarProjection: vi.fn(async () => true) }));
vi.mock('../useFilmBindings', () => ({ useFilmBindings: () => owners.film }));
vi.mock('../useCanonBindings', () => ({ useCanonBindings: () => owners.canon }));
vi.mock('../useDocumentBindings', () => ({
  useDocumentBindings: () => owners.document,
  DocumentOwnerBinding: () => null,
}));
let binding: ProjectBindings;
const engine = { dataError: vi.fn(), dataOk: vi.fn() };
beforeEach(() => {
  for (const owner of Object.values(owners)) {
    owner.models.mockReset().mockImplementation(() => {
      throw new Error('Owner models must never be read');
    });
    owner.action.mockReset().mockResolvedValue(false);
  }
  Object.assign(owners.reviews, { data: { global: { artifacts: [], loading: false, error: null } } });
  Object.assign(owners.sidebar, {
    data: { owner: null, classification: { phase: 'idle', error: '', newLabels: [], suggestions: [] }, attention: [] },
    error: null,
  });
  const source = fixtureWorkbenchSource();
  const workbench = { ...source, workspace: { ...source.workspace, worktreeId: 'owner' } };
  Object.assign(owners.workbench, { data: workbench, state: fixtureWorkspace() });
  Object.assign(owners.home, {
    data: {
      waits: {
        projection: { items: [{ taskId: 'healthy', taskTitle: 'Healthy owner data' }], candidate: null },
        hydration: 'ready',
      },
      hydration: 'ready',
      unavailable: [],
      selected: null,
      detail: { id: '', load: 'loading' },
    },
  });
  vi.mocked(apiFetch).mockReset();
  engine.dataError.mockClear();
  engine.dataOk.mockClear();
  Object.defineProperty(window, 'clowderChat', { configurable: true, value: engine });
  const data = fixtureData(),
    ui = fixtureUi();
  renderHook(
    () => null,
    () => (
      <ProjectDataBinding
        data={data}
        workspace={{ worktreeId: null } as ReturnType<typeof useWorkspace>}
        fields={{}}
        target={() => 'codex'}
        ui={ui}
        changed={(value) => {
          binding = value;
        }}
      />
    ),
  );
});
afterEach(cleanup);

it.each([
  ['document', 'documentQuoteResolve'],
  ['reviews', 'workSelectionPrepare'],
  ['reviews', 'workReviewDiscuss'],
])('returns the %s %s command receipt without reading any binding model', async (owner, name) => {
  const receipt = { source: { threadId: 'owner-thread', messageId: 'source' }, revision: 'owner-revision' };
  owners[owner].action.mockImplementation(async (command) => (command === name ? receipt : false));
  expect(await binding.action(name, {})).toBe(receipt);
  for (const value of Object.values(owners)) expect(value.models).not.toHaveBeenCalled();
});

it('hydrates the first-message admission once across 30 parent commits', async () => {
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path === '/api/session') return Response.json({ userId: 'synthetic-owner' });
    if (path === '/api/routing/preview') return Response.json({ targetCats: [], reason: { kind: 'default_cat' } });
    throw new Error('Unexpected request: ' + path);
  });
  let advance!: () => void;
  const changed = vi.fn();
  renderHook(
    () => {
      const [commit, setCommit] = useState(0);
      advance = () => setCommit((n) => n + 1);
      return commit;
    },
    () => <FirstMessageBinding content="" onChange={changed} />,
  );
  await waitFor(() => expect(changed.mock.lastCall?.[1].status).toBe('ready'));
  const notifications = changed.mock.calls.length;
  for (let i = 0; i < 30; i++) await act(advance);
  expect(changed).toHaveBeenCalledTimes(notifications);
  expect(vi.mocked(apiFetch).mock.calls.filter(([path]) => path === '/api/session')).toHaveLength(1);
  expect(changed.mock.lastCall?.[0].intent.projectPath).toBeUndefined();
});

const trashed = {
  ...fixtureData().threads[0],
  id: 'trash/id',
  title: 'Deleted owner thread',
  deletedAt: 1793664000000,
};
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

it('restores the exact deleted owner only after its receipt, then rereads trash and the canonical sidebar', async () => {
  const { useTrashBindings } = await vi.importActual<typeof import('../useTrashBindings')>('../useTrashBindings');
  let restored = false;
  let acknowledge!: (value: Response) => void;
  vi.mocked(invalidateSidebarProjection).mockClear();
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/threads?deleted=true') return response({ threads: restored ? [] : [trashed] });
    expect(path).toBe('/api/threads/trash%2Fid/restore');
    expect(init?.method).toBe('POST');
    return new Promise<Response>((resolve) => {
      acknowledge = resolve;
    });
  });
  const hook = renderHook(() => useTrashBindings(true));
  await waitFor(() =>
    expect(projectOwner('trash', hook.result.current, {}, undefined, undefined).cafeTrash.items).toHaveLength(1),
  );
  expect(projectOwner('trash', hook.result.current, {}, undefined, undefined).cafeTrash.items[0]).toMatchObject({
    id: trashed.id,
    title: trashed.title,
    ctx: { id: trashed.id },
  });
  let pending!: Promise<boolean>;
  await act(() => {
    pending = hook.result.current.action('trashRestore', { id: trashed.id });
  });
  expect(projectOwner('trash', hook.result.current, {}, undefined, undefined).cafeTrash.items).toHaveLength(1);
  expect(invalidateSidebarProjection).not.toHaveBeenCalled();
  await act(async () => {
    restored = true;
    acknowledge(response({ ...trashed, deletedAt: null }));
    await pending;
  });
  expect(projectOwner('trash', hook.result.current, {}, undefined, undefined).cafeTrash.items).toEqual([]);
  expect(invalidateSidebarProjection).toHaveBeenCalledOnce();
  expect(vi.mocked(apiFetch).mock.calls.filter(([path]) => path === '/api/threads?deleted=true')).toHaveLength(2);
});

it('retains the deleted owner when restore is rejected and never sends a purge or clear request', async () => {
  const { useTrashBindings } = await vi.importActual<typeof import('../useTrashBindings')>('../useTrashBindings');
  vi.mocked(invalidateSidebarProjection).mockClear();
  vi.mocked(apiFetch).mockImplementation(async (_path, init) =>
    init?.method === 'POST' ? response({ error: 'Thread is not deleted' }, 400) : response({ threads: [trashed] }),
  );
  const hook = renderHook(() => useTrashBindings(true));
  await waitFor(() =>
    expect(projectOwner('trash', hook.result.current, {}, undefined, undefined).cafeTrash.items).toHaveLength(1),
  );
  await act(async () => {
    await expect(hook.result.current.action('trashRestore', { id: trashed.id })).rejects.toThrow(
      'Thread is not deleted',
    );
  });
  expect(projectOwner('trash', hook.result.current, {}, undefined, undefined).cafeTrash.items[0].id).toBe(trashed.id);
  expect(invalidateSidebarProjection).not.toHaveBeenCalled();
  expect(vi.mocked(apiFetch).mock.calls.map(([path]) => path)).toEqual([
    '/api/threads?deleted=true',
    '/api/threads/trash%2Fid/restore',
  ]);
});

it('passes trash read errors and recovery through the existing per-binding data boundary', async () => {
  const { useTrashBindings } = await vi.importActual<typeof import('../useTrashBindings')>('../useTrashBindings');
  vi.mocked(apiFetch).mockResolvedValue(response({ error: 'Trash owner unavailable' }));
  const hook = renderHook(() => useTrashBindings(true));
  await waitFor(() => expect(hook.result.current.data.error).toMatchObject({ message: 'Trash owner unavailable' }));
  const console = ownerConsole();
  console.dataError = engine.dataError;
  console.dataOk = engine.dataOk;
  const read = () => {
    console.receiveProjectData({ trash: hook.result.current.data });
    return console.projectTrash();
  };
  read();
  expect(engine.dataError).toHaveBeenLastCalledWith('trash', expect.objectContaining({ name: 'PdlReadError' }));
  vi.mocked(apiFetch).mockResolvedValue(response({ threads: [] }));
  await act(() => hook.result.current.action('refresh', { k: 'trash' }));
  expect(read()).toHaveProperty('cafeTrash.items', []);
  expect(engine.dataOk).toHaveBeenCalledWith('trash');
});

it('attributes an API action failure to its raw owner and delegates notification to the held receiver', async () => {
  const console = createOwnerConsole();
  Object.assign(console.context, engine);
  const receive = () => console.push(binding.data);
  receive();
  owners.workbench.models.mockImplementation(() => {
    throw new Error('Workbench VM must read held source');
  });
  owners.home.models.mockImplementation(() => {
    throw new Error('Home VM must read held source');
  });
  owners.workbench.action.mockImplementation(async (name) => {
    if (name !== 'fileOpen' && name !== 'refresh') return false;
    await request('/api/owner');
    return true;
  });
  vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify({ error: 'Owner unavailable' })));
  const fail = () =>
    act(async () => {
      await expect(binding.action('fileOpen', {})).rejects.toMatchObject({ name: 'PdlReadError' });
    });
  await fail();
  expect(binding.data.readFailures).toHaveProperty('workbench', expect.objectContaining({ name: 'PdlReadError' }));
  expect(binding.data).toHaveProperty('home.waits.projection.items.0.taskTitle', 'Healthy owner data');
  receive();
  expect(engine.dataError).toHaveBeenLastCalledWith('workbench', expect.objectContaining({ name: 'PdlReadError' }));
  const notifications = engine.dataError.mock.calls.length;
  await fail();
  expect(receive()).toEqual(
    Object.fromEntries(
      Object.keys(binding.data).map((name) => [
        name,
        {
          added: [],
          changed: [],
          removed: [],
          orderChanged: false,
          fields: name === 'readFailures' ? ['readFailures.workbench'] : [],
        },
      ]),
    ),
  );
  expect(engine.dataError).toHaveBeenCalledTimes(notifications + 1);
  vi.mocked(apiFetch).mockImplementation(async () => new Response('{}'));
  await act(() => binding.action('refresh', {}));
  expect(binding.data.readFailures).not.toHaveProperty('workbench');
  expect(binding.data).toHaveProperty('workbench.workspace.worktreeId', 'owner');
  receive();
  expect(engine.dataOk).toHaveBeenCalledWith('workbench');
  vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify({ error: 'Owner unavailable' })));
  await fail();
  receive();
  expect(engine.dataError).toHaveBeenLastCalledWith('workbench', expect.objectContaining({ name: 'PdlReadError' }));
  expect(owners.workbench.models).not.toHaveBeenCalled();
  expect(owners.home.models).not.toHaveBeenCalled();
});

it('keeps an existing error/retry component on refresh failure and detects its later background recovery', async () => {
  const console = createOwnerConsole();
  Object.assign(console.context, engine);
  const read = () => {
    console.push(binding.data);
    return console.read("projectData('ops').read");
  };
  Object.assign(owners.ops, { data: { read: { load: '' } } });
  read();
  owners.ops.action.mockImplementation(async (name) => {
    if (name !== 'refresh') return false;
    try {
      await request('/api/owner');
      Object.assign(owners.ops, { data: { read: { load: '', title: 'Recovered owner' } } });
    } catch (error) {
      Object.assign(owners.ops, { data: { read: { load: 'error' } } });
      throw error;
    }
    return true;
  });
  vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify({ error: 'Owner unavailable' })));
  await act(async () => {
    await expect(binding.action('refresh', {})).rejects.toThrow('Owner unavailable');
  });
  expect(read()).toHaveProperty('load', 'error');
  expect(owners.ops.models).not.toHaveBeenCalled();
  expect(engine.dataError).not.toHaveBeenCalled();
  Object.assign(owners.ops, { data: { read: { load: 'loading' } } });
  expect(read()).toHaveProperty('load', 'loading');
  Object.assign(owners.ops, { data: { read: { load: '', title: 'Recovered owner' } } });
  expect(read()).toHaveProperty('title', 'Recovered owner');
  expect(engine.dataError).not.toHaveBeenCalled();
  expect(engine.dataOk).toHaveBeenCalledWith('ops');
  expect(owners.ops.models).not.toHaveBeenCalled();
});
