import type { InvocationTrajectorySummary, ThreadArtifactDTO } from '@cat-cafe/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchThreadReplayEvents } from '@/lib/story-player/thread-replay-fetcher';
import { apiFetch } from '@/utils/api-client';
import { useBoardBindings } from '../useBoardBindings';
import { useExecutionBindings } from '../useExecutionBindings';
import { useMemoryBindings } from '../useMemoryBindings';
import { type MemoryExploreState, useMemoryExploreBindings } from '../useMemoryExploreBindings';
import { useOpsBindings } from '../useOpsBindings';
import { recallSourceRecords } from '../useRecallBindings';
import { useRecentWorks } from '../useRecentWorks';
import { useReplayBindings } from '../useReplayBindings';
import { useReviewBindings } from '../useReviewBindings';
import { fixtureData, fixtureUi } from './chat-fixture';
import { act, cleanup, renderHook, waitFor } from './hook-host';
import { consoleValue, projectOwner, useOwnerProjection } from './owner-console';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'https://api.test' }));
vi.mock('@/lib/story-player/thread-replay-fetcher', () => ({ fetchThreadReplayEvents: vi.fn() }));
let works: ThreadArtifactDTO[] = [];
vi.mock('@/hooks/useThreadArtifacts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useThreadArtifacts')>()),
  useThreadArtifacts: () => ({ works, loading: false, error: false }),
}));
vi.mock('@/hooks/useGlobalArtifacts', () => ({
  useGlobalArtifacts: () => ({ artifacts: [], loading: false, error: false, workLineage: 'resolved', complete: true }),
}));

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const exploreState = (): MemoryExploreState => ({
  view: 'all',
  win: 7,
  src: 'all',
  who: '',
  lib: 'pending',
  docLimits: {},
  node: '',
  graphQ: '',
  rel: {},
  targets: {},
  curation: null,
  searched: '',
  type: 'all',
  depth: 'summary',
  limit: 10,
  brakeRange: '30',
  brakeWord: 'all',
  brakeSel: '',
});
const healthReport = {
  totalDocs: 12,
  byKind: { feature: 8, decision: 4 },
  byAuthority: { rule: 9, observed: 3 },
  contradictions: { total: 4, unresolved: 2 },
  staleReview: { warning: 3, overdue: 1 },
  unverified: 2,
  backstopRatio: 0.25,
  compressionRatio: 0.5,
  generatedAt: '2026-11-04T00:00:00Z',
};
const toolMetric = { value: 25, unit: '%', sampleN: 40, sufficient: true, threshold: 20 };
const libraryMetrics = {
  generatedAt: '2026-11-04T00:00:00Z',
  threadCount: 8,
  distribution: { searchEvidence: toolMetric, graphResolve: toolMetric, listRecent: toolMetric },
  grepAfterSearchRate: toolMetric,
  candidateSelectionDistribution: { ...toolMetric, value: null, sampleN: 2, sufficient: false },
  listRecentAdoptionRate: toolMetric,
  nudgeFailureRate: toolMetric,
  expansionFollowupRate: toolMetric,
};
async function memoryResponse(path: string) {
  const url = new URL(path, 'https://api.test');
  if (url.pathname === '/api/memory/catalog') return response({ collections: [], defaultTargetCollectionId: null });
  if (url.pathname === '/api/memory/library-feed') return response({ pending: [], processed: [] });
  if (url.pathname === '/api/evidence/status')
    return response({
      backend: 'sqlite',
      healthy: true,
      docs_count: 4,
      passages_count: 9,
      edges_count: 3,
      configWarnings: [],
    });
  if (url.pathname === '/api/memory/maintenance')
    return response({ checks: [], pendingChecks: 0, passedChecks: 6, generatedAt: '2026-11-04' });
  if (url.pathname === '/api/f163/health-report') return response(healthReport);
  if (url.pathname === '/api/library/tool-usage-metrics') return response(libraryMetrics);
  if (url.pathname === '/api/recall/lifecycle/three-axis')
    return response({
      days: Number(url.searchParams.get('days')),
      from: 1,
      to: 2,
      harmfulConsumption: { value: 0, maturity: 'measured', reason: null },
      unmetDemandLowerBound: { value: 3, maturity: 'lower-bound', reason: 'Verified lower bound' },
      attentionCost: { value: 0, maturity: 'no-data', reason: 'No consumption evidence' },
    });
  if (url.pathname === '/api/config/memory-curation')
    return response({ enabled: false, modelLabel: 'Curator', curatorCatId: 'codex', systemThreadId: 'curation' });
  if (url.pathname === '/api/recall/flags') return response({ f200: { consumptionRerank: 'shadow' } });
  if (url.pathname === '/api/services') return response({ services: [] });
  if (url.pathname === '/api/memory/recall')
    return response({
      days: Number(url.searchParams.get('days')),
      from: 1,
      to: 2,
      readStatus: 'ready',
      records: [],
      replies: [],
      nextCursor: null,
    });
  if (url.pathname === '/api/memory/recall/stats')
    return response({ days: Number(url.searchParams.get('days')), from: 1, to: 2, rows: [] });
  if (['/api/memory/people', '/api/memory/profile', '/api/memory/entities', '/api/memory/taste'].includes(url.pathname))
    return response({ readStatus: 'ready', entries: [], meta: { hasMore: false }, coverage: null });
  if (url.pathname === '/api/memory/events')
    return response({ events: [], meta: { count: 0, offset: 0, hasMore: false } });
  throw new Error('Unexpected W2 owner ' + path);
}
beforeEach(() => {
  vi.resetAllMocks();
  works = [];
  vi.mocked(apiFetch).mockImplementation((path) => memoryResponse(String(path)));
});
afterEach(async () => {
  await cleanup();
  vi.unstubAllGlobals();
});

const run: InvocationTrajectorySummary = {
  invocationId: 'old-invocation',
  sessionId: 'old-session',
  sessionSeq: 0,
  sessionStatus: 'sealed',
  threadId: 'pdl-test',
  catId: 'codex',
  status: 'done',
  startedAt: 1,
  durationMs: 2,
  eventCount: 1,
  statusEventCount: 0,
  toolUseCount: 0,
  toolResultCount: 0,
  messageCount: 1,
  errorCount: 0,
  toolNames: [],
  keyMessages: ['Original run'],
};
it('searches the full transcript owner and opens an exact hit outside the recent invocation list', async () => {
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    const url = new URL(String(path), 'https://api.test');
    if (url.pathname.endsWith('/sessions/search')) {
      expect(url.searchParams.get('scope')).toBe('transcripts');
      expect(url.searchParams.get('q')).toBe('buried text');
      return response({
        hits: [
          {
            kind: 'event',
            sessionId: 'old-session',
            snippet: 'buried text from the full record',
            pointer: { eventNo: 3, invocationId: 'old-invocation' },
          },
          {
            kind: 'event',
            sessionId: 'old-session',
            snippet: 'buried text without an invocation',
            pointer: { eventNo: 80 },
          },
        ],
      });
    }
    if (url.pathname.endsWith('/invocations/old-invocation'))
      return response({
        invocationId: run.invocationId,
        summary: run,
        total: 1,
        events: [
          {
            v: 1,
            t: 1,
            threadId: run.threadId,
            sessionId: run.sessionId,
            catId: run.catId,
            invocationId: run.invocationId,
            eventNo: 3,
            event: { type: 'text', content: 'Full owner record' },
          },
        ],
      });
    if (url.pathname.endsWith('/old-session/events')) {
      expect(url.searchParams.get('cursor')).toBe('80');
      return response({ messages: [{ eventNo: 80, content: 'Exact ungrouped hit' }] });
    }
    if (url.pathname.endsWith('/sessions'))
      return response({ sessions: [{ id: 'old-session', catId: 'codex', status: 'sealed', seq: 0, createdAt: 1 }] });
    if (url.pathname.endsWith('/invocations')) return response({ invocations: [] });
    if (url.pathname === '/api/external-runtime-sessions') return response({ sessions: [] });
    throw new Error(String(path));
  });
  const state = { tjMode: 'timeline', execQ: '' };
  const { result } = renderHook(() =>
    useOwnerProjection('execution', useExecutionBindings(fixtureData(), state, true), { ws: state }),
  );
  await waitFor(() => expect(result.current.project('').load).toBe(''));
  await act(() => result.current.action('execSearch', { q: 'buried text' }));
  await waitFor(() => expect(result.current.project(state.execQ).hits).toHaveLength(2));
  expect(result.current.project(state.execQ).hits[0]).toMatchObject({
    preview: 'buried text from the full record',
    args: { sessionId: 'old-session', v: 'old-invocation' },
  });
  await act(() => result.current.action('execOpen', { sessionId: 'old-session', v: 'old-invocation' }));
  expect(result.current.project(state.execQ)).toMatchObject({
    run: {
      id: 'old-invocation',
      rawRecords: expect.arrayContaining([
        expect.objectContaining({ event: expect.objectContaining({ content: 'Full owner record' }) }),
      ]),
    },
  });
  const hit = result.current.project(state.execQ).hits[1]!;
  expect(hit.args).toEqual({ sessionId: 'old-session', eventNo: '80' });
  await act(() =>
    result.current.action('externalSessionOpen', { sessionId: hit.args.sessionId, eventNo: hit.args.eventNo! }),
  );
  expect(result.current.project(state.execQ)).toMatchObject({ externalDetail: { body: ['Exact ungrouped hit'] } });
  await act(() => result.current.action('refresh', { k: 'exec' }));
  expect(result.current.project(state.execQ)).toMatchObject({ externalDetail: { body: ['Exact ungrouped hit'] } });
});

