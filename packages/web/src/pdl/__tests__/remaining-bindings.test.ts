import type { RoutingContextReadModelV1, SignalArticle, SignalSource } from '@cat-cafe/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { model as teamModel } from '@/components/routing-context/__tests__/team-panel-fixtures';
import { fetchThreadReplayEvents } from '@/lib/story-player/thread-replay-fetcher';
import type { RawTranscriptEvent } from '@/lib/story-player/types';
import { apiFetch } from '@/utils/api-client';
import { useOpsBindings } from '../useOpsBindings';
import { useReplayBindings } from '../useReplayBindings';
import { useSignalBindings } from '../useSignalBindings';
import { useTeamBindings } from '../useTeamBindings';
import { fixtureData, fixtureUi } from './chat-fixture';
import { act, cleanup, renderHook, waitFor } from './hook-host';
import { projectOwner, useOwnerProjection } from './owner-console';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'https://api.test' }));
vi.mock('@/lib/story-player/thread-replay-fetcher', () => ({ fetchThreadReplayEvents: vi.fn() }));
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(cleanup);
const signalUi = () => ({
  sigView: 'list',
  sigSt: 'inbox',
  sigTier: 'all',
  sigSrc: 'all',
  sigQ: '',
  sigSel: {} as Record<string, boolean>,
  tlDays: '7',
  fetchRes: '',
});
const opsUi = () => ({
  opsView: 'quota',
  obsV: 'overview',
  lbRange: 'all',
  toolCat: '',
  toolType: '',
  toolRange: 7,
  rpReview: false,
  rpArch: false,
});

it('writes real source booleans, preserves rejected owner state and merges selected article tags', async () => {
  const article: SignalArticle = {
    id: 'owner-article',
    title: 'Owner research',
    url: 'https://research.test/a',
    source: 'owner-source',
    tier: 1,
    status: 'inbox',
    publishedAt: '2026-11-03',
    fetchedAt: '2026-11-03',
    filePath: 'article.md',
    tags: ['owner-tag'],
  };
  let source: SignalSource = {
    id: 'owner-source',
    name: 'Owner source',
    url: 'https://research.test',
    tier: 1,
    category: 'research',
    enabled: true,
    fetch: { method: 'rss' },
    schedule: { frequency: 'daily' },
  };
  const writes: unknown[] = [];
  let rejected = true;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    const p = String(path);
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body));
      writes.push(body);
      if (p.endsWith('/sources/owner-source')) {
        if (rejected) return response({ error: 'Owner rejected' }, 409);
        source = { ...source, enabled: body.enabled };
        return response({ source });
      }
      return response({ article: { ...article, ...body } });
    }
    if (p === '/api/signals/sources') return response({ sources: [source] });
    if (p === '/api/signals/stats')
      return response({ todayCount: 2, weekCount: 7, unreadCount: 1, byTier: {}, bySource: {} });
    if (p.startsWith('/api/signals/inbox?')) return response({ items: [article] });
    throw new Error(p);
  });
  const ui = signalUi(),
    { result } = renderHook(() => useSignalBindings(ui, true));
  await waitFor(() =>
    expect(projectOwner('signals', result.current, ui, undefined, undefined).cafeWsSignals.load).toBe(''),
  );
  expect(JSON.stringify(projectOwner('signals', result.current, ui, undefined, undefined))).toContain('Owner research');
  const args = { id: source.id, enabled: false as unknown as string };
  await act(async () => {
    await expect(result.current.action('signalSourceStatus', args)).rejects.toThrow('Owner rejected');
  });
  expect(projectOwner('signals', result.current, ui, undefined, undefined).signalSources[0].enabled).toBe(true);
  rejected = false;
  await act(() => result.current.action('signalSourceStatus', args));
  expect(projectOwner('signals', result.current, ui, undefined, undefined).signalSources[0].enabled).toBe(false);
  expect(writes.slice(0, 2)).toEqual([{ enabled: false }, { enabled: false }]);
  ui.sigSel[article.id] = true;
  await act(() => result.current.action('signalBatchTag', { v: 'new-tag' }));
  expect(writes[2]).toEqual({ tags: ['owner-tag', 'new-tag'] });
  expect(ui.sigSel).toEqual({});
});

