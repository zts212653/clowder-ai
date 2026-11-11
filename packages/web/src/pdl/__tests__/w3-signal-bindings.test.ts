import type { StudyMeta } from '@cat-cafe/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PlaybackSnapshot } from '@/services/PlaybackManager';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { useSignalBindings } from '../useSignalBindings';
import { act, cleanup, renderHook, waitFor } from './hook-host';
import { projectOwner } from './owner-console';

const playback = vi.hoisted(() => ({
  startBatch: vi.fn(),
  interrupt: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  subscribe: vi.fn(),
  getState: vi.fn(),
}));
vi.mock('@/services/playbackRuntime', () => ({ getPlaybackManager: () => playback }));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'https://api.test' }));
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const article = (id: string) => ({
  id,
  title: `Owner ${id}`,
  url: `https://source.test/${id}`,
  source: 'source-owner',
  tier: 1,
  status: 'inbox',
  publishedAt: '2026-11-03',
  fetchedAt: '2026-11-03',
  filePath: 'article.md',
  tags: [],
  content: `Full source ${id}`,
});
const artifacts: StudyMeta['artifacts'] = [
  {
    id: 'queued-first',
    kind: 'podcast',
    state: 'queued',
    filePath: 'queued.json',
    createdAt: '2026-11-03T00:00:00Z',
    createdBy: 'owner',
  },
  {
    id: 'ready-podcast',
    kind: 'podcast',
    state: 'ready',
    filePath: 'ready.json',
    createdAt: '2026-11-03T01:00:00Z',
    createdBy: 'owner',
  },
];
let snapshot: PlaybackSnapshot;
let listener: ((value: PlaybackSnapshot) => void) | undefined;
const emit = (patch: Partial<PlaybackSnapshot>) => {
  snapshot = { ...snapshot, ...patch };
  listener?.(snapshot);
};

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  for (const mock of Object.values(playback)) mock.mockReset();
  snapshot = { state: 'idle', source: null, itemIndex: 0, currentTime: 0, duration: 0, playbackRate: 1 };
  listener = undefined;
  playback.getState.mockImplementation(() => snapshot.state);
  playback.startBatch.mockImplementation(async () => emit({ source: 'podcast', state: 'playing', itemIndex: 0 }));
  playback.interrupt.mockImplementation(() => emit({ source: null, state: 'idle' }));
  playback.pause.mockImplementation(() => emit({ state: 'paused' }));
  playback.resume.mockImplementation(() => emit({ state: 'playing' }));
  playback.subscribe.mockImplementation((next) => {
    listener = next;
    next(snapshot);
    return () => {
      listener = undefined;
    };
  });
  useChatStore.setState({ pendingChatInsert: null });
});
afterEach(cleanup);

function mount() {
  const paths: string[] = [],
    writes: { path: string; body: unknown }[] = [];
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    const p = String(path);
    paths.push(p);
    if (init?.method === 'POST') {
      writes.push({ path: p, body: JSON.parse(String(init.body)) });
      return response({ threadId: 'study-owner-thread' });
    }
    if (p === '/api/signals/sources') return response({ sources: [] });
    if (p === '/api/signals/stats') return response({ todayCount: 2, unreadCount: 2, weekCount: 2 });
    if (p.includes('/inbox?')) return response({ items: [article('one'), article('two')] });
    if (p === '/api/signals/collections') return response({ collections: [] });
    const id = p.split('/')[4];
    if (p.endsWith('/study')) return response({ meta: { articleId: id, artifacts, threads: [], collections: [] } });
    if (p.endsWith('/podcast/ready-podcast'))
      return response({
        artifact: artifacts[1],
        script: {
          mode: 'deep',
          totalDuration: 15,
          segments: [
            { speaker: 'Owner A', text: 'First', durationEstimate: 5, audioUrl: '/api/audio/first.wav' },
            { speaker: 'Owner B', text: 'No rendered audio', durationEstimate: 5 },
            { speaker: 'Owner A', text: 'Third', durationEstimate: 5, audioUrl: '/api/audio/third.wav' },
          ],
        },
      });
    return response({ article: article(id) });
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
    playAll: false,
  };
  const { result } = renderHook(() => useSignalBindings(ui, true));
  const detail = () => {
    const vm = projectOwner('signals', result.current, ui).cafeWsSignals;
    if (!('detail' in vm) || !vm.detail) throw new Error('Expected signal detail');
    return vm.detail;
  };
  return { result, ui, detail, paths, writes };
}

