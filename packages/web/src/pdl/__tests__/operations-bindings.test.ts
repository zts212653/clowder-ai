import type { BacklogItem, EntrustedWorkOwnerReadV1 } from '@cat-cafe/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EvalHubSummary } from '@/components/HubEvalTypes';
import {
  cancelHoldWait,
  cancelProjectedExecution,
  refreshActiveExecutionProjection,
} from '@/hooks/useActiveExecutionProjection';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useMissionControlStore } from '@/stores/missionControlStore';
import { apiFetch } from '@/utils/api-client';
import { useBoardBindings } from '../useBoardBindings';
import { useEvaluationBindings } from '../useEvaluationBindings';
import { useHomeBindings } from '../useHomeBindings';
import { useScheduleBindings } from '../useScheduleBindings';
import { fixtureData } from './chat-fixture';
import { act, cleanup, renderHook, waitFor } from './hook-host';
import { projectOwner, useOwnerProjection } from './owner-console';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'https://api.test' }));
vi.mock('@/hooks/useActiveExecutionProjection', () => ({
  cancelProjectedExecution: vi.fn(),
  cancelHoldWait: vi.fn().mockResolvedValue(true),
  refreshActiveExecutionProjection: vi.fn().mockResolvedValue(undefined),
}));
const projection = vi.hoisted(() => ({
  ownerReads: [] as EntrustedWorkOwnerReadV1[],
  loading: false,
  error: false,
  partial: false,
  confirmed: true,
}));
vi.mock('@/hooks/useEntrustedWorkProjection', () => ({ useEntrustedWorkProjection: () => projection }));
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let backlog: BacklogItem[], writes: { path: string; body: Record<string, unknown> }[], rejectWrite: boolean;
let summary: EvalHubSummary;
let managedExitCode: number | null | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  window.clowderChat = { dataOk: vi.fn(), dataError: vi.fn() } as unknown as typeof window.clowderChat;
  vi.mocked(refreshActiveExecutionProjection).mockReset().mockResolvedValue(undefined);
  rejectWrite = false;
  managedExitCode = undefined;
  writes = [];
  useMissionControlStore.getState().setItems([]);
  useActiveExecutionStore.setState({ hydration: 'ready', unavailableProjectPaths: [], waits: [] });
  backlog = [
    {
      id: 'owner-item',
      title: '[F901] Real feature',
      summary: 'Owner summary',
      priority: 'p1',
      tags: ['feature:f901'],
      status: 'suggested',
      createdBy: 'user',
      createdAt: 1,
      updatedAt: 2,
      audit: [],
      suggestion: {
        catId: 'codex',
        why: 'why',
        plan: 'plan',
        requestedPhase: 'research',
        status: 'pending',
        suggestedAt: 2,
      },
    },
  ] as unknown as BacklogItem[];
  summary = {
    repoProjectPath: '/eval-owner',
    repoWorktreeId: 'eval-wt',
    counts: { total: 1, actionable: 1, keepObserve: 0, stale: 1 },
    domains: [
      {
        domainId: 'eval:test',
        displayName: 'Owner eval',
        systemThreadId: 'system-eval',
        frequency: 'daily',
        evalCatId: 'codex',
        evalCatHandle: '@codex',
        enabled: true,
        hasVerdict: true,
        latestVerdictId: 'verdict',
        latestVerdict: 'fix',
      },
    ],
    items: [
      {
        id: 'verdict',
        domainId: 'eval:test',
        verdict: 'fix',
        operatorNarrative: {
          headline: 'Owner headline',
          summary: 'Owner finding',
          action: 'Repair',
          nextCheck: 'Recheck',
        },
        reeval: { status: 'pending_owner' },
        lifecycle: { closureStatus: 'open', ownerResponseStatus: 'not_started', stale: false },
        source: { verdictPath: 'custom/verdict.md', bundleDir: 'custom/packet' },
      },
    ],
  } as EvalHubSummary;
  vi.mocked(apiFetch).mockImplementation(async (raw, init) => {
    const path = String(raw),
      url = new URL(path, 'https://api.test'),
      method = init?.method ?? 'GET';
    if (method !== 'GET') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      writes.push({ path: url.pathname, body });
      if (rejectWrite) return response({ error: 'owner_conflict' }, 409);
      if (url.pathname === '/api/paw-feel/duty')
        return response({ config: { systemThreadId: 'thread_eval_friction', version: 5, ...body } });
      if (url.pathname.endsWith('/decide-claim'))
        backlog = [{ ...backlog[0], status: 'dispatched', dispatchedThreadId: 'dispatched-owner' }];
      return response({ ok: true });
    }
    if (url.pathname === '/api/external-projects') return response({ projects: [] });
    if (url.pathname === '/api/runtime-deployment/waits')
      return response({
        scope: 'all',
        projectPath: null,
        items: [
          {
            taskId: 'wait',
            threadId: 'other',
            taskTitle: 'Deploy actual revision',
            createdAt: 1,
            matchedAt: 10,
            ownerCatId: 'codex',
            condition: { kind: 'revision_included', revision: 'abcdef123', services: ['api'] },
            state: 'ready_to_return',
            nextStep: 'Resume owner work',
          },
        ],
        candidate: null,
      });
    if (url.pathname.includes('/hold-ball/'))
      return response({
        taskId: 'managed',
        catId: 'codex',
        access: { lifecycleVisibility: 'full' },
        cancelable: true,
        job: {
          originTaskId: 'managed',
          createdAt: 1,
          state: 'running',
          command: 'pnpm test -- actual',
          tail: 'native output',
          result: managedExitCode === undefined ? undefined : { exitCode: managedExitCode, durationMs: 0 },
          transitions: [{ revision: 3, state: 'running', at: 5 }],
        },
      });
    if (url.pathname === '/api/backlog/items') return response({ items: backlog });
    if (url.pathname === '/api/threads')
      return response({
        threads: [
          {
            id: 'owner-thread',
            title: 'F901 actual',
            participants: ['codex'],
            lastActiveAt: 3,
            backlogItemId: 'owner-item',
          },
        ],
      });
    if (url.pathname === '/api/backlog/feature-doc-detail')
      return response({
        featureId: 'F901',
        dependencies: { blockedBy: ['F902'] },
        phases: [{ id: 'p1', name: 'Real phase', acs: [{ id: 'ac', text: 'Actual AC', done: true }] }],
      });
    if (url.pathname.endsWith('/workflow-sop')) return response({ error: 'not_found' }, 404);
    if (url.pathname === '/api/eval-hub/summary') return response(summary);
    if (url.pathname === '/api/eval-hub/available-cats')
      return response({
        cats: [
          { catId: 'codex', handle: '@codex', family: 'openai' },
          { catId: 'backup', handle: '@backup', family: 'other' },
        ],
      });
    if (url.pathname === '/api/paw-feel/duty')
      return response({
        config: { systemThreadId: 'thread_eval_friction', version: 4, primaryCatId: 'codex', backupCatId: 'backup' },
      });
    if (url.pathname === '/api/paw-feel/inbox')
      return response({
        projectionStatus: 'available',
        degraded: false,
        items: [],
        bundles: [],
        counts: {},
        issueCounts: {},
        bundleCounts: { total: 0 },
        denominator: {},
      });
    throw new Error('Unexpected operation owner ' + path);
  });
});
afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('force resets the requested thread and refreshes the execution owner only after acknowledgement', async () => {
  const state = { execDetail: 'managed' as string | null };
  const { result } = renderHook(() => useHomeBindings(fixtureData(), state, true));
  rejectWrite = true;
  await act(async () => {
    await expect(result.current.action('opForceReset', { threadId: 'owner/thread' })).rejects.toThrow('owner_conflict');
  });
  expect(state.execDetail).toBe('managed');
  expect(refreshActiveExecutionProjection).not.toHaveBeenCalled();
  rejectWrite = false;
  await act(() => result.current.action('opForceReset', { threadId: 'owner/thread' }));
  expect(state.execDetail).toBeNull();
  expect(refreshActiveExecutionProjection).toHaveBeenCalledOnce();
  expect(writes.at(-1)).toEqual({ path: '/api/threads/owner%2Fthread/force-reset', body: {} });
});
it('projects held-ball waits separately and cancels the original owner wait', async () => {
  const wait = {
    waitId: 'held-task',
    threadId: 'other-thread',
    threadTitle: 'Held work',
    catId: 'codex',
    since: 10,
    wakeAt: 20,
    cancelability: { state: 'cancelable' as const, target: { kind: 'hold_ball' as const, taskId: 'held-task' } },
  };
  useActiveExecutionStore.setState({ waits: [wait] });
  const data = fixtureData(),
    ui = { execDetail: null },
    hook = renderHook(() => useOwnerProjection('home', useHomeBindings(data, ui, true), { data, ws: ui }));
  const row = hook.result.current
    .project()
    .live.waits.items.find((item: { kind: string }) => item.kind === 'hold_ball');
  expect(row).toMatchObject({
    key: 'held-task',
    since: 10,
    wakeAt: 20,
    owner: 'codex',
    actions: { thread: 'other-thread', waitId: 'held-task', cancelable: true },
  });
  await act(() => hook.result.current.action('cancelHoldWait', { waitId: 'held-task' }));
  expect(cancelHoldWait).toHaveBeenCalledWith(wait);
});

