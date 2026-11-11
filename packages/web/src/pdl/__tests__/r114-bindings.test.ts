import type { StudyMeta } from '@cat-cafe/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { useOpsBindings } from '../useOpsBindings';
import { useSignalBindings } from '../useSignalBindings';
import { fixtureData } from './chat-fixture';
import { act, cleanup, renderHook, waitFor } from './hook-host';
import { projectOwner } from './owner-console';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'https://api.test' }));
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(cleanup);

it('reads real study reports, preserves existing tags and collection members, and drops an absent report', async () => {
  let article = {
    id: 'article-owner',
    title: 'Owner article',
    url: 'https://owner.test/a',
    source: 'owner-source',
    tier: 1,
    status: 'inbox',
    publishedAt: '2026-11-03',
    fetchedAt: '2026-11-03',
    filePath: 'article.md',
    tags: ['owner-tag'],
    content: 'Owner full body',
  };
  let meta: StudyMeta = {
    articleId: article.id,
    artifacts: [
      {
        id: 'owner-report',
        kind: 'research-report',
        state: 'ready',
        createdAt: '2026-11-03T01:00:00Z',
        createdBy: 'owner',
        filePath: 'report.md',
        metadata: { title: 'Owner research finding' },
      },
    ],
    collections: [],
    threads: [],
  };
  let collection = {
    id: 'collection-owner',
    name: 'Owner collection',
    articleIds: ['another-article'],
    createdAt: '2026-11-03',
    updatedAt: '2026-11-03',
  };
  const writes: unknown[] = [];
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    const p = String(path);
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body));
      writes.push(body);
      if (p.includes('/collections/')) {
        collection = { ...collection, ...body };
        return response({ collection });
      }
      article = { ...article, ...body };
      return response({ article });
    }
    if (p === '/api/signals/collections') return response({ collections: [collection] });
    if (p.endsWith('/study')) return response({ meta });
    if (p === '/api/signals/sources') return response({ sources: [] });
    if (p === '/api/signals/stats') return response({ todayCount: 1, weekCount: 1, unreadCount: 1 });
    if (p.includes('/inbox?')) return response({ items: [article] });
    if (p.endsWith('/articles/article-owner')) return response({ article });
    throw new Error(p);
  });
  const ui = {
    sigView: 'list',
    sigSt: 'inbox',
    sigTier: 'all',
    sigSrc: 'all',
    sigQ: '',
    sigSel: {},
    tlDays: '7',
    fetchRes: '',
    sigDetail: null as string | null,
    pod: 0,
  };
  const { result } = renderHook(() => useSignalBindings(ui, true));
  await act(() => result.current.action('signalOpen', { id: article.id }));
  const read = () => {
    const vm = projectOwner('signals', result.current, ui, undefined, undefined).cafeWsSignals;
    if (!('detail' in vm) || !vm.detail) throw new Error('Expected article');
    return vm.detail;
  };
  expect(read().reports).toEqual([
    { id: 'owner-report', title: 'Owner research finding', state: 'ready', at: '2026-11-03T01:00:00Z' },
  ]);
  expect(read().body).toBe('Owner full body');
  await act(() => result.current.action('signalTag', { k: article.id, v: 'added' }));
  await act(() => result.current.action('signalCollection', { k: article.id, v: collection.id }));
  expect(writes).toEqual([{ tags: ['owner-tag', 'added'] }, { articleIds: ['another-article', 'article-owner'] }]);
  expect(read().sets).toEqual([{ chip: 'Owner collection' }]);
  meta = { ...meta, artifacts: [] };
  await act(() => result.current.action('signalOpen', { id: article.id }));
  expect(read().reports).toEqual([]);
});