it('selects a ready podcast, plays real audio in order, and stops the batch from the original all-play control', async () => {
  const { result, detail, paths, ui } = mount();
  await act(() => result.current.action('signalOpen', { id: 'one' }));
  expect(detail().pods).toEqual([{ v: 0, id: 'ready-podcast', on: true }]);
  expect(detail().podGen).toBe('queued');
  expect(paths.some((p) => p.endsWith('/podcast/queued-first'))).toBe(false);
  await act(() => result.current.action('signalPlayback', {}));
  expect(playback.startBatch).toHaveBeenCalledWith(['/api/audio/first.wav', '/api/audio/third.wav'], apiFetch);
  expect(ui.playAll).toBe(true);
  expect(detail().pod?.playing).toBe(true);
  await act(() => emit({ itemIndex: 1 }));
  expect(detail().pod?.segs[2].playing).toBe(true);
  expect(detail().pod?.segs[1].audio).toBeFalsy();
  await act(() => result.current.action('signalPlayback', {}));
  expect(playback.interrupt).toHaveBeenCalledOnce();
  expect(ui.playAll).toBe(false);
  await act(() => result.current.action('signalPlayback', {}));
  expect(playback.startBatch).toHaveBeenCalledTimes(2);
  expect(detail().pod?.segs[0]).toMatchObject({
    src: 'https://api.test/api/audio/first.wav',
    speaker: 'Owner A',
    text: 'First',
    playing: true,
  });
});

it('plays a single real segment and releases it when the article or audio owner changes', async () => {
  const { result, detail, ui } = mount();
  await act(() => result.current.action('signalOpen', { id: 'one' }));
  await act(() => result.current.action('signalSegment', { i: '2' }));
  expect(playback.startBatch).toHaveBeenCalledWith(['/api/audio/third.wav'], apiFetch);
  expect(detail().pod?.segs[2].playing).toBe(true);
  await act(() => result.current.action('signalSegment', { i: '2' }));
  expect(playback.pause).toHaveBeenCalledOnce();
  await act(() => result.current.action('signalSegment', { i: '2' }));
  expect(playback.resume).toHaveBeenCalledOnce();
  await act(() => result.current.action('signalOpen', { id: 'two' }));
  expect(playback.interrupt).toHaveBeenCalledOnce();
  expect(ui.playAll).toBe(false);
  await act(() => result.current.action('signalPlayback', {}));
  await act(() => emit({ source: 'voice', state: 'playing' }));
  await act(() => result.current.action('signalOpen', { id: 'one' }));
  expect(playback.interrupt).toHaveBeenCalledOnce();
});

it('binds discussion, learning and multi-member research to a real study thread and preserves source in its draft', async () => {
  const { result, writes, ui } = mount();
  await act(() => result.current.action('signalOpen', { id: 'one' }));
  await act(() => result.current.action('wsDiscuss', { k: 'one', v: 'multiCatResearch' }));
  const pending = useChatStore.getState().pendingChatInsert;
  expect(pending?.threadId).toBe('study-owner-thread');
  expect(pending?.text).toContain('多位成员共同研究');
  expect(pending?.text).toContain('https://source.test/one');
  expect(pending?.text).toContain('Full source one');
  expect(writes).toEqual([{ path: '/api/signals/articles/one/discuss', body: {} }]);
  expect(projectOwner('signals', result.current, ui).signalDiscussion).toEqual({
    id: 'study-owner-thread',
    article: 'one',
  });
  await waitFor(() => expect(projectOwner('signals', result.current, ui).cafeWsSignals.load).toBe(''));
});