it.each([
  undefined,
  null,
  0,
])('uses the shared live execution identities and the real command result (%s)', async (exitCode) => {
  managedExitCode = exitCode;
  const data = fixtureData();
  data.executions = [
    {
      executionId: 'managed',
      threadId: 'other',
      threadTitle: 'Other owner',
      catId: 'codex',
      kind: 'managed_command',
      startedAt: 1,
      cancelability: { state: 'cancelable', target: { kind: 'managed_command', taskId: 'managed' } },
    },
  ];
  const ui = { execDetail: null as string | null },
    hook = renderHook(() => useOwnerProjection('home', useHomeBindings(data, ui, true), { data, ws: ui }));
  await waitFor(() => expect(hook.result.current.project().live.load).toBe(''));
  expect(hook.result.current.project().live.runs[0]).toMatchObject({
    key: 'managed',
    command: true,
    actions: { thread: 'other' },
  });
  expect(hook.result.current.project().live.waits.items[0]).toMatchObject({
    key: 'wait',
    revision: 'abcdef123',
    nextStep: 'Resume owner work',
  });
  await act(() => hook.result.current.action('homeExecOpen', { k: 'managed' }));
  expect(hook.result.current.project().live.execDetail).toBe(true);
  await waitFor(() =>
    expect(hook.result.current.project().execDetail).toMatchObject({
      command: 'pnpm test -- actual',
      tail: 'native output',
    }),
  );
  expect(hook.result.current.project().execDetail).toMatchObject({
    exitCode,
    elapsed: exitCode === undefined ? expect.any(Number) : 0,
  });
  await act(() => hook.result.current.action('opLiveStop', { k: 'managed' }));
  expect(cancelProjectedExecution).toHaveBeenCalledWith(data.executions[0]);
  await act(() => useActiveExecutionStore.setState({ hydration: 'error' }));
  expect(hook.result.current.project().live.load).toBe('error');
  await act(() => useActiveExecutionStore.setState({ hydration: 'ready', unavailableProjectPaths: ['/project'] }));
  expect(hook.result.current.project().live.load).toBe('stale');
});