it('joins exact oversized event slices and then continues the external chat cursor', async () => {
  const content = 'BEGIN ' + 'x'.repeat(9000) + ' TAIL';
  const serialized = JSON.stringify({ type: 'text', content });
  const offsets: number[] = [];
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    const url = new URL(String(path), 'https://api.test');
    if (url.pathname === '/api/external-runtime-sessions')
      return response({
        sessions: [
          {
            sessionId: 'external',
            threadId: 'pdl-test',
            binding: { mode: 'thread', threadId: 'pdl-test' },
            catId: 'codex',
            model: 'Real model',
            lifecycle: { state: 'active' },
            lastObservedAt: 1,
          },
        ],
      });
    if (url.pathname.endsWith('/sessions')) return response({ sessions: [] });
    if (url.pathname.endsWith('/invocations')) return response({ invocations: [] });
    if (url.pathname.endsWith('/events')) {
      if (url.searchParams.get('view') === 'chat')
        return response(
          url.searchParams.get('cursor') === '18'
            ? { messages: [{ content: 'Next page', eventNo: 18 }] }
            : { messages: [{ oversized: true, eventNo: 17 }], nextCursor: { eventNo: 18 } },
        );
      expect(url.searchParams.get('cursor')).toBe('17');
      expect(url.searchParams.get('limit')).toBe('1');
      const offset = Number(url.searchParams.get('charOffset'));
      offsets.push(offset);
      return response({
        eventNo: 17,
        charOffset: offset,
        eventSlice: serialized.slice(offset, offset + 8000),
        ...(offset === 0 ? { nextCharOffset: 8000 } : {}),
      });
    }
    throw new Error(String(path));
  });
  const { result } = renderHook(() =>
    useOwnerProjection('execution', useExecutionBindings(fixtureData(), { tjMode: 'timeline' }, true)),
  );
  await waitFor(() => expect(result.current.project('').load).toBe(''));
  await act(() => result.current.action('externalSessionOpen', { sessionId: 'external' }));
  expect(result.current.project('')).toMatchObject({ externalDetail: { body: [content], more: true } });
  expect(offsets).toEqual([0, 8000]);
  await act(() => result.current.action('runtimeExternalMore', { sessionId: 'external' }));
  expect(result.current.project('')).toMatchObject({
    externalDetail: { body: [content, 'Next page'], more: false },
  });
});

it('resolves a recall document through its owner collection and clears old content when the next source refuses access', async () => {
  const items = consoleValue('recallItems(events, threadId)', {
    events: recallSourceRecords(
      [
        {
          id: 'recall',
          query: 'q',
          timestamp: 1,
          results: [{ title: 'Feature', sourceType: 'feature', anchor: 'F900', href: '/memory/search?q=F900' }],
        },
      ],
      [],
    ),
    threadId: 'pdl-test',
  });
  expect(items[0]).toMatchObject({ act: 'recallSource', args: { anchor: 'F900' } });
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    const url = new URL(String(path), 'https://api.test');
    if (url.pathname === '/api/memory/catalog')
      return response({
        collections: [{ id: 'project:source', name: 'Source', status: 'active', readStatus: 'ready' }],
      });
    if (url.pathname === '/api/memory/search/document') {
      expect(url.searchParams.get('collection')).toBe('project:source');
      return url.searchParams.get('anchor') === 'F900'
        ? response({ title: 'Owner document', content: 'Readable original document' })
        : response({ error: 'scope_revoked' }, 403);
    }
    return memoryResponse(String(path));
  });
  const { result } = renderHook(() => useMemoryBindings(() => true));
  await act(() => result.current.action('memoryOpen', { family: 'document', id: 'F900' }));
  expect(projectOwner('memory', result.current, {}, undefined, undefined).cafeMemory.sdoc).toMatchObject({
    title: 'Owner document',
    paras: ['Readable original document'],
  });
  await act(async () => {
    await expect(
      result.current.action('memoryOpen', { family: 'document', id: 'F901', collection: 'project:source' }),
    ).rejects.toThrow('scope_revoked');
  });
  expect(JSON.stringify(projectOwner('memory', result.current, {}, undefined, undefined))).not.toContain(
    'Readable original document',
  );
});

it('keeps a library candidate pending until the real visibility confirmation and owner receipt succeed', async () => {
  const candidate = {
    id: 'candidate',
    content: 'Actual candidate',
    kind: 'lesson',
    state: 'pending',
    createdAt: '2026-11-04',
    collectionName: null,
    sourceVisibility: 'private',
  };
  let processed = false;
  const bodies: Record<string, unknown>[] = [];
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/memory/catalog')
      return response({
        collections: [
          {
            id: 'project:public',
            name: 'Public',
            kind: 'project',
            visibility: 'public',
            status: 'active',
            readStatus: 'ready',
            docCount: 4,
            lastDocumentUpdatedAt: '2026-11-04',
          },
        ],
        defaultTargetCollectionId: 'project:public',
      });
    if (path === '/api/memory/library-feed')
      return response({
        pending: processed ? [] : [candidate],
        processed: processed ? [{ ...candidate, state: 'approved' }] : [],
      });
    if (path === '/api/knowledge/approve') {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (!body.confirmVisibilityWidening) return response({ error: 'visibility-widening requires confirmation' }, 400);
      processed = true;
      return response({ status: 'approved', materialized: { outputPath: 'docs/lesson.md', reindexed: true } });
    }
    return memoryResponse(String(path));
  });
  const confirm = vi.fn().mockResolvedValue(false);
  window.clowderChat = { confirm } as unknown as Window['clowderChat'];
  const state = exploreState();
  state.view = 'library';
  const { result } = renderHook(() => useMemoryExploreBindings(state, () => true));
  await waitFor(() => expect(projectOwner('memoryExplore', result.current, state, undefined, undefined).load).toBe(''));
  expect(projectOwner('memoryExplore', result.current, state, undefined, undefined).library?.cands[0].to).toBe('');
  await act(() => result.current.action('memoryLibraryTarget', { id: 'candidate', v: 'project:public' }));
  await act(() => result.current.action('memoryLibraryDecide', { id: 'candidate', v: '1' }));
  expect(processed).toBe(false);
  expect(projectOwner('memoryExplore', result.current, state, undefined, undefined).library?.cands).toHaveLength(1);
  confirm.mockResolvedValue(true);
  await act(() => result.current.action('memoryLibraryDecide', { id: 'candidate', v: '1' }));
  await waitFor(() =>
    expect(projectOwner('memoryExplore', result.current, state, undefined, undefined).library?.done[0].result).toEqual({
      path: 'docs/lesson.md',
      reindexed: true,
    }),
  );
  expect(bodies.at(-1)).toEqual({
    markerId: 'candidate',
    targetCollectionId: 'project:public',
    confirmVisibilityWidening: true,
  });
});

it('uses the recall owner cursor and exact child reply rather than a fabricated reply timestamp', async () => {
  let second = false;
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    const url = new URL(String(path), 'https://api.test');
    if (url.pathname === '/api/memory/recall') {
      second = url.searchParams.has('cursor');
      if (second) expect(url.searchParams.get('cursor')).toBe('owner-cursor');
      return response({
        days: 7,
        from: 1,
        to: 10,
        readStatus: 'ready',
        records: [
          {
            threadId: 'source-thread',
            threadTitle: 'Source thread',
            event: {
              id: second ? 'event-old' : 'event-new',
              catId: 'codex',
              invocationId: 'child',
              query: 'Actual query',
              timestamp: second ? 2 : 3,
              source: 'pull',
            },
          },
        ],
        replies: [
          { threadId: 'source-thread', messageId: 'actual-reply', catId: 'codex', invocationId: 'child', timestamp: 5 },
        ],
        nextCursor: second ? null : 'owner-cursor',
      });
    }
    return memoryResponse(String(path));
  });
  const state = exploreState();
  state.view = 'recall';
  const { result } = renderHook(() => useMemoryExploreBindings(state, () => true));
  await waitFor(() => expect(projectOwner('memoryExplore', result.current, state, undefined, undefined).load).toBe(''));
  expect(
    projectOwner('memoryExplore', result.current, state, undefined, undefined).recall?.groups[0].items[0].mid,
  ).toBe('actual-reply');
  await act(() => result.current.action('memoryRecallMore', {}));
  await waitFor(() =>
    expect(
      projectOwner('memoryExplore', result.current, state, undefined, undefined).recall?.groups[0].items,
    ).toHaveLength(2),
  );
  expect(second).toBe(true);
  expect(projectOwner('memoryExplore', result.current, state, undefined, undefined).recall?.noMore).toBe(true);
});