it('keeps the exact routing command on an ambiguous retry and exposes distinct recover/retract owner operations', async () => {
  const model: RoutingContextReadModelV1 = structuredClone(teamModel);
  model.signalEvents = [
    {
      v: 1,
      eventId: 'signal-owner',
      commandId: 'signal-command',
      ownerId: 'owner-1',
      subjectRef: { type: 'cat', catId: 'codex-sol' },
      reasonCode: 'budget',
      source: 'manual_cvo',
      observedAt: model.observedAt - 1000,
      evidenceRef: 'evidence:signal',
      eventType: 'asserted',
      state: 'scarce',
      validUntil: model.observedAt + 3600000,
    },
  ];
  let rejectRead = false;
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (init?.method === 'POST') {
      writes.push({ path: String(path), body: JSON.parse(String(init.body)) });
      return response({ ok: true });
    }
    return rejectRead ? response({ error: 'read owner unavailable' }, 503) : response(model);
  });
  const ui = { teamV: 'roster', teamSub: 'm:codex-sol', teamByThread: {} };
  const { result } = renderHook(() => useTeamBindings(true));
  await waitFor(() =>
    expect(projectOwner('team', result.current, ui, fixtureData(), undefined).cafeWsTeam.load).toBe(''),
  );
  const modelVm = projectOwner('team', result.current, ui, fixtureData(), undefined).cafeWsTeam;
  if (!('detail' in modelVm)) throw new Error('Expected member detail');
  const detail = modelVm.detail;
  expect(detail.m!.prof!.good[0]).toBe('复杂系统攻坚');
  expect(detail.signal.rows[0]).toMatchObject({ id: expect.any(String), state: 'scarce', expired: false });
  const args = {
    subject: 'cat:codex-sol',
    state: 'scarce',
    reason: 'budget',
    duration: '3600000',
    note: 'owner intent',
  };
  rejectRead = true;
  await act(async () => {
    await expect(result.current.action('routingSignalMark', args)).rejects.toThrow('尚未回读');
  });
  rejectRead = false;
  await act(() => result.current.action('routingSignalMark', args));
  expect(writes[0]).toEqual(writes[1]);
  await act(() => result.current.action('routingSignalClose', { id: 'signal-owner', op: 'recover' }));
  await act(() => result.current.action('routingSignalClose', { id: 'signal-owner', op: 'retract' }));
  expect(writes.slice(2).map((w) => w.path)).toEqual([
    '/api/routing-context/signals/signal-owner/recover',
    '/api/routing-context/signals/signal-owner/retract',
  ]);
});

it('reads a 503 degraded health body as owner data and keeps forbidden auth failures visible', async () => {
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    String(path) === '/api/telemetry/health'
      ? response(
          {
            status: 'degraded',
            uptime: 125,
            otelEnabled: true,
            errorRate: null,
            readiness: { status: 'degraded', checks: { redis: { ok: false, ms: 25, error: 'owner timeout' } } },
            traceStore: null,
            metricsSnapshotStore: null,
            timestamp: 1,
          },
          503,
        )
      : String(path) === '/api/system/status'
        ? response({ storageMode: 'redis', storage: { mode: 'redis', persistent: true, warning: null } })
        : response({ error: 'forbidden' }, 403),
  );
  const ui = { ...opsUi(), opsView: 'obs', obsV: 'health' },
    { result } = renderHook(() => useOpsBindings(fixtureData(), ui, true));
  await waitFor(() =>
    expect(projectOwner('ops', result.current, ui, fixtureData(), undefined).cafeWsOps.load).toBe(''),
  );
  const model = JSON.stringify(projectOwner('ops', result.current, ui, fixtureData(), undefined));
  expect(model).toContain('owner timeout');
  expect(projectOwner('ops', result.current, ui, fixtureData(), undefined).cafeWsOps.obs).toMatchObject({
    telemetryOff: false,
    stats: { otelEnabled: true },
  });
  ui.obsV = 'auth';
  await act(() => result.current.action('opsBrowse', {}));
  await waitFor(() =>
    expect(projectOwner('ops', result.current, ui, fixtureData(), undefined).cafeWsOps.load).toBe('error'),
  );
});