it.each(['home', 'live'])('retries %s through the existing execution and deployment owners', async (key) => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  const reads: string[] = [];
  vi.mocked(apiFetch).mockImplementation((path, init, options) => {
    reads.push(String(path));
    return original(path, init, options);
  });
  useActiveExecutionStore.setState({ projectPath: '/canonical-project' });
  const data = fixtureData();
  const ui = { execDetail: null };
  const { result } = renderHook(() => useOwnerProjection('home', useHomeBindings(data, ui, true), { data, ws: ui }));
  await waitFor(() => expect(result.current.project().live.load).toBe(''));
  const before = reads.filter((p) => p === '/api/runtime-deployment/waits?scope=all').length;
  await act(() => useActiveExecutionStore.setState({ hydration: 'error' }));
  vi.mocked(refreshActiveExecutionProjection).mockImplementationOnce(async () => {
    useActiveExecutionStore.setState({ hydration: 'ready' });
  });
  await act(() => result.current.action('refresh', { k: key }));
  expect(refreshActiveExecutionProjection).toHaveBeenCalledWith(data.threadId, '/canonical-project');
  expect(reads.filter((p) => p === '/api/runtime-deployment/waits?scope=all')).toHaveLength(before + 1);
  expect(result.current.project().live.load).toBe('');
});