it('keeps the collection coordinate when a graph query has more than one possible node', async () => {
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    const url = new URL(String(path), 'https://api.test');
    if (url.pathname === '/api/library/graph/resolve')
      return response({
        status: 'candidates',
        candidates: [{ anchor: 'F900', collectionId: 'project:second', title: 'The owner result' }],
      });
    if (url.pathname === '/api/library/graph') {
      expect(url.searchParams.get('collection')).toBe('project:second');
      return response({
        center: 'F900',
        depth: 1,
        nodes: [{ anchor: 'F900', collectionId: 'project:second', title: 'The exact node', kind: 'feature' }],
        edges: [],
      });
    }
    return memoryResponse(String(path));
  });
  const state = exploreState();
  state.view = 'graph';
  const { result } = renderHook(() => useMemoryExploreBindings(state, () => true));
  await act(() => result.current.action('memoryGraph', { q: 'feature query' }));
  state.node = projectOwner('memoryExplore', result.current, state, undefined, undefined).graph!.nodes[0].v;
  await act(() => result.current.action('memoryGraphNode', {}));
  expect(
    projectOwner('memoryExplore', result.current, state, undefined, undefined).graph?.graph.nodes[0],
  ).toMatchObject({ id: 'F900' });
});

it('keeps same-named external projects distinct and writes audit/import commands to the selected project', async () => {
  const projects = ['one', 'two'].map((id) => ({
    id,
    name: 'Same name',
    sourcePath: '/public-fixture/' + id,
    backlogPath: 'docs/ROADMAP.md',
    description: '',
    userId: 'test-owner',
    createdAt: 1,
    updatedAt: 1,
  }));
  const writes: { path: string; body: unknown }[] = [];
  let patterns = [
      { id: 'lesson/two', category: 'methodology', title: 'Selected lesson', insight: 'Insight', evidence: 'Evidence' },
    ],
    rejectDelete = true;
  const deletes: string[] = [];
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    const url = new URL(String(path), 'https://api.test');
    if (init?.method === 'DELETE') {
      deletes.push(url.pathname);
      if (rejectDelete) return response({ error: 'delete_refused' }, 409);
      patterns = [];
      return response({ ok: true });
    }
    if (init?.method === 'POST') {
      writes.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
      return response({ imported: 1 });
    }
    if (url.pathname === '/api/external-projects') return response({ projects });
    if (url.pathname === '/api/backlog/items') return response({ items: [] });
    if (url.pathname === '/api/execution-digests') return response({ digests: [] });
    if (url.pathname.endsWith('/frame')) return response({ error: 'not_found' }, 404);
    if (url.pathname.endsWith('/intent-cards')) return response({ cards: [] });
    if (url.pathname.endsWith('/resolutions')) return response({ resolutions: [] });
    if (url.pathname.endsWith('/slices')) return response({ slices: [] });
    if (url.pathname.endsWith('/reflux-patterns'))
      return response({ patterns: url.pathname.includes('/two/') ? patterns : [] });
    if (url.pathname.endsWith('/risk-summary')) return response({ signals: {}, totalCards: 0, cardsWithRisks: 0 });
    throw new Error(String(path));
  });
  const state = { boardV: 'list', hbItem: null, hbView: 'sug', depScope: 'all', node: null, zoom: 1, pan: [0, 0] };
  const { result } = renderHook(() =>
    useOwnerProjection('board', useBoardBindings(fixtureData(), state, true), { ws: state }),
  );
  await act(() => result.current.action('boardBrowse', {}));
  await waitFor(() => expect(result.current.project().hubPanel.projects).toHaveLength(2));
  state.boardV = 'x:two';
  await act(() => result.current.action('boardBrowse', {}));
  await waitFor(() => expect(result.current.project().hubPanel.ext?.name).toBe('two'));
  const values = {
    sponsor: 'Owner',
    motivation: 'Actual intent',
    successMetric: 'Exact AC',
    constraints: '',
    currentWorkflow: 'Current',
    provenanceMap: 'Source',
  };
  await act(() => result.current.action('boardFrameSave', { id: 'two', values: JSON.stringify(values) }));
  await act(() => result.current.action('wsExtImport', { n: 'two' }));
  expect(writes).toEqual([
    { path: '/api/external-projects/two/frame', body: values },
    { path: '/api/external-projects/two/import-backlog', body: {} },
  ]);
  expect(result.current.project().boardItems).toEqual([]);
  Object.assign(state, { extSec: 'reflux' });
  expect(result.current.project().hubPanel.ext.rows[0]).toMatchObject({ id: 'lesson/two', canDeleteReflux: true });
  await act(async () => {
    await expect(result.current.action('wsRefluxDelete', { projectId: 'two', id: 'lesson/two' })).rejects.toThrow(
      'delete_refused',
    );
  });
  expect(result.current.project().hubPanel.ext.rows).toHaveLength(1);
  rejectDelete = false;
  await act(() => result.current.action('wsRefluxDelete', { projectId: 'two', id: 'lesson/two' }));
  expect(result.current.project().hubPanel.ext.rows).toEqual([]);
  expect(deletes).toEqual([
    '/api/external-projects/two/reflux-patterns/lesson%2Ftwo',
    '/api/external-projects/two/reflux-patterns/lesson%2Ftwo',
  ]);
});

it('opens published Markdown, PR, audio and binary content in the existing work VM', async () => {
  works = [
    {
      type: 'file',
      name: 'owner.md',
      url: '/uploads/owner.md',
      ref: 'owner.md',
      sourceMessageId: 'message-md',
      catId: 'codex',
      createdAt: 1,
    },
    { type: 'pr', name: 'Owner PR', ref: 'org/repo#51', sourceMessageId: 'message-pr', catId: 'codex', createdAt: 2 },
    {
      type: 'audio',
      name: 'owner.mp3',
      url: '/uploads/owner.mp3',
      sourceMessageId: 'message-audio',
      catId: 'codex',
      createdAt: 3,
    },
    {
      type: 'file',
      name: 'owner.zip',
      url: '/uploads/owner.zip',
      sourceMessageId: 'message-bin',
      catId: 'codex',
      createdAt: 4,
    },
  ];
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path === '/uploads/owner.md') return new Response('# Published owner text');
    if (path === '/api/uploads/owner.zip/file-info')
      return response({ local: false, mime: 'application/zip', byteLength: 2048 });
    throw new Error(String(path));
  });
  const { result } = renderHook(() =>
    useOwnerProjection('reviews', useReviewBindings('pdl-test', fixtureUi(), undefined, true)),
  );
  await act(() => result.current.action('workOpen', { i: '0' }));
  await waitFor(() =>
    expect(result.current.project().work?.text).toMatchObject({ md: '# Published owner text', mode: 'render' }),
  );
  expect(result.current.project().work?.media).toBeNull();
  result.current.project().workTextState.mode = 'src';
  expect(result.current.project().work?.text).toMatchObject({ mode: 'src' });
  await act(() => result.current.action('workOpen', { i: '1' }));
  expect(result.current.project().work?.pr).toMatchObject({ url: 'https://github.com/org/repo/pull/51' });
  await act(() => result.current.action('workOpen', { i: '2' }));
  expect(result.current.project().work?.media).toMatchObject({
    kind: 'audio',
    src: 'https://api.test/uploads/owner.mp3',
  });
  await act(() => result.current.action('workOpen', { i: '3' }));
  expect(result.current.project().work?.bin).toMatchObject({ source: 'https://api.test/uploads/owner.zip' });
});

it('reveals cinematic assistant text gradually and restores the complete canonical text when paused or seeking', async () => {
  const full = 'Cinematic owner answer. '.repeat(24);
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.mocked(fetchThreadReplayEvents).mockResolvedValue([
    {
      v: 1,
      t: 1000,
      threadId: 'pdl-test',
      catId: 'codex',
      sessionId: 'session',
      cliSessionId: 'cli',
      eventNo: 0,
      event: { type: 'user', content: 'Question' },
    },
    {
      v: 1,
      t: 2000,
      threadId: 'pdl-test',
      catId: 'codex',
      sessionId: 'session',
      cliSessionId: 'cli',
      eventNo: 1,
      event: { type: 'assistant', content: full },
    },
    {
      v: 1,
      t: 11000,
      threadId: 'pdl-test',
      catId: 'codex',
      sessionId: 'session',
      cliSessionId: 'cli',
      eventNo: 2,
      event: { type: 'user', content: 'Later question' },
    },
  ]);
  const { result } = renderHook(() => useOwnerProjection('replay', useReplayBindings(undefined, true)));
  await act(() => result.current.action('replayOpen', { id: 'pdl-test' }));
  await waitFor(() => expect(result.current.project().theater.load).toBe(''));
  const frame = async (at: number) => {
    const [id, callback] = frames.entries().next().value!;
    frames.delete(id);
    await act(() => callback(at));
  };
  await act(() => result.current.action('rpPlay', {}));
  await frame(0);
  await frame(20);
  await frame(60);
  await frame(100);
  expect(result.current.project().replayState.on).toBe(true);
  expect(JSON.stringify(result.current.project().theater.items)).toContain('Cinematic');
  expect(JSON.stringify(result.current.project().theater.items)).not.toContain(full);
  await act(() => result.current.action('rpPlay', {}));
  expect(result.current.project().replayState.on).toBe(false);
  expect(JSON.stringify(result.current.project().theater.items)).toContain(full);
  await act(() => result.current.action('rpSeek', { v: '0' }));
  expect(JSON.stringify(result.current.project().theater.items)).not.toContain('Cinematic');
  await act(() => result.current.action('rpSeek', { v: '1' }));
  expect(JSON.stringify(result.current.project().theater.items)).toContain(full);
});