it('changes only the selected route constraint after its real thread owner acknowledges', async () => {
  let thread = {
    ...fixtureData().threads[0],
    routingPolicy: {
      v: 1,
      scopes: { review: { avoidCats: ['gemini'], reason: 'budget' }, architecture: { preferCats: ['codex'] } },
    },
  };
  let acknowledge!: () => void;
  const writes: Record<string, unknown>[] = [];
  const quota = {
    claude: { platform: 'claude', activeBlock: null, recentBlocks: [], lastChecked: null },
    codex: { platform: 'codex', usageItems: [], lastChecked: null },
    gemini: { platform: 'gemini', usageItems: [], lastChecked: null },
    kimi: { platform: 'kimi', usageItems: [], lastChecked: null },
    antigravity: { platform: 'antigravity', usageItems: [], lastChecked: null },
    fetchedAt: '2026-11-03T01:00:00Z',
  };
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    const p = String(path);
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body));
      writes.push(body);
      await new Promise<void>((r) => {
        acknowledge = r;
      });
      thread = { ...thread, ...body };
      return response(thread);
    }
    if (p === '/api/quota') return response(quota);
    if (p === '/api/accounts')
      return response({
        providers: [{ id: 'codex', displayName: 'Owner Codex', authType: 'oauth', clientId: 'openai' }],
      });
    if (p.startsWith('/api/threads/')) return response(thread);
    if (p.startsWith('/api/usage/daily'))
      return response({
        daily: [],
        grandTotal: { inputTokens: 9, outputTokens: 6, cacheReadTokens: 3, costUsd: 0.5, invocations: 2 },
      });
    if (p.startsWith('/api/usage/tools'))
      return response({
        summary: { totalCalls: 0, byCategory: { native: 0, mcp: 0, skill: 0 } },
        topTools: [],
        daily: [],
        byCat: {},
      });
    throw new Error(p);
  });
  const ui = opsUi(),
    { result } = renderHook(() => useOpsBindings(fixtureData(), ui, true));
  await waitFor(() =>
    expect(projectOwner('ops', result.current, ui, fixtureData(), undefined).cafeWsOps.load).toBe(''),
  );
  let pending!: Promise<boolean>;
  await act(() => {
    pending = result.current.action('routingPolicySet', { field: 'rpReview', value: true as unknown as string });
  });
  expect(ui.rpReview).toBe(false);
  const ops = projectOwner('ops', result.current, ui, fixtureData(), undefined).cafeWsOps;
  if (!('quota' in ops)) throw new Error('Expected quota view');
  expect(ops.quota.writing).toBe(true);
  await act(async () => {
    acknowledge();
    await pending;
  });
  projectOwner('ops', result.current, ui, fixtureData(), undefined);
  expect(projectOwner('ops', result.current, ui, fixtureData(), undefined).cafeWsOps.quota.review).toBe(true);
  expect(writes[0]).toEqual({
    routingPolicy: {
      v: 1,
      scopes: { review: { avoidCats: ['gemini', 'opus'], reason: 'budget' }, architecture: { preferCats: ['codex'] } },
    },
  });
});