it('projects board phases, canonical suggestions and guarded owner receipts rather than demo transitions', async () => {
  const data = fixtureData();
  const ui = { boardV: 'list', hbItem: 'owner-item', hbView: 'sug', depScope: 'all', node: '', zoom: 1, pan: [0, 0] },
    hook = renderHook(
      () => useOwnerProjection('board', useBoardBindings(data, ui, true, ['F901']), { data, ws: ui }),
      (value) => value.ownerView,
    );
  await waitFor(() => expect(hook.result.current.project().hubPanel.load).toBe(''));
  await waitFor(() => expect(hook.result.current.project().hubPanel.feats[0].phases).toHaveLength(1));
  const feature = hook.result.current.project().hubPanel.feats[0];
  expect(feature.phases).toEqual([{ label: 'Real phase', pct: 100, hasPct: true, criteria: ['Actual AC'] }]);
  expect(feature.sel).toMatchObject({ k: 'owner-item', canApprove: true });
  rejectWrite = true;
  await act(async () => {
    await expect(hook.result.current.action('hbApprove', { k: 'owner-item' })).rejects.toThrow('owner_conflict');
  });
  expect(hook.result.current.project().boardItems[0].status).toBe('suggested');
  rejectWrite = false;
  await act(() => hook.result.current.action('hbApprove', { k: 'owner-item' }));
  await waitFor(() => expect(hook.result.current.project().boardItems[0].dispatchedThreadId).toBe('dispatched-owner'));
  expect(writes.at(-1)).toEqual({
    path: '/api/backlog/items/owner-item/decide-claim',
    body: { decision: 'approve', threadPhase: 'research' },
  });
  ui.hbView = 'sop';
  await act(() => hook.result.current.action('boardSelect', {}));
  await waitFor(() => expect(hook.result.current.project().hubPanel.load).toBe(''));
  expect(hook.result.current.project().hubPanel.feats[0].sel?.sop).toBeNull();
});

it.each([
  ['trigger', 'trigger-now'],
  ['generate', 'generate-now'],
])('runs the real eval %s command and reloads its summary only after acknowledgement', async (op, endpoint) => {
  const { result } = renderHook(() => useEvaluationBindings(fixtureData(), true));
  await waitFor(() =>
    expect(
      projectOwner('evaluation', result.current, { evalView: 'events', pawF: 'active' }, fixtureData(), undefined).eval
        .load,
    ).toBe(''),
  );
  const base = vi.mocked(apiFetch).getMockImplementation()!;
  let acknowledge!: () => void;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (String(path).endsWith(endpoint) && !rejectWrite)
      await new Promise<void>((resolve) => {
        acknowledge = resolve;
      });
    return base(path, init);
  });
  summary = {
    ...summary,
    items: summary.items.map((item) => ({
      ...item,
      operatorNarrative: { ...item.operatorNarrative, headline: 'Fresh owner result' },
    })),
  };
  let pending!: Promise<boolean>;
  await act(() => {
    pending = result.current.action('opEvalRun', { k: 'eval:test', op });
  });
  expect(
    projectOwner('evaluation', result.current, { evalView: 'events', pawF: 'active' }, fixtureData(), undefined).eval
      .act?.[0].title,
  ).toBe('Owner headline');
  await act(async () => {
    acknowledge();
    await pending;
  });
  expect(writes.at(-1)).toEqual({ path: `/api/eval-domains/eval%3Atest/${endpoint}`, body: {} });
  expect(
    projectOwner('evaluation', result.current, { evalView: 'events', pawF: 'active' }, fixtureData(), undefined).eval
      .act?.[0].title,
  ).toBe('Fresh owner result');
  rejectWrite = true;
  const reads = vi.mocked(apiFetch).mock.calls.filter(([p]) => String(p) === '/api/eval-hub/summary').length;
  await act(async () => {
    await expect(result.current.action('opEvalRun', { k: 'eval:test', op })).rejects.toThrow('owner_conflict');
  });
  expect(vi.mocked(apiFetch).mock.calls.filter(([p]) => String(p) === '/api/eval-hub/summary')).toHaveLength(reads);
});