it('offers both readable collections for the same anchor and opens only the selected owner', async () => {
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path === '/api/memory/catalog')
      return response({
        collections: ['project:one', 'project:two'].map((id) => ({
          id,
          name: id,
          status: 'active',
          readStatus: 'ready',
        })),
      });
    if (String(path).startsWith('/api/memory/search/document?')) {
      const collection = new URL(String(path), 'https://api.test').searchParams.get('collection');
      return response({ title: collection, content: 'Owner ' + collection });
    }
    return memoryResponse(String(path));
  });
  const { result } = renderHook(() => useMemoryBindings(() => true));
  await act(() => result.current.action('memoryOpen', { family: 'document', id: 'F900' }));
  expect(projectOwner('memory', result.current, {}, undefined, undefined).cafeMemory.sdoc).toBeNull();
  expect(
    projectOwner('memory', result.current, {}, undefined, undefined).memoryRecallSources.map(
      (source: { collection: string }) => source.collection,
    ),
  ).toEqual(['project:one', 'project:two']);
  await act(() => result.current.action('memoryOpen', { family: 'document', id: 'F900', collection: 'project:two' }));
  expect(projectOwner('memory', result.current, {}, undefined, undefined).cafeMemory.sdoc).toMatchObject({
    paras: ['Owner project:two'],
  });
});

it('retains the real curation preference on a failed write and only changes it after the owner reread', async () => {
  let enabled = true,
    reject = true;
  const bodies: unknown[] = [];
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/config/memory-curation') {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        if (reject) return response({ error: 'preference_unavailable' }, 503);
        enabled = body.enabled;
      }
      return response({ enabled, modelLabel: 'Curator', curatorCatId: 'codex', systemThreadId: 'curation' });
    }
    return memoryResponse(String(path));
  });
  const state = exploreState();
  state.view = 'status';
  const { result } = renderHook(() => useMemoryExploreBindings(state, () => true));
  await waitFor(() => expect(projectOwner('memoryExplore', result.current, state, undefined, undefined).load).toBe(''));
  expect(projectOwner('memoryExplore', result.current, state, undefined, undefined).status?.flags).toMatchObject([
    { id: 'F200_CONSUMPTION_RERANK', value: 'shadow' },
  ]);
  await act(async () => {
    await expect(result.current.action('memoryCuration', { v: false as unknown as string })).rejects.toThrow(
      'preference_unavailable',
    );
  });
  expect(projectOwner('memoryExplore', result.current, state, undefined, undefined).status?.curation.enabled).toBe(
    true,
  );
  reject = false;
  await act(() => result.current.action('memoryCuration', { v: false as unknown as string }));
  await waitFor(() =>
    expect(projectOwner('memoryExplore', result.current, state, undefined, undefined).status?.curation.enabled).toBe(
      false,
    ),
  );
  expect(bodies).toEqual([{ enabled: false }, { enabled: false }]);
});

it('retries the existing rebuild task after a status read fails instead of starting another rebuild', async () => {
  let starts = 0,
    reads = 0;
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path === '/api/evidence/rebuild') {
      starts++;
      return response({ taskId: 'actual-job' });
    }
    if (path === '/api/evidence/rebuild/actual-job') {
      reads++;
      return reads === 1
        ? response({ error: 'read_unavailable' }, 503)
        : response({ id: 'actual-job', status: 'done', phase: 'done', percent: 100, startedAt: 1 });
    }
    return memoryResponse(String(path));
  });
  const state = exploreState();
  state.view = 'status';
  const { result } = renderHook(() => useMemoryExploreBindings(state, () => true));
  await waitFor(() => expect(projectOwner('memoryExplore', result.current, state, undefined, undefined).load).toBe(''));
  await act(() => result.current.action('cafeMemRebuild', { v: 'all' }));
  await waitFor(() =>
    expect(projectOwner('memoryExplore', result.current, state, undefined, undefined).load).toBe('error'),
  );
  await act(() => result.current.action('cafeMemRetry', {}));
  await waitFor(() =>
    expect(projectOwner('memoryExplore', result.current, state, undefined, undefined).status?.rebuild).toMatchObject({
      id: 'actual-job',
      status: 'done',
      percent: 100,
    }),
  );
  expect(starts).toBe(1);
  expect(reads).toBe(2);
});

it('sends the actual memory search filters, retries an unavailable read and preserves exact destinations', async () => {
  let failed = true;
  const queries: Record<string, string>[] = [];
  vi.mocked(apiFetch).mockImplementation(async (raw) => {
    const url = new URL(String(raw), 'https://api.test');
    if (url.pathname !== '/api/memory/search') return memoryResponse(String(raw));
    queries.push(Object.fromEntries(url.searchParams));
    if (failed) return response({ error: 'search_unavailable' }, 503);
    return response({
      query: 'needle',
      readStatus: 'ready',
      groups: [
        {
          type: 'documents',
          status: 'ready',
          hasMore: false,
          results: [
            {
              id: 'doc',
              title: 'Owner document',
              snippet: 'Exact source',
              displayType: 'document',
              destination: { kind: 'document', collection: 'world:owner', anchor: 'same-anchor' },
            },
            {
              id: 'msg',
              title: 'Owner message',
              snippet: 'Exact reply',
              displayType: 'message',
              destination: {
                kind: 'message',
                threadId: 'source-thread',
                messageId: 'source-message',
                contentRevision: 'rev',
              },
            },
          ],
        },
      ],
    });
  });
  const state = exploreState();
  state.type = 'documents';
  state.depth = 'raw';
  state.limit = 17;
  const { result } = renderHook(() => useMemoryExploreBindings(state, () => true));
  await act(() => result.current.action('memorySearch', { q: '  needle  ' }));
  await waitFor(() =>
    expect(projectOwner('memoryExplore', result.current, state, undefined, undefined).load).toBe('error'),
  );
  failed = false;
  await act(() => result.current.action('cafeMemRetry', {}));
  await waitFor(() => expect(projectOwner('memoryExplore', result.current, state, undefined, undefined).load).toBe(''));
  expect(queries).toEqual(Array(2).fill({ q: 'needle', type: 'documents', depth: 'raw', limit: '17' }));
  expect(projectOwner('memoryExplore', result.current, state, undefined, undefined).search?.items).toMatchObject([
    { act: 'recallSource', args: { anchor: 'same-anchor', collection: 'world:owner' } },
    { act: 'msgJump', args: { t: 'source-thread', mid: 'source-message' } },
  ]);
});