it('replays the existing transcript bridge through the same message VM and ignores a late previous thread', async () => {
  let finishOld!: (events: RawTranscriptEvent[]) => void;
  vi.mocked(fetchThreadReplayEvents).mockImplementation((id) =>
    id === 'old-thread'
      ? new Promise((r) => {
          finishOld = r;
        })
      : Promise.resolve([
          {
            v: 1,
            t: 1000,
            threadId: id,
            catId: 'codex',
            sessionId: 'owner-session',
            cliSessionId: 'cli-owner',
            eventNo: 0,
            event: { type: 'user', content: 'Owner question' },
          },
          {
            v: 1,
            t: 2000,
            threadId: id,
            catId: 'codex',
            sessionId: 'owner-session',
            cliSessionId: 'cli-owner',
            eventNo: 1,
            event: { type: 'assistant', content: 'Owner answer' },
          },
        ]),
  );
  const data = fixtureData(),
    ui = fixtureUi();
  const { result } = renderHook(() => useOwnerProjection('replay', useReplayBindings(undefined, true), { data, ui }));
  await act(() => result.current.action('replayOpen', { id: 'old-thread' }));
  await act(() => result.current.action('replayOpen', { id: 'pdl-test' }));
  await waitFor(() => expect(result.current.project().theater.load).toBe(''));
  await act(() => result.current.action('rpSeek', { v: '1' }));
  expect(JSON.stringify(result.current.project().theater.items)).toContain('Owner answer');
  await act(async () => {
    finishOld([]);
    await Promise.resolve();
  });
  expect(JSON.stringify(result.current.project().theater.items)).toContain('Owner answer');
  expect(apiFetch).not.toHaveBeenCalled();
});
it('writes story narration at the original event time and projects acknowledged annotations from held data', async () => {
  const raw = [
    { t: 1000, event: { type: 'user', content: 'Question' } },
    { t: 2000, event: { type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'pwd' } } },
    { t: 62000, event: { type: 'assistant', content: 'Answer' } },
  ].map((event, eventNo) => ({
    v: 1,
    threadId: 'pdl-test',
    catId: 'codex',
    sessionId: 'session',
    cliSessionId: 'cli',
    eventNo,
    ...event,
  })) as RawTranscriptEvent[];
  vi.mocked(fetchThreadReplayEvents).mockResolvedValue(raw);
  let reject = true;
  const set = { storyId: 'feat:F900', annotations: [] as { id: string; content: string; at: number }[], version: 0 };
  const writes: unknown[] = [];
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    expect(path).toBe('/api/story/feat%3AF900/annotations');
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      writes.push(body);
      if (reject) return response({ error: 'story_refused' }, 409);
      set.annotations.push({ id: 'annotation', ...body });
      set.version++;
      return response(set.annotations[0]);
    }
    return response(set);
  });
  const data = fixtureData();
  const { result } = renderHook(() => useOwnerProjection('replay', useReplayBindings(undefined, true), { data }));
  await act(() => result.current.action('replayOpen', { id: 'pdl-test', storyId: 'feat:F900' }));
  await waitFor(() => expect(result.current.project().theater.load).toBe(''));
  await waitFor(() => expect(result.current.data.annotations.value?.version).toBe(0));
  await act(() => result.current.action('rpSeek', { v: '2' }));
  expect(result.current.data.events[2].timestamp).toBeLessThan(62000);
  expect(result.current.project().theater.rp.annotation.at).toBe(62000);
  await act(async () => {
    await expect(
      result.current.action('rpAnnotate', { storyId: 'feat:F900', at: '62000', v: '  Narration  ' }),
    ).rejects.toThrow('story_refused');
  });
  expect(result.current.project().theater.rp.annotation).toMatchObject({ error: 'story_refused', items: [] });
  reject = false;
  await act(() => result.current.action('rpAnnotate', { storyId: 'feat:F900', at: '62000', v: '  Narration  ' }));
  expect(result.current.project().theater.rp.annotation.items[0]).toMatchObject({
    id: 'annotation',
    title: 'Narration',
    at: 62000,
  });
  expect(writes.at(-1)).toEqual({ at: 62000, kind: 'narration', content: 'Narration' });
  const calls = vi.mocked(apiFetch).mock.calls.length;
  for (let i = 0; i < 30; i++) result.current.project();
  expect(vi.mocked(apiFetch).mock.calls).toHaveLength(calls);
  expect(await result.current.action('rpAnnotate', { storyId: 'feat:F900', at: '62000', v: '  ' })).toBe(false);
  expect(vi.mocked(apiFetch).mock.calls).toHaveLength(calls);
});
it('retries an unavailable replay using its opened owner thread', async () => {
  vi.mocked(fetchThreadReplayEvents).mockRejectedValueOnce(new Error('Owner unavailable')).mockResolvedValueOnce([]);
  const data = fixtureData(),
    ui = fixtureUi();
  const { result } = renderHook(() => useOwnerProjection('replay', useReplayBindings(undefined, true), { data, ui }));
  await act(() => result.current.action('replayOpen', { id: 'foreign-thread' }));
  await waitFor(() => expect(result.current.project().theater.load).toBe('error'));
  await act(() => result.current.action('refresh', { k: 'replay' }));
  await waitFor(() => expect(result.current.project().theater.load).toBe(''));
  expect(fetchThreadReplayEvents).toHaveBeenNthCalledWith(2, 'foreign-thread');
  expect(result.current.project().theater.empty).toBe(true);
});