it('uses health for telemetry visibility and owner config for exact hot-update writes', async () => {
  let enabled = false,
    value = 'off',
    hasMetrics = true;
  const writes: unknown[] = [];
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    const p = String(path);
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body));
      writes.push(body);
      value = body.updates[0].value;
      enabled = true;
      return response({ ok: true });
    }
    if (p === '/api/telemetry/health')
      return response({
        status: 'healthy',
        uptime: 120,
        otelEnabled: enabled,
        disabledReason: 'Owner SDK stopped',
        errorRate: 0,
        traceStore: null,
        metricsSnapshotStore: null,
        timestamp: 1,
      });
    if (p === '/api/system/status')
      return response({ storageMode: 'redis', storage: { mode: 'redis', persistent: true, warning: null } });
    if (p === '/api/telemetry/traces') return response({ spans: [], count: 0 });
    if (p === '/api/config/env-summary')
      return response({
        variables: [
          {
            name: 'TELEMETRY_CAPTURE',
            category: 'telemetry',
            description: 'Owner capture',
            defaultValue: 'off',
            currentValue: value,
            sensitive: false,
            runtimeEditable: true,
            allowedValues: ['off', 'on'],
          },
          {
            name: 'OTEL_ENDPOINT',
            category: 'telemetry',
            currentValue: 'http://collector.test',
            sensitive: false,
            runtimeEditable: false,
          },
        ],
      });
    if (p.startsWith('/api/telemetry/metrics/history'))
      return response({
        snapshots: hasMetrics ? [{ timestamp: 1, metrics: { 'cat_cafe_invocation_completed{status="ok"}': 17 } }] : [],
      });
    throw new Error(p);
  });
  const ui = {
    opsView: 'obs',
    obsV: 'overview',
    lbRange: 'all',
    toolCat: '',
    toolType: '',
    toolRange: 7,
    rpReview: false,
    rpArch: false,
  };
  const { result } = renderHook(() => useOpsBindings(fixtureData(), ui, true));
  await waitFor(() =>
    expect(projectOwner('ops', result.current, ui, fixtureData(), undefined).cafeWsOps.load).toBe(''),
  );
  const read = () => {
    const vm = projectOwner('ops', result.current, ui, fixtureData(), undefined).cafeWsOps;
    if (!('obs' in vm) || !('stats' in vm.obs)) throw new Error('Expected observation stats');
    return vm.obs;
  };
  expect(read().telemetryOff).toBe(true);
  expect(read().cfg[0].name).toBe('OTEL_ENDPOINT');
  expect(read().stats.ok30m).toBe(17);
  await act(() => result.current.action('opsEnvSet', { name: 'TELEMETRY_CAPTURE', v: 'on' }));
  expect(writes).toEqual([{ updates: [{ name: 'TELEMETRY_CAPTURE', value: 'on' }] }]);
  expect(read().telemetryOff).toBe(false);
  expect(read().cfg[0].value).toBe('http://collector.test');
  hasMetrics = false;
  await act(() => result.current.action('refresh', { k: 'obs' }));
  expect(read().stats.ok30m).toBeUndefined();
});

it('projects external runtime owner records and attention state without a sample session', async () => {
  const owner = (id: string, state: string) => ({
    sessionId: id,
    runtime: 'antigravity-desktop',
    runtimeSessionId: id,
    threadId: 'owner-thread',
    title: 'Owner ' + id,
    catId: 'codex',
    lastObservedAt: 1000,
    lifecycle: { state, startedAt: 1, lastObservedAt: 1000 },
    binding: { mode: 'thread', threadId: 'owner-thread' },
    drilldown: { events: '/api/events/' + id, digest: '/api/digest/' + id, sessionRecord: '/api/sessions/' + id },
  });
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    expect(path).toBe('/api/external-runtime-sessions?runtime=antigravity-desktop&limit=100');
    return response({
      sessions: [owner('active-owner', 'active'), owner('conflict-owner', 'runtime_conflict_pending')],
    });
  });
  const ui = {
    opsView: 'rt',
    obsV: 'overview',
    lbRange: 'all',
    toolCat: '',
    toolType: '',
    toolRange: 7,
    rpReview: false,
    rpArch: false,
    rtF: 'all' as 'all' | 'attention',
  };
  const { result } = renderHook(() => useOpsBindings(fixtureData(), ui, true));
  await waitFor(() =>
    expect(projectOwner('ops', result.current, ui, fixtureData(), undefined).cafeWsOps.load).toBe(''),
  );
  const read = () => {
    const vm = projectOwner('ops', result.current, ui, fixtureData(), undefined).cafeWsOps;
    if (!('rt' in vm) || !vm.rt.rows) throw new Error('Expected runtime list');
    return vm.rt;
  };
  expect(read().rows.map((r: { id: string }) => r.id)).toEqual(['active-owner', 'conflict-owner']);
  ui.rtF = 'attention';
  expect(read().rows.map((r: { id: string }) => r.id)).toEqual(['conflict-owner']);
  expect(JSON.stringify(read())).not.toContain('rt_9a01');
});