it('uses the existing eval derivation and actual source files and preserves the duty owner version on conflict', async () => {
  const ui = { evalView: 'events', pawF: 'active' },
    hook = renderHook(() => useEvaluationBindings(fixtureData(), true));
  await waitFor(() =>
    expect(projectOwner('evaluation', hook.result.current, ui, fixtureData(), undefined).eval.load).toBe(''),
  );
  const model = projectOwner('evaluation', hook.result.current, ui, fixtureData(), undefined).eval;
  expect(model.act?.[0]).toMatchObject({
    title: 'Owner headline',
    files: { verdict: '/eval-owner/custom/verdict.md', snapshot: '/eval-owner/custom/packet/snapshot.json' },
  });
  rejectWrite = true;
  await act(async () => {
    await expect(hook.result.current.action('opDutySave', { field: 'backup', v: 'backup @backup' })).rejects.toThrow(
      'owner_conflict',
    );
  });
  expect(writes.at(-1)?.body).toEqual({ expectedVersion: 4, primaryCatId: 'codex', backupCatId: 'backup' });
  rejectWrite = false;
  await act(() => hook.result.current.action('opDutySave', { field: 'backup', v: 'backup @backup' }));
  await act(() => hook.result.current.action('opDutySave', { field: 'backup', v: 'backup @backup' }));
  expect(writes.at(-1)?.body.expectedVersion).toBe(5);
  expect(await hook.result.current.action('evalDomainEnabled', { k: 'eval:test' })).toBe(false);
});

it('deduplicates current Work identities and uses actual start/deadline dates, leaving wakeups out of the calendar', () => {
  const date = new Date(2026, 0, 31, 12).getTime();
  const read = (subjectRef: string, revision: number, freshness: string, timeRefs: unknown[]) =>
    ({
      envelope: { subjectRef, revision, freshness: { state: freshness } },
      brief: { current: { state: 'doing' }, outcome: { state: 'known', value: 'Work goal' } },
      timeRefs,
      work: {
        title: 'Actual work',
        ownerCatId: 'codex',
        threadId: 'work-thread',
        progress: { summary: 'Owner progress' },
      },
    }) as EntrustedWorkOwnerReadV1;
  projection.ownerReads = [
    read('work', 1, 'current', [{ role: 'business_deadline', value: date - 86400000 }]),
    read('work', 2, 'current', [
      { role: 'actual_start', value: date },
      { role: 'execution_trigger', value: date },
    ]),
    read('stale', 1, 'stale', [{ role: 'business_deadline', value: date }]),
    read('undated', 1, 'current', [{ role: 'execution_trigger', value: date }]),
  ];
  projection.partial = true;
  const ws = { scheduleDate: date, scheduleMode: 'month' };
  const hook = renderHook(() => useOwnerProjection('schedule', useScheduleBindings(true), { ws })),
    model = hook.result.current.project().schedule;
  expect(model.calendar.marks).toEqual([{ at: date }]);
  expect(model.items.map((x: { id: string }) => x.id)).toEqual(['work']);
  expect(model.undated.map((x: { id: string }) => x.id)).toEqual(['undated']);
  expect(new Date(model.next).getDate()).toBe(28);
  expect(model.partial).not.toBe('');
});