it('retains the registered collection after a failed index request and retries without registering twice', async () => {
  let safe = false,
    registered = false,
    indexFailed = true;
  const writes: { path: string; body: unknown }[] = [];
  vi.mocked(apiFetch).mockImplementation(async (raw, init) => {
    const path = new URL(String(raw), 'https://api.test').pathname;
    if (init?.method === 'POST') {
      writes.push({ path, body: JSON.parse(String(init.body)) });
      if (path === '/api/library/bind-dry-run')
        return response({ totalFiles: 9, markdownFiles: 4, secretFindings: safe ? 0 : 2, safe });
      if (path === '/api/library/register') {
        registered = true;
        return response({ manifest: { id: 'research:topic', status: 'registered' } });
      }
      if (path === '/api/library/research%3Atopic/rebuild')
        return indexFailed ? response({ error: 'index_unavailable' }, 503) : response({ blocked: false });
      throw new Error(path);
    }
    if (path === '/api/memory/catalog')
      return response({
        collections: registered
          ? [
              {
                id: 'research:topic',
                name: 'Topic',
                status: indexFailed ? 'registered' : 'active',
                readStatus: 'ready',
              },
            ]
          : [],
        defaultTargetCollectionId: null,
      });
    return memoryResponse(String(raw));
  });
  const state = exploreState();
  const { result } = renderHook(() => useMemoryExploreBindings(state, () => true));
  await act(() => result.current.action('libraryOpen', {}));
  for (const [field, v] of Object.entries({
    kind: 'research',
    name: 'topic',
    displayName: 'Topic',
    root: '/fixture/research',
    sensitivity: 'internal',
  }))
    await act(() => result.current.action('libraryDraft', { field, v }));
  await act(() => result.current.action('libraryScan', {}));
  expect(
    projectOwner('memoryExplore', result.current, exploreState(), undefined, undefined).memoryLibraryForm.scan,
  ).toEqual({
    root: '/fixture/research',
    totalFiles: 9,
    markdownFiles: 4,
    secretFindings: 2,
    safe: false,
  });
  await act(async () => {
    await expect(result.current.action('libraryCreate', {})).rejects.toThrow('安全扫描');
  });
  expect(writes.some((write) => write.path === '/api/library/register')).toBe(false);
  safe = true;
  await act(() => result.current.action('libraryScan', {}));
  await act(async () => {
    await expect(result.current.action('libraryCreate', {})).rejects.toThrow('index_unavailable');
  });
  expect(
    projectOwner('memoryExplore', result.current, exploreState(), undefined, undefined).memoryLibraryForm,
  ).toMatchObject({
    created: { id: 'research:topic', status: 'registered' },
    error: 'index_unavailable',
    busy: false,
  });
  indexFailed = false;
  await act(() => result.current.action('libraryCreate', {}));
  await waitFor(() =>
    expect(
      projectOwner('memoryExplore', result.current, exploreState(), undefined, undefined).memoryLibraryForm.created
        ?.status,
    ).toBe('active'),
  );
  expect(writes.filter((write) => write.path === '/api/library/register')).toEqual([
    {
      path: '/api/library/register',
      body: {
        id: 'research:topic',
        kind: 'research',
        name: 'topic',
        displayName: 'Topic',
        root: '/fixture/research',
        sensitivity: 'internal',
      },
    },
  ]);
  expect(writes.filter((write) => write.path.endsWith('/rebuild'))).toHaveLength(2);
});

it('projects each semantic service independently and uses its existing action and receipt', async () => {
  const base = {
    name: 'Semantic owner',
    description: '',
    category: 'memory',
    endpoint: null,
    configured: true,
    features: ['memory-semantic-search'],
    installable: true,
    selectedModel: 'owner-model',
    port: 9123,
  };
  const services = [
    { ...base, id: 'running', installed: true, enabled: true, status: 'healthy' },
    { ...base, id: 'stopped', installed: true, enabled: false, status: 'not_configured' },
    { ...base, id: 'missing', installed: false, enabled: false, status: 'not_configured' },
    {
      ...base,
      id: 'blocked',
      installed: false,
      enabled: false,
      status: 'not_configured',
      installable: false,
      prerequisites: { runtime: 'Requires owner runtime' },
    },
  ];
  const writes: { path: string; body: unknown }[] = [];
  let reads = 0,
    refused = false;
  vi.mocked(apiFetch).mockImplementation(async (raw, init) => {
    const path = new URL(String(raw), 'https://api.test').pathname;
    if (path === '/api/services') {
      reads++;
      return response({ services });
    }
    if (init?.method === 'POST') {
      writes.push({ path, body: JSON.parse(String(init.body)) });
      return response(refused ? { ok: false, error: 'service_refused' } : { ok: true });
    }
    return memoryResponse(String(raw));
  });
  const state = exploreState();
  state.view = 'status';
  const { result } = renderHook(() => useMemoryExploreBindings(state, () => true));
  await waitFor(() =>
    expect(projectOwner('memoryExplore', result.current, state, undefined, undefined).status?.svc).toHaveLength(4),
  );
  expect(projectOwner('memoryExplore', result.current, state, undefined, undefined).status?.svc).toMatchObject([
    { id: 'running', canStop: true, canStart: false, port: 9123, model: 'owner-model' },
    { id: 'stopped', canStart: true, canConfigure: true },
    { id: 'missing', canInstall: true },
    { id: 'blocked', canInstall: false, prerequisites: { runtime: 'Requires owner runtime' } },
  ]);
  for (const [id, op] of [
    ['running', 'stop'],
    ['stopped', 'start'],
    ['missing', 'install'],
  ])
    await act(() => result.current.action('cafeSvc', { id, op }));
  await act(() =>
    result.current.action('cafeSvc', { id: 'stopped', op: 'reconfigure', port: '9234', model: 'new-model' }),
  );
  expect(writes).toEqual([
    { path: '/api/services/running/stop', body: {} },
    { path: '/api/services/stopped/start', body: {} },
    { path: '/api/services/missing/install', body: {} },
    { path: '/api/services/stopped/reconfigure', body: { port: 9234, model: 'new-model' } },
  ]);
  const before = reads;
  refused = true;
  await act(async () => {
    await expect(result.current.action('cafeSvc', { id: 'stopped', op: 'start' })).rejects.toThrow('service_refused');
  });
  await waitFor(() => expect(reads).toBeGreaterThan(before));
});

it('retries a failed brake offset and grants source navigation only from the selected source receipt', async () => {
  let failed = true;
  const offsets: string[] = [];
  vi.mocked(apiFetch).mockImplementation(async (raw) => {
    const url = new URL(String(raw), 'https://api.test');
    if (url.pathname === '/api/memory/events') {
      const offset = url.searchParams.get('offset')!;
      offsets.push(offset);
      if (offset === '73' && failed) return response({ error: 'page_unavailable' }, 503);
      return response({
        events: [
          {
            eventId: offset === '0' ? 'one' : 'two',
            type: 'Stop',
            trigger: 'human_brake',
            confidence: 'high',
            threadId: 'legacy-thread',
            messageId: offset === '0' ? 'legacy-message' : 'legacy-message-two',
            timestamp: offset === '0' ? 10 : 20,
            summary: offset === '0' ? 'First brake' : 'Second brake',
            cat: 'codex',
            relatedHarness: ['rule'],
          },
        ],
        meta: { hasMore: offset === '0', nextOffset: offset === '0' ? 73 : undefined },
      });
    }
    if (url.pathname === '/api/memory/brakes/one/source') return response({ canOpen: false });
    if (url.pathname === '/api/memory/brakes/two/source')
      return response({ canOpen: true, threadId: 'verified-thread', messageId: 'verified-message' });
    return memoryResponse(String(raw));
  });
  const state = exploreState();
  state.view = 'brakes';
  const { result } = renderHook(() => useMemoryExploreBindings(state, () => true));
  await waitFor(() =>
    expect(projectOwner('memoryExplore', result.current, state, undefined, undefined).brakes?.items).toHaveLength(1),
  );
  expect(projectOwner('memoryExplore', result.current, state, undefined, undefined).brakes?.sel?.canOpen).toBe(false);
  await act(() => result.current.action('cafeBrakesMore', {}));
  await waitFor(() =>
    expect(projectOwner('memoryExplore', result.current, state, undefined, undefined).brakes?.load).toBe('error'),
  );
  failed = false;
  await act(() => result.current.action('cafeBrakesMore', {}));
  await waitFor(() =>
    expect(projectOwner('memoryExplore', result.current, state, undefined, undefined).brakes?.items).toHaveLength(2),
  );
  await waitFor(() =>
    expect(projectOwner('memoryExplore', result.current, state, undefined, undefined).brakes?.sel).toMatchObject({
      canOpen: true,
      mid: 'verified-message',
      thread: 'verified-thread',
    }),
  );
  expect(offsets).toEqual(['0', '73', '73']);
  expect(projectOwner('memoryExplore', result.current, state, undefined, undefined).brakes?.hasMore).toBe(false);
  expect(projectOwner('memoryExplore', result.current, state, undefined, undefined).brakes?.sel?.mid).not.toBe(
    'legacy-message',
  );
});

it('aggregates the selected feature lanes into the same replay engine and returns to the current thread', async () => {
  const raw = (threadId: string, t: number) => ({
    v: 1 as const,
    t,
    threadId,
    catId: 'codex',
    sessionId: threadId,
    cliSessionId: threadId,
    eventNo: 0,
    event: { type: 'user', content: 'Source ' + threadId },
  });
  const originals = [raw('lane-a', 1000), raw('lane-b', 2000)];
  const before = JSON.stringify(originals);
  vi.mocked(fetchThreadReplayEvents).mockImplementation(async (threadId) =>
    threadId === 'pdl-test' ? [raw(threadId, 500)] : [originals.find((event) => event.threadId === threadId)!],
  );
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    expect(path).toBe('/api/story/feat:F901/rendering');
    return response({ lanes: [{ threadId: 'lane-a' }, { threadId: 'lane-b' }] });
  });
  const { result } = renderHook(() =>
    useOwnerProjection(
      'replay',
      useReplayBindings(
        [
          {
            id: 'feature-owner',
            title: 'Owner feature',
            tags: ['F901'],
            userId: 'user',
            summary: '',
            priority: 'p2',
            status: 'open',
            createdBy: 'user',
            createdAt: 1,
            updatedAt: 1,
            audit: [],
          },
        ],
        true,
      ),
    ),
  );
  await act(() => result.current.action('replayOpen', { id: 'pdl-test' }));
  await waitFor(() => expect(result.current.project().theater.load).toBe(''));
  await act(() => result.current.action('rpSource', { v: 'F901' }));
  await waitFor(() => expect(result.current.project().theater.player?.time.count).toBe(1));
  await act(() => result.current.action('rpSeek', { v: '1' }));
  expect(JSON.stringify(result.current.project().theater.items)).toContain('Source lane-a');
  expect(JSON.stringify(result.current.project().theater.items)).toContain('Source lane-b');
  expect(result.current.project().theater.title).toBe('Owner feature');
  expect(JSON.stringify(originals)).toBe(before);
  await act(() => result.current.action('rpSource', { v: 'thread' }));
  await waitFor(() => expect(result.current.project().theater.player?.time.count).toBe(1));
  expect(result.current.project().replayState.source).toBe('thread');
  expect(JSON.stringify(result.current.project().theater.items)).toContain('Source pdl-test');
});