it('keeps already-enriched and no-better-content receipts successful and exposes a failed fetch', async () => {
  const { result, detail } = mount();
  const read = vi.mocked(apiFetch).getMockImplementation()!;
  let reason = 'already_enriched';
  vi.mocked(apiFetch).mockImplementation(async (path, init) =>
    String(path).endsWith('/enrich') ? response({ enriched: false, reason, contentLength: 15 }) : read(path, init),
  );
  await act(() => result.current.action('signalOpen', { id: 'one' }));
  await act(() => result.current.action('wsSigRefresh', { k: 'one' }));
  reason = 'no_better_content';
  await act(() => result.current.action('wsSigRefresh', { k: 'one' }));
  reason = 'fetch_failed';
  await act(async () => {
    await expect(result.current.action('wsSigRefresh', { k: 'one' })).rejects.toThrow('无法访问原始页面');
  });
  expect(detail().body).toBe('Full source one');
});

it('restarts a segment after the real player becomes idle instead of pausing an empty queue', async () => {
  const { result } = mount();
  await act(() => result.current.action('signalOpen', { id: 'one' }));
  await act(() => result.current.action('signalSegment', { i: '0' }));
  await act(() => emit({ source: 'podcast', state: 'idle' }));
  await act(() => result.current.action('signalSegment', { i: '0' }));
  expect(playback.startBatch).toHaveBeenCalledTimes(2);
  expect(playback.pause).not.toHaveBeenCalled();
});

it('defaults to the newest ready note and keeps note reading choices scoped to each article without writes', async () => {
  const { result, detail, writes, paths } = mount();
  const base = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    const p = String(path),
      id = p.split('/')[4];
    if (p.endsWith('/study'))
      return response({
        meta: {
          articleId: id,
          artifacts: [
            {
              id: `${id}-old`,
              kind: 'note',
              state: 'ready',
              filePath: 'old.md',
              createdAt: '2026-11-01T00:00:00Z',
              createdBy: 'owner',
            },
            {
              id: `${id}-new`,
              kind: 'note',
              state: 'ready',
              filePath: 'new.md',
              createdAt: '2026-11-03T00:00:00Z',
              createdBy: 'owner',
            },
            {
              id: `${id}-queued`,
              kind: 'note',
              state: 'queued',
              filePath: 'pending.md',
              createdAt: '2026-11-04T00:00:00Z',
              createdBy: 'owner',
            },
          ],
          threads: [],
          collections: [],
        },
      });
    if (p.includes('/notes/')) {
      paths.push(p);
      return response({ content: p.split('/').at(-1) + ' body' });
    }
    return base(path, init);
  });
  await act(() => result.current.action('signalOpen', { id: 'one' }));
  expect(detail().noteId).toBe('one-new');
  expect(detail().notes?.map((n: { v: string }) => n.v)).toEqual(['one-new', 'one-old']);
  const latestKey = detail().noteKey;
  await act(() => result.current.action('sigNote', { id: 'one', v: 'one-old' }));
  expect(detail().noteId).toBe('one-old');
  expect(detail().noteSum).toBe('one-old body');
  expect(detail().noteKey).not.toBe(latestKey);
  expect(paths).toContain('/api/signals/articles/one/notes/one-old');
  await act(() => result.current.action('signalOpen', { id: 'two' }));
  expect(detail().noteId).toBe('two-new');
  await act(() => result.current.action('signalOpen', { id: 'one' }));
  expect(detail().noteId).toBe('one-old');
  expect(writes).toEqual([]);
});

it('holds the original source-fetch receipt instead of building its display text', async () => {
  const { result, ui } = mount();
  const previous = vi.mocked(apiFetch).getMockImplementation()!;
  const summary = {
    newArticles: 2,
    fetchedArticles: 3,
    storedArticles: 3,
    duplicateArticles: 1,
    errors: [{ source: 'one', message: 'source unavailable' }],
  };
  vi.mocked(apiFetch).mockImplementation((path, init) =>
    String(path) === '/api/signals/sources/one/fetch' ? Promise.resolve(response({ summary })) : previous(path, init),
  );
  await act(() => result.current.action('wsFetch', { k: 'one' }));
  expect(ui.fetchRes).toEqual(summary);
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([path]) => String(path) === '/api/signals/sources/one/fetch'),
  ).toHaveLength(1);
});