it('binds Mission Hub structured fields and writes clarification, slices, risk and claim commands to their real owners', async () => {
  const project = {
    id: 'project-owner',
    name: 'Owner project',
    sourcePath: '/fixture/project',
    backlogPath: 'docs/ROADMAP.md',
  };
  const card = {
    id: 'intent-owner',
    projectId: project.id,
    actor: 'Actor',
    contextTrigger: 'Trigger',
    goal: 'Goal',
    objectState: 'State',
    successSignal: 'Signal',
    nonGoal: 'Non-goal',
    sourceTag: 'Q',
    sourceDetail: 'Source',
    decisionOwner: 'Owner',
    confidence: 2,
    dependencyTags: [],
    riskSignals: [],
    originalText: 'Original',
    triage: { clarity: 3, groundedness: 2, necessity: 1, coupling: 2, sizeBand: 'M' },
  };
  const slices = ['one', 'two', 'three'].map((id, order) => ({
    id,
    order,
    projectId: project.id,
    name: id,
    sliceType: 'learning',
    description: 'Description',
    actor: 'Actor',
    workflow: 'Workflow',
    verifiableOutcome: 'Outcome',
    cardIds: ['intent-owner'],
    status: 'delivered',
  }));
  const item = {
    id: 'backlog-owner',
    title: '[F901] Owner item',
    summary: 'Actual item',
    status: 'open',
    priority: 'p2',
    tags: ['F901'],
    createdBy: 'owner',
    createdAt: 1,
    updatedAt: 1,
  };
  const writes: { path: string; method: string; body: unknown }[] = [];
  vi.mocked(apiFetch).mockImplementation(async (raw, init) => {
    const url = new URL(String(raw), 'https://api.test'),
      path = url.pathname;
    if (init?.method && init.method !== 'GET') {
      const body = JSON.parse(String(init.body));
      writes.push({ path, method: init.method, body });
      if (path.endsWith('/slices/reorder')) {
        const a = slices.find((slice) => slice.id === body.id1)!,
          b = slices.find((slice) => slice.id === body.id2)!;
        [a.order, b.order] = [b.order, a.order];
      }
      return response(
        path.endsWith('/detect-risks')
          ? {
              risks: [
                {
                  signal: 'hidden_dependencies',
                  severity: 'high',
                  evidence: 'Detected owner evidence',
                  autoDetected: true,
                },
              ],
            }
          : { ok: true },
      );
    }
    if (path === '/api/external-projects') return response({ projects: [project] });
    if (path === '/api/backlog/items') return response({ items: url.searchParams.has('projectId') ? [] : [item] });
    if (path === '/api/backlog/feature-doc-detail') return response({ error: 'not_found' }, 404);
    if (path === '/api/backlog/self-claim-policy') return response({ scopes: { codex: 'once' } });
    if (path === '/api/threads') return response({ threads: [] });
    if (path === '/api/execution-digests') return response({ digests: [] });
    if (path.endsWith('/frame')) return response({ error: 'not_found' }, 404);
    if (path.endsWith('/intent-cards')) return response({ cards: [card] });
    if (path.endsWith('/resolutions'))
      return response({
        resolutions: [
          { id: 'resolution-owner', status: 'open', question: 'Question', recommendation: 'Recommendation' },
        ],
      });
    if (path.endsWith('/slices')) return response({ slices });
    if (path.endsWith('/reflux-patterns')) return response({ patterns: [] });
    if (path.endsWith('/risk-summary')) return response({ signals: {}, totalCards: 1, cardsWithRisks: 0 });
    throw new Error(String(raw));
  });
  const state = {
    boardV: 'x:project-owner',
    hbItem: null,
    hbView: 'sug',
    depScope: 'all',
    node: null,
    zoom: 1,
    pan: [0, 0],
    extSec: 'intent',
  };
  const { result } = renderHook(() =>
    useOwnerProjection('board', useBoardBindings(fixtureData(), state, true), { ws: state }),
  );
  await act(() => result.current.action('boardBrowse', {}));
  await waitFor(() => expect(result.current.project().hubPanel.load).toBe(''));
  await act(() => result.current.action('boardDialog', { kind: 'triage', projectId: project.id, cardId: card.id }));
  expect(result.current.project().boardDialog?.args).toMatchObject({
    kind: 'triage',
    projectId: project.id,
    cardId: card.id,
  });
  expect(result.current.data.external.detail!.cards[0].triage).toMatchObject({ groundedness: 2 });
  await act(() => result.current.action('boardDialog', { kind: 'slice', projectId: project.id, id: 'one' }));
  expect(result.current.data.external.detail!.slices[0]).toMatchObject({ id: 'one', status: 'delivered' });
  const intent = {
    actor: 'New actor',
    contextTrigger: 'New trigger',
    goal: 'New goal',
    objectState: 'New state',
    successSignal: 'New signal',
    nonGoal: 'New non-goal',
    sourceTag: 'R',
    sourceDetail: 'Original evidence',
    decisionOwner: 'Lang',
    confidence: 3,
    originalText: 'Original request',
  };
  const triage = { clarity: 3, groundedness: 2, necessity: 1, coupling: 2, sizeBand: 'M' };
  const reflux = { category: 'methodology', title: 'Lesson', insight: 'Insight', evidence: 'Evidence' };
  for (const [name, body] of [
    ['wsIntentSave', intent],
    ['wsTriageSave', triage],
    ['wsRefluxSave', reflux],
  ] as const)
    await act(() =>
      result.current.action(name, { projectId: project.id, cardId: card.id, body: JSON.stringify(body) }),
    );
  for (const op of ['answer', 'escalate'])
    await act(() =>
      result.current.action('wsClarifySave', {
        projectId: project.id,
        id: 'resolution-owner',
        body: JSON.stringify({ op, answer: 'Actual answer' }),
      }),
    );
  const slice = {
    name: 'Edited',
    description: 'Description',
    actor: 'Actor',
    workflow: 'Workflow',
    verifiableOutcome: 'Outcome',
    cardIds: 'intent-owner, second',
    sliceType: 'hardening',
    status: 'validated',
  };
  await act(() =>
    result.current.action('wsSliceSave', { projectId: project.id, id: 'one', body: JSON.stringify(slice) }),
  );
  await act(() =>
    result.current.action('hubSliceOrder', { projectId: project.id, keys: JSON.stringify(['three', 'one', 'two']) }),
  );
  state.extSec = 'risk';
  await act(() => result.current.action('wsRiskDetect', { projectId: project.id, cardId: card.id }));
  expect(result.current.project().hubPanel.ext?.rows[0]).toMatchObject({
    risk: 'hidden_dependencies',
    sub: 'Detected owner evidence',
    severity: 'high',
  });
  await act(() => result.current.action('boardDialog', { kind: 'hbSelfClaim', k: item.id }));
  expect(result.current.project().boardDialog).toMatchObject({
    scopes: { codex: 'once' },
    args: { kind: 'hbSelfClaim', k: item.id },
  });
  expect(result.current.project().boardDialog?.args.k).toBe(item.id);
  const claim = { catId: 'codex', why: 'Owner why', plan: 'Owner plan', requestedPhase: 'research' };
  await act(() => result.current.action('hbSelfClaim', { id: item.id, body: JSON.stringify(claim) }));
  await act(() => result.current.action('hbReclaim', { id: item.id }));
  expect(writes).toEqual([
    { path: '/api/external-projects/project-owner/intent-cards', method: 'POST', body: intent },
    { path: '/api/external-projects/project-owner/intent-cards/intent-owner/triage', method: 'POST', body: triage },
    { path: '/api/external-projects/project-owner/reflux-patterns', method: 'POST', body: reflux },
    {
      path: '/api/external-projects/project-owner/resolutions/resolution-owner/answer',
      method: 'PATCH',
      body: { answer: 'Actual answer' },
    },
    { path: '/api/external-projects/project-owner/resolutions/resolution-owner/escalate', method: 'PATCH', body: {} },
    {
      path: '/api/external-projects/project-owner/slices/one',
      method: 'PATCH',
      body: {
        name: 'Edited',
        description: 'Description',
        actor: 'Actor',
        workflow: 'Workflow',
        verifiableOutcome: 'Outcome',
        cardIds: ['intent-owner', 'second'],
        status: 'validated',
      },
    },
    {
      path: '/api/external-projects/project-owner/slices/reorder',
      method: 'PATCH',
      body: { id1: 'one', id2: 'three' },
    },
    { path: '/api/external-projects/project-owner/slices/reorder', method: 'PATCH', body: { id1: 'two', id2: 'one' } },
    { path: '/api/external-projects/project-owner/intent-cards/intent-owner/detect-risks', method: 'POST', body: {} },
    { path: '/api/backlog/items/backlog-owner/self-claim', method: 'POST', body: claim },
    { path: '/api/backlog/items/backlog-owner/lease/reclaim', method: 'POST', body: {} },
  ]);
});

it('keeps memory corrections read only and opens only a verified original approval card', async () => {
  const revision = `sha256:${'a'.repeat(64)}`;
  const proposal = {
    proposalId: 'correction-owner',
    status: 'pending',
    expectedRevision: revision,
    reason: 'outdated',
    suggestedPatch: { summary: 'Corrected summary' },
    sourceCatId: 'codex',
    sourceThreadId: 'source-thread',
    source: { threadId: 'source-thread', messageId: 'source-message' },
    createdAt: 100,
  };
  const event = {
    eventId: 'event-owner',
    ownerUserId: 'owner',
    type: 'Stop',
    trigger: 'human_brake',
    cat: 'codex',
    threadId: 'source-thread',
    messageId: 'source-message',
    timestamp: 100,
    summary: 'Original summary',
    cognitiveTransition: null,
    relatedHarness: null,
    confidence: 'high',
    revision,
    status: 'active',
    pendingCorrectionCount: 1,
    correctionProposals: [proposal],
  };
  let hasOriginal = false;
  vi.mocked(apiFetch).mockImplementation(async (raw) => {
    const path = new URL(String(raw), 'https://api.test').pathname;
    if (path === '/api/memory/events/event-owner') return response(event);
    if (path === '/api/memory/events/event-owner/source') return response({ status: 'not_recorded', sources: [] });
    if (path === '/api/concierge/work/decisions')
      return response({
        version: 1,
        status: hasOriginal ? 'partial' : 'available',
        scope: 'owner_all_projects',
        identity: { ownerUserId: 'owner' },
        observedAt: 3,
        sources: {
          approvals: { status: 'available', exhaustiveness: 'complete' },
          needsMe: { status: 'available', exhaustiveness: 'complete' },
        },
        readWindow: { startedAt: 1, endedAt: 3, consistency: 'independent_source_reads' },
        consistency: { state: 'verified', reasons: [] },
        items: hasOriginal
          ? [
              {
                decisionRef: 'approval:F321:correction-owner',
                kind: 'approval',
                summary: 'Correction',
                linkedNeedsMe: [],
                approval: {
                  proposalId: proposal.proposalId,
                  sourceFeatureId: 'F321',
                  navigation: {
                    state: 'anchored',
                    approvalCardRef: { threadId: 'approval-thread', messageId: 'approval-message' },
                  },
                },
              },
            ]
          : [],
        totalCount: hasOriginal ? 1 : 0,
        page: { offset: 0, limit: 20, scope: 'known_rows', hasMore: false },
      });
    return memoryResponse(String(raw));
  });
  const { result } = renderHook(() => useMemoryBindings(() => true));
  await act(() => result.current.action('memoryOpen', { family: 'event', id: event.eventId }));
  expect(projectOwner('memory', result.current, {}, undefined, undefined).cafeMemory.detail).toMatchObject({
    corrections: [{ title: 'Corrected summary', canOpen: false, args: {} }],
  });
  hasOriginal = true;
  await act(() => result.current.action('memoryOpen', { family: 'event', id: event.eventId }));
  expect(projectOwner('memory', result.current, {}, undefined, undefined).cafeMemory.detail).toMatchObject({
    corrections: [{ canOpen: true, args: { t: 'approval-thread', mid: 'approval-message' } }],
  });
  expect(vi.mocked(apiFetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
});

it('opens a project recent work in the existing work owner with shared Office metadata and its actual binary source', async () => {
  const office = {
    type: 'file',
    name: 'owner.pptx',
    url: '/api/workspace/file/raw?worktreeId=source-wt&path=owner.pptx',
    ref: 'owner.pptx',
    catId: 'codex',
    createdAt: 1,
    threadId: 'source-thread',
    sourceMessageId: 'source-message',
    threadTitle: 'Source thread',
    work: { contentRef: 'owner-office', ownerRevision: 7, currentOwnerRevision: 7 },
  };
  vi.mocked(apiFetch).mockImplementation(async (raw) => {
    const url = new URL(String(raw), 'https://api.test');
    if (url.pathname === '/api/artifacts')
      return response({ artifacts: [office], complete: true, workLineage: 'resolved' });
    expect(url.pathname).toBe('/api/workspace/file');
    expect(Object.fromEntries(url.searchParams)).toEqual({ worktreeId: 'source-wt', path: 'owner.pptx' });
    return response({
      path: 'owner.pptx',
      content: '',
      binary: true,
      truncated: false,
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      size: 4096,
      modifiedAt: '2026-11-04',
      pageCount: 12,
      pageUnit: 'slides',
    });
  });
  const data = fixtureData(),
    ui = fixtureUi();
  const { result } = renderHook(() => {
    const recent = useOwnerProjection('recentWorks', useRecentWorks(data, true), { data, ui });
    const review = useOwnerProjection('reviews', useReviewBindings(data.threadId, ui, recent.owners, true), {
      data,
      ui,
    });
    return { recent, review };
  });
  await waitFor(() => expect(result.current.recent.project().recentWorks.rw.load).toBe(''));
  const row = result.current.recent.project().recentWorks.rw.works.items[0];
  expect(row).toMatchObject({ args: { id: row.id } });
  await act(() => result.current.review.action('workOpen', row.args));
  expect(result.current.review.project().work).toMatchObject({
    title: 'owner.pptx',
    bin: { source: 'https://api.test/api/workspace/file/raw?worktreeId=source-wt&path=owner.pptx' },
    fileInfo: {
      pageCount: 12,
      pageUnit: 'slides',
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    },
  });
  expect(ui.lb).not.toBeNull();
});

it('reads risk-summary from the selected external project instead of deriving counts from loaded cards (#073)', async () => {
  let reject = false;
  vi.mocked(apiFetch).mockImplementation(async (raw) => {
    const path = new URL(String(raw), 'https://api.test').pathname;
    if (path === '/api/external-projects')
      return response({
        projects: [
          { id: 'risk-owner', name: 'Project', sourcePath: '/fixture/project', backlogPath: 'docs/ROADMAP.md' },
        ],
      });
    if (path === '/api/backlog/items') return response({ items: [] });
    if (path === '/api/execution-digests') return response({ digests: [] });
    if (path.endsWith('/frame')) return response({ error: 'not_found' }, 404);
    if (path.endsWith('/intent-cards')) return response({ cards: [] });
    if (path.endsWith('/slices')) return response({ slices: [] });
    if (path.endsWith('/resolutions')) return response({ resolutions: [] });
    if (path.endsWith('/reflux-patterns')) return response({ patterns: [] });
    expect(path).toBe('/api/external-projects/risk-owner/risk-summary');
    return reject
      ? response({ error: 'risk_unavailable' }, 503)
      : response({ totalCards: 17, cardsWithRisks: 8, signals: { missing_actors: 6, hidden_dependencies: 3 } });
  });
  const state = {
    boardV: 'x:risk-owner',
    hbItem: null,
    hbView: 'sug',
    depScope: 'all',
    node: null,
    zoom: 1,
    pan: [0, 0],
    extSec: 'risk',
  };
  const { result } = renderHook(() =>
    useOwnerProjection('board', useBoardBindings(fixtureData(), state, true), { ws: state }),
  );
  await act(() => result.current.action('boardBrowse', {}));
  await waitFor(() => expect(result.current.project().hubPanel.load).toBe(''));
  expect(result.current.project().hubPanel.ext).toMatchObject({
    cards: 17,
    risks: 8,
    rows: [
      { risk: 'missing_actors', count: 6 },
      { risk: 'hidden_dependencies', count: 3 },
    ],
  });
  reject = true;
  await act(() => result.current.action('refresh', { k: 'board' }));
  await waitFor(() => expect(result.current.project().hubPanel.load).toBe('error'));
  expect(result.current.project().hubPanel.ext).toBeNull();
});

it('projects full knowledge health and library tool sample quality through the existing status rows (#076/#092)', async () => {
  const state = exploreState();
  state.view = 'status';
  vi.mocked(apiFetch).mockImplementation(async (raw) => {
    if (raw === '/api/f163/health-report')
      return response({
        ...healthReport,
        staleAnchors: { count: 7, items: [{ anchor: 'doc', sourcePath: 'docs/source.md' }] },
        orphanEdges: { count: 2 },
        verificationDebt: { needsReviewCount: 5, escalatedCount: 1, trustedLegacyCount: 8 },
        searchQuality: {
          totalSearches: 20,
          observedSearches: 18,
          zeroHitCount: 2,
          lowHitCount: 3,
          identifierProbeZeroHitCount: 4,
          recentMisses: [{ query: 'example', resultCount: 0, searchedAt: '2026-11-04' }],
        },
        replayDrift: { available: false, sampleCount: 0, avgSimilarity: null },
        knowledgeFeed: { pendingCount: 4, needsReviewCount: 2 },
      });
    return memoryResponse(String(raw));
  });
  const { result } = renderHook(() => useMemoryExploreBindings(state, () => true));
  await waitFor(() => expect(projectOwner('memoryExplore', result.current, state, undefined, undefined).load).toBe(''));
  const status = projectOwner('memoryExplore', result.current, state).status;
  expect(status.healthReport).toMatchObject({
    ...healthReport,
    staleAnchors: { count: 7 },
    orphanEdges: { count: 2 },
    verificationDebt: { needsReviewCount: 5, escalatedCount: 1, trustedLegacyCount: 8 },
    searchQuality: {
      totalSearches: 20,
      observedSearches: 18,
      zeroHitCount: 2,
      lowHitCount: 3,
      identifierProbeZeroHitCount: 4,
    },
    replayDrift: { available: false, sampleCount: 0, avgSimilarity: null },
    knowledgeFeed: { pendingCount: 4, needsReviewCount: 2 },
  });
  expect(status.toolUsage).toEqual(await (await memoryResponse('/api/library/tool-usage-metrics')).json());
});

it('retries the real health and tool metric owners after an unavailable report without filling zeroes (#076/#092)', async () => {
  let failed = true;
  const reads: string[] = [];
  vi.mocked(apiFetch).mockImplementation(async (raw) => {
    const path = String(raw);
    if (['/api/f163/health-report', '/api/library/tool-usage-metrics'].includes(path)) {
      reads.push(path);
      if (failed) return response({ error: 'owner_unavailable' }, 503);
    }
    return memoryResponse(path);
  });
  const state = exploreState();
  state.view = 'status';
  const { result } = renderHook(() => useMemoryExploreBindings(state, () => true));
  await waitFor(() =>
    expect(projectOwner('memoryExplore', result.current, state, undefined, undefined).load).toBe('error'),
  );
  expect(projectOwner('memoryExplore', result.current, state).status.healthReport).toBeNull();
  expect(projectOwner('memoryExplore', result.current, state).status.toolUsage).toBeNull();
  failed = false;
  await act(() => result.current.action('cafeMemRetry', {}));
  await waitFor(() => expect(projectOwner('memoryExplore', result.current, state, undefined, undefined).load).toBe(''));
  expect(reads.filter((path) => path === '/api/f163/health-report')).toHaveLength(2);
  expect(reads.filter((path) => path === '/api/library/tool-usage-metrics')).toHaveLength(2);
});

it('uses all three funnel counts and keeps lifecycle maturity within the selected day window (#167/#168)', async () => {
  const days: string[] = [];
  vi.mocked(apiFetch).mockImplementation(async (raw) => {
    const url = new URL(String(raw), 'https://api.test');
    if (url.pathname === '/api/memory/recall/stats')
      return response({
        days: Number(url.searchParams.get('days')),
        from: 1,
        to: 2,
        rows: [{ source: 'pull', surface: 'cat_search', presented: 19, inspected: 7, used: 2 }],
      });
    if (url.pathname === '/api/recall/lifecycle/three-axis') {
      days.push(url.searchParams.get('days')!);
      return response({
        harmfulConsumption: { value: 0, maturity: 'measured', reason: null },
        unmetDemandLowerBound: { value: 4, maturity: 'lower-bound', reason: 'Known lower bound' },
        attentionCost: {
          value: 12,
          maturity: url.searchParams.get('days') === '7' ? 'no-data' : 'estimated',
          reason: 'Owner estimate',
        },
      });
    }
    return memoryResponse(String(raw));
  });
  const state = exploreState();
  state.view = 'recall';
  const { result } = renderHook(() => useMemoryExploreBindings(state, () => true));
  await waitFor(() => expect(projectOwner('memoryExplore', result.current, state, undefined, undefined).load).toBe(''));
  const recall = projectOwner('memoryExplore', result.current, state).recall;
  expect(recall.ledger.rows).toEqual([{ source: 'pull', surface: 'cat_search', presented: 19, inspected: 7, used: 2 }]);
  expect(recall.lifecycle).toEqual({
    harmfulConsumption: { value: 0, maturity: 'measured', reason: null },
    unmetDemandLowerBound: { value: 4, maturity: 'lower-bound', reason: 'Known lower bound' },
    attentionCost: { value: 12, maturity: 'no-data', reason: 'Owner estimate' },
  });
  state.win = 30;
  await act(() => result.current.action('cafeMemRetry', {}));
  await waitFor(() =>
    expect(projectOwner('memoryExplore', result.current, state).recall.lifecycle.attentionCost).toEqual({
      value: 12,
      maturity: 'estimated',
      reason: 'Owner estimate',
    }),
  );
  expect(days).toEqual(['7', '30']);
});

it('reads persistence warnings and per-route summaries without turning missing step counts into zero (#179/#180)', async () => {
  const summaryScopes: Record<string, string>[] = [];
  let memory = true,
    summaryFailed = false;
  vi.mocked(apiFetch).mockImplementation(async (raw) => {
    const url = new URL(String(raw), 'https://api.test');
    if (url.pathname === '/api/system/status')
      return response({
        storageMode: memory ? 'memory' : 'redis',
        storage: {
          mode: memory ? 'memory' : 'redis',
          persistent: !memory,
          warning: memory ? 'Memory mode: data will be lost on restart.' : null,
        },
      });
    if (url.pathname === '/api/telemetry/health')
      return response({
        status: 'healthy',
        uptime: 120,
        otelEnabled: true,
        errorRate: 0,
        traceStore: { spanCount: 3, maxSpans: 100, oldestStoredAt: 1 },
        metricsSnapshotStore: null,
        timestamp: 2,
      });
    if (url.pathname === '/api/config/env-summary') return response({ variables: [] });
    if (url.pathname === '/api/telemetry/metrics/history') return response({ snapshots: [] });
    if (url.pathname === '/api/telemetry/traces')
      return response({
        spans: [
          { traceId: 'trace-one', spanId: 'route-a', name: 'cat_cafe.route' },
          { traceId: 'trace-one', spanId: 'route-b', name: 'cat_cafe.route' },
          { traceId: 'trace-one', spanId: 'tool-a', name: 'cat_cafe.mcp_call' },
        ],
      });
    expect(url.pathname).toBe('/api/telemetry/step-summary');
    summaryScopes.push(Object.fromEntries(url.searchParams));
    return summaryFailed
      ? response({ error: 'summary_unavailable' }, 503)
      : response({
          traceId: 'trace-one',
          routeSpanId: url.searchParams.get('routeSpanId'),
          agent_loop_count: null,
          tool_call_count: null,
          a2a_dispatch_count: null,
          duration_ms: 123,
          token_total: 250,
          error_count: 1,
          is_restored: false,
          width_avg_tools_per_loop: null,
          agent_loop_partial: false,
        });
  });
  const state = {
    opsView: 'obs',
    obsV: 'overview',
    lbRange: 'all',
    toolCat: '',
    toolType: '',
    toolRange: 7,
    rpReview: false,
    rpArch: false,
  };
  const { result } = renderHook(() => useOpsBindings(fixtureData(), state, true));
  await waitFor(() =>
    expect(projectOwner('ops', result.current, state, fixtureData()).cafeWsOps.obs).toMatchObject({
      telemetryOff: false,
      persistence: { mode: 'memory', persistent: false, warning: 'Memory mode: data will be lost on restart.' },
      steps: expect.arrayContaining([
        expect.objectContaining({
          summary: expect.objectContaining({
            routeSpanId: 'route-a',
            agent_loop_count: null,
            tool_call_count: null,
            a2a_dispatch_count: null,
            duration_ms: 123,
            width_avg_tools_per_loop: null,
          }),
        }),
      ]),
    }),
  );
  memory = false;
  await act(() => result.current.action('refresh', { k: 'obs' }));
  expect(projectOwner('ops', result.current, state, fixtureData()).cafeWsOps.obs).toMatchObject({
    telemetryOff: false,
    persistence: { mode: 'redis', persistent: true, warning: null },
  });
  summaryFailed = true;
  await act(async () => {
    await expect(result.current.action('refresh', { k: 'obs' })).rejects.toThrow('summary_unavailable');
  });
  expect(projectOwner('ops', result.current, state, fixtureData(), undefined).cafeWsOps.load).toBe('error');
});
