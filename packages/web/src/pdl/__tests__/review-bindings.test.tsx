import type { ArtifactReviewCommand, ArtifactReviewView, GlobalArtifactDTO, ThreadArtifactDTO } from '@cat-cafe/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appliedResult, initial, REVIEW_ID } from '@/components/content-review/__tests__/review-command.fixture';
import { syncContextAttachmentDraftToStorage } from '@/components/thread-drafts';
import type { ComposerDraftInsert } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { ReviewOwnerBinding, useReviewBindings } from '../useReviewBindings';
import { fixtureUi } from './chat-fixture';
import { act, cleanup, renderHook, waitFor } from './hook-host';
import { useOwnerProjection } from './owner-console';

function useReviewProjection(...args: Parameters<typeof useReviewBindings>) {
  return useOwnerProjection('reviews', useReviewBindings(args[0], args[1], args[2], true), { ui: args[1] });
}

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'https://api.test' }));
const works: ThreadArtifactDTO[] = [
  {
    type: 'image',
    name: 'image.png',
    ref: 'content:content-one',
    catId: 'codex-astra',
    createdAt: 1,
    sourceMessageId: 'message-one',
    url: '/uploads/one.png',
    work: { contentRef: 'content-one', ownerRevision: 1, currentOwnerRevision: 1 },
  },
];
let globalWorks: GlobalArtifactDTO[] = [];
let globalEnabled = false;
let globalPage = { complete: true, loading: false, error: false, hasMore: false, loadingMore: false, stale: false };
const globalLoadMore = vi.fn(),
  globalRestart = vi.fn();
vi.mock('@/hooks/useGlobalArtifacts', () => ({
  useGlobalArtifacts: (enabled: boolean) => {
    globalEnabled = enabled;
    return {
      artifacts: enabled ? globalWorks : [],
      workLineage: 'resolved',
      ...globalPage,
      loadMore: globalLoadMore,
      restart: globalRestart,
    };
  },
}));
vi.mock('@/hooks/useThreadArtifacts', () => ({ useThreadArtifacts: () => ({ works, loading: false, error: false }) }));
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let view: ArtifactReviewView, commands: ArtifactReviewCommand[], failNext: boolean, denied: boolean;
let modifyWrites: Record<string, unknown>[], modificationFails: boolean;
it('reads each widget by exact thread/message/block and retains separate bodies for work tabs', async () => {
  globalWorks = ['block-a', 'block-b'].map((widgetBlockId) => ({
    type: 'widget',
    name: widgetBlockId,
    catId: 'codex',
    createdAt: 1,
    sourceMessageId: 'same-message',
    widgetBlockId,
    threadId: 'source-thread',
    threadTitle: 'Source',
  }));
  const base = vi.mocked(apiFetch).getMockImplementation()!;
  let deniedBlock = '';
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    const url = String(path);
    if (url.startsWith('/api/threads/source-thread/artifacts/same-message/blocks/')) {
      const id = url.split('/').at(-1)!;
      return id === deniedBlock
        ? response({ error: 'widget_block_unavailable' }, 404)
        : response({
            threadId: 'source-thread',
            messageId: 'same-message',
            block: { id, kind: 'html_widget', v: 1, html: '<p>' + id + '</p>' },
          });
    }
    return base(path, init);
  });
  const ui = fixtureUi(),
    hook = renderHook(() => useReviewProjection('thread-one', ui));
  await act(() => hook.result.current.action('worksScope', { v: 'global' }));
  const ids = hook.result.current.project().widgetWorks.map((row: { id: string }) => row.id);
  expect(ids[0]).not.toBe(ids[1]);
  await act(() => hook.result.current.action('workOpen', { id: ids[0] }));
  await act(() => hook.result.current.action('workOpen', { id: ids[1] }));
  expect(ui.lb).toBeNull();
  expect(
    hook.result.current.project().widgetWorks.map((row: { widget: { html: string | null } }) => row.widget.html),
  ).toEqual(['<p>block-a</p>', '<p>block-b</p>']);
  deniedBlock = 'block-b';
  await act(() => hook.result.current.action('cafeWidgetRetry', { k: ids[1] }));
  expect(hook.result.current.project().widgetWorks[1].widget).toMatchObject({ load: 'empty', html: null });
  expect(hook.result.current.project().widgetWorks[0].widget.html).toBe('<p>block-a</p>');
});
it('opens an owned HTML version without message coordinates and retries that same version', async () => {
  const reference = { contentRef: 'work:' + 'a'.repeat(64), ownerRevision: 2 };
  globalWorks = [
    {
      type: 'widget',
      name: 'Fixed HTML',
      ref: reference.contentRef,
      catId: 'codex',
      createdAt: 1,
      sourceMessageId: null,
      threadId: 'source-thread',
      threadTitle: 'Source',
      work: { ...reference, currentOwnerRevision: 2 },
    },
  ];
  const calls: { threadId: string; command: { action: string; reference: typeof reference } }[] = [];
  let unavailable = false;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    expect(path).toBe('/api/works/command');
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    if (unavailable) return response({ error: 'access_denied' }, 403);
    return response(
      body.command.action === 'read'
        ? {
            reference,
            currentOwnerRevision: 2,
            description: { mediaType: 'text/html' },
            version: { title: 'Fixed HTML' },
          }
        : { reference, mediaType: 'text/html', html: '<p>Fixed owner body</p>' },
    );
  });
  const hook = renderHook(() => useReviewProjection('other-thread', fixtureUi()));
  await act(() => hook.result.current.action('worksScope', { v: 'global' }));
  const id = hook.result.current.project().widgetWorks[0].id;
  await act(() => hook.result.current.action('workOpen', { id }));
  expect(hook.result.current.project().widgetWorks[0].widget).toMatchObject({
    load: '',
    html: '<p>Fixed owner body</p>',
  });
  expect(calls).toEqual(
    ['read', 'read-body'].map((action) => ({ threadId: 'source-thread', command: { action, reference } })),
  );
  unavailable = true;
  await act(() => hook.result.current.action('cafeWidgetRetry', { k: id }));
  expect(hook.result.current.project().widgetWorks[0].widget).toMatchObject({ load: 'empty', html: null });
  expect(calls[2]).toEqual(calls[0]);
});
beforeEach(() => {
  localStorage.clear();
  globalWorks = [];
  globalEnabled = false;
  globalPage = { complete: true, loading: false, error: false, hasMore: false, loadingMore: false, stale: false };
  globalLoadMore.mockClear();
  globalRestart.mockClear();
  view = structuredClone(initial);
  commands = [];
  failNext = false;
  denied = false;
  modifyWrites = [];
  modificationFails = false;
  const BaseURL = URL;
  vi.stubGlobal(
    'URL',
    class extends BaseURL {
      static createObjectURL() {
        return 'blob:test-image';
      }
      static revokeObjectURL() {}
    },
  );
  vi.mocked(apiFetch).mockImplementation(async (raw, init) => {
    const path = String(raw),
      method = init?.method ?? 'GET';
    if (path.startsWith('/api/artifact-reviews/context?'))
      return response({
        contexts: [
          {
            taskId: 'task-one',
            title: 'Original task',
            expectedTaskRevision: 1,
            artifactRef: 'content:content-one',
            expectedArtifactRevision: 1,
          },
        ],
      });
    if (path === '/api/content-modifications/choices')
      return response({
        cats: [{ catId: 'codex-astra', name: 'Reviewer', mcpSupport: true, restrictions: [] }],
        threads: [{ threadId: 'thread-one', title: 'Original thread' }],
      });
    if (path === '/api/content-modifications') {
      modifyWrites.push(JSON.parse(String(init?.body)));
      if (modificationFails) {
        modificationFails = false;
        return response({ error: 'unconfirmed_delivery' }, 503);
      }
      return response({ record: { requestId: 'request-one' } });
    }
    if (path === '/api/content-modifications/request-one')
      return response({
        record: { requestId: 'request-one' },
        execution: { state: 'withdrawn_running' },
        candidates: [{ kind: 'text', candidateRef: 'text-result', proposal: {} }],
      });
    if (path === '/api/artifact-reviews/prepare') return response(view);
    if (path === `/api/artifact-reviews/${REVIEW_ID}`)
      return denied ? response({ error: 'access_denied' }, 403) : response(view);
    if (path.includes('/history?')) return response({ entries: [], nextCursor: null });
    if (path.includes('/media/')) return new Response(new Blob(['synthetic image'], { type: 'image/png' }));
    if (path.endsWith('/actions') && method === 'POST') {
      const command = JSON.parse(String(init?.body)) as ArtifactReviewCommand;
      commands.push(command);
      if (failNext) {
        failNext = false;
        return response({ error: 'unavailable' }, 503);
      }
      const next = structuredClone(view),
        round = next.review.rounds.find((r) => r.number === command.round)!;
      if (command.action.kind === 'annotate')
        round.annotations.push({
          id: command.action.annotationId,
          anchor: command.action.anchor,
          body: command.action.body,
          state: 'open',
          author: { kind: 'human', actorId: 'operator' },
          createdAt: '2026-10-17T00:00:00Z',
          updatedAt: '2026-10-17T00:00:00Z',
          replies: [],
          ...(command.action.reanchoredFrom ? { reanchoredFrom: command.action.reanchoredFrom } : {}),
        });
      next.review.revision = command.expectedRevision + 1;
      view = next;
      return response(appliedResult(next, command));
    }
    throw new Error('Unexpected review owner ' + path);
  });
});
afterEach(async () => {
  await cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function openReview() {
  const ui = fixtureUi();
  const hook = renderHook(
    () => useReviewProjection('thread-one', ui),
    (binding) =>
      binding.reviewId ? (
        <ReviewOwnerBinding reviewId={binding.reviewId} round={binding.round} changed={binding.changed} />
      ) : null,
  );
  await act(() => hook.result.current.action('workOpen', { i: '0' }));
  await act(() => hook.result.current.action('workReview', {}));
  await waitFor(() =>
    expect(hook.result.current.project().mediaReview).toHaveProperty(
      'selectedRound',
      view.review.rounds.at(-1)!.number,
    ),
  );
  return { ...hook, ui };
}

it('opens the exact owner after filtering and reordering current-thread works', async () => {
  const original = works.slice();
  const second = {
    ...works[0],
    name: 'filtered-target.png',
    ref: 'content:content-two',
    sourceMessageId: 'message-two',
    work: { contentRef: 'content-two', ownerRevision: 2, currentOwnerRevision: 2 },
  };
  works.push(second);
  try {
    const hook = renderHook(() => useReviewProjection('thread-one', fixtureUi()));
    const model = hook.result.current.project();
    hook.result.current.console.context.S.wkQ = 'filtered-target';
    model.worksState.view = 'cards';
    const shown = hook.result.current.project().works;
    expect(shown.items).toHaveLength(1);
    expect(shown.layout).toBe('cards');
    expect(shown.items[0].args.id).toBe(shown.items[0].id);
    works.reverse();
    await act(() => hook.result.current.action('workOpen', { id: shown.items[0].args.id }));
    expect(hook.result.current.project().work?.title).toBe('filtered-target.png');
    expect(hook.result.current.project().workItems).toHaveLength(2);
  } finally {
    works.splice(0, works.length, ...original);
  }
});
it('keeps a failed annotation on its original operation and exact owner revisions when retried', async () => {
  const hook = await openReview();
  await act(() => hook.result.current.action('workReviewPick', { x: '5', y: '6', width: '10', height: '12' }));
  await act(() => hook.result.current.action('workReviewText', { v: 'retain exact origin' }));
  failNext = true;
  await act(async () => {
    await expect(hook.result.current.action('workReviewAdd', {})).rejects.toThrow('评审未保存');
  });
  await act(() => hook.result.current.action('workReviewAdd', {}));
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  expect(commands[0]).toMatchObject({
    reviewId: REVIEW_ID,
    expectedRevision: 1,
    expectedTaskRevision: 1,
    round: 1,
    action: {
      kind: 'annotate',
      body: 'retain exact origin',
      anchor: { kind: 'image-region', x: 5, y: 6, width: 10, height: 12 },
    },
  });
  expect(hook.result.current.project().mediaReview?.annotations?.[0].body).toBe('retain exact origin');
});
it('retains the same modification operation after unknown delivery and reads execution facts without treating text results as media', async () => {
  const hook = await openReview();
  await act(() => hook.result.current.action('contentModify', { op: 'open' }));
  (hook.ui.contentModification as { prompt: string }).prompt = 'Use the original version';
  modificationFails = true;
  await act(async () => {
    await expect(hook.result.current.action('contentModify', { op: 'submit' })).rejects.toThrow('unconfirmed_delivery');
  });
  expect(hook.result.current.project().contentModification.modification?.canSubmit).toBe(true);
  await act(() => hook.result.current.action('contentModify', { op: 'submit' }));
  expect(modifyWrites[1]).toEqual(modifyWrites[0]);
  expect(modifyWrites[0]).toMatchObject({
    source: { kind: 'artifact-review', reviewId: REVIEW_ID, round: 1 },
    targetCatId: 'codex-astra',
    threadId: 'thread-one',
  });
  expect(hook.result.current.project().contentModification.modification?.state).toBe('withdrawn_running');
  expect(hook.result.current.project().contentModification.modification?.results[0].act).toBe('');
});
it('stops projecting cached review pixels and source attachments after owner access is revoked', async () => {
  const hook = await openReview();
  await waitFor(() => expect(hook.result.current.project().mediaReview?.media?.src).toBe('blob:test-image'));
  denied = true;
  await act(() => hook.result.current.action('refresh', { k: 'review' }));
  expect(hook.result.current.project().discussion).toBeNull();
  expect(hook.result.current.project().mediaReview).not.toHaveProperty('media');
  expect(hook.result.current.project().workPreview?.source).toBeUndefined();
});
it('reanchors an old opinion into the current round without discarding its source identity', async () => {
  view.review.version = 2;
  view.review.rounds[0].annotations = [
    {
      id: 'old',
      body: 'same opinion',
      anchor: { kind: 'image-point', x: 1, y: 2 },
      state: 'open',
      author: { kind: 'human', actorId: 'operator' },
      createdAt: '2026-10-17T00:00:00Z',
      updatedAt: '2026-10-17T00:00:00Z',
      replies: [],
    },
  ];
  const next = structuredClone(view.review.rounds[0]);
  next.number = 2;
  next.asset.ownerRevision = 2;
  next.annotations = [];
  view.review.rounds.push(next);
  const hook = await openReview();
  await act(() => hook.result.current.action('workReviewPrepare', { round: '1' }));
  await act(() => hook.result.current.action('workReviewReanchor', { id: 'old' }));
  await act(() => hook.result.current.action('workReviewPick', { x: '30', y: '40' }));
  await act(() => hook.result.current.action('workReviewAdd', {}));
  expect(commands.at(-1)).toMatchObject({
    round: 2,
    action: {
      body: 'same opinion',
      reanchoredFrom: { round: 1, annotationId: 'old' },
      anchor: { kind: 'image-point', x: 30, y: 40 },
    },
  });
});

it('groups global works by their real thread and opens review context in that owner thread', async () => {
  globalWorks = [
    {
      ...works[0],
      threadId: 'thread-alpha',
      threadTitle: 'Alpha',
      name: 'Alpha image',
      work: { contentRef: 'alpha-content', ownerRevision: 1, currentOwnerRevision: 1 },
    },
    {
      ...works[0],
      threadId: 'thread-beta',
      threadTitle: 'Beta',
      name: 'Beta image',
      work: { contentRef: 'beta-content', ownerRevision: 1, currentOwnerRevision: 1 },
    },
  ];
  const { result } = renderHook(() => useReviewProjection('thread-local', fixtureUi()));
  await act(() => result.current.action('worksScope', { v: 'global' }));
  result.current.project().worksState.group = 'thread';
  const groups = result.current.project().works.groups;
  expect(groups.map((g: { name: string }) => g.name)).toEqual(['Alpha', 'Beta']);
  expect(groups[0].items[0].id).not.toBe(groups[1].items[0].id);
  expect(result.current.project().workItems).toHaveLength(1);
  await act(() => result.current.action('workOpen', { id: groups[1].items[0].id }));
  await act(() => result.current.action('workReview', {}));
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.some(([url]) => String(url).startsWith('/api/artifact-reviews/context?threadId=thread-beta&')),
  ).toBe(true);
  globalWorks = [];
  await act(() => result.current.action('worksBrowse', {}));
  expect(result.current.project().work).toBeNull();
});
it('reads all works globally and retains the selected cross-thread owner when returning to thread works', async () => {
  globalWorks = [
    {
      ...works[0],
      threadId: 'other-thread',
      threadTitle: 'Other thread',
      name: 'global-owner.png',
      work: { contentRef: 'global-owner', ownerRevision: 2, currentOwnerRevision: 2 },
    },
  ];
  const { result } = renderHook(() => useReviewProjection('thread-local', fixtureUi()));
  expect(globalEnabled).toBe(false);
  expect(result.current.project().worksAll).toMatchObject({ load: 'loading', items: [] });
  await act(() => result.current.action('worksPage', { v: 'true' }));
  expect(globalEnabled).toBe(true);
  const model = result.current.project();
  expect(model.worksState.scope).toBe('thread');
  expect(model.worksAll.scope).toBe('global');
  expect(model.worksAll.items.map((r: { name: string }) => r.name)).toEqual(['global-owner.png']);
  expect(model.works.items.map((r: { name: string }) => r.name)).toEqual(['image.png']);
  expect(model.workItems.map((r: { name: string }) => r.name)).toEqual(['image.png']);
  await act(() => result.current.action('workOpen', { id: model.worksAll.items[0].id }));
  expect(result.current.project().work?.title).toBe('global-owner.png');
  await act(() => result.current.action('worksPage', { v: 'false' }));
  expect(globalEnabled).toBe(true);
  expect(result.current.project().work?.title).toBe('global-owner.png');
  expect(result.current.project().works.items.map((r: { name: string }) => r.name)).toEqual(['image.png']);
  await act(() => result.current.action('workClose', {}));
  expect(globalEnabled).toBe(false);
});

it('projects the bounded global page and forwards continuation and restart without draining it', async () => {
  globalWorks = ['alpha', 'beta'].map((threadId) => ({
    ...works[0],
    threadId,
    threadTitle: threadId,
    work: { ...works[0].work!, contentRef: threadId },
  }));
  globalPage = { ...globalPage, complete: false, hasMore: true };
  const ui = fixtureUi(),
    hook = renderHook(() => useReviewProjection('thread-local', ui));
  await act(() => hook.result.current.action('worksScope', { v: 'global' }));
  hook.result.current.project().worksState.group = 'thread';
  expect(hook.result.current.project().works).toMatchObject({
    load: '',
    hasMore: true,
    loadingMore: false,
    stale: false,
    moreError: false,
    groups: [{ last: false }, { last: true }],
  });
  expect(globalLoadMore).not.toHaveBeenCalled();
  await act(() => hook.result.current.action('worksMore', {}));
  expect(globalLoadMore).toHaveBeenCalledOnce();
  globalPage = { ...globalPage, loadingMore: true };
  await act(hook.rerender);
  expect(hook.result.current.project().works).toMatchObject({ load: '', loadingMore: true });
  expect(hook.result.current.project().works.items).toHaveLength(2);
  globalPage = { ...globalPage, loadingMore: false, error: true };
  await act(hook.rerender);
  expect(hook.result.current.project().works).toMatchObject({ load: '', moreError: true });
  expect(hook.result.current.project().works.items).toHaveLength(2);
  globalPage = { ...globalPage, error: false, stale: true };
  await act(hook.rerender);
  expect(hook.result.current.project().works).toMatchObject({ load: '', stale: true });
  await act(() => hook.result.current.action('worksRestart', {}));
  expect(globalRestart).toHaveBeenCalledOnce();
  expect(globalLoadMore).toHaveBeenCalledOnce();
});

it.each([
  'message-one',
  null,
])('places an exact work reference in its source draft without sending (source message %s)', async (mid) => {
  globalWorks = [
    {
      ...works[0],
      work: { contentRef: 'content-one', ownerRevision: 3, currentOwnerRevision: 7 },
      threadId: 'source-thread',
      threadTitle: 'Source',
      sourceMessageId: mid,
    },
  ];
  const ui = fixtureUi(),
    hook = renderHook(() => useReviewProjection('viewing-thread', ui));
  await act(() => hook.result.current.action('worksScope', { v: 'global' }));
  await act(() => hook.result.current.action('workOpen', { id: hook.result.current.project().works.items[0].id }));
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  const paths: string[] = [];
  vi.mocked(apiFetch).mockImplementation(async (path, init, options) => {
    paths.push(String(path));
    return original(path, init, options);
  });
  const receipt = (await act(() => hook.result.current.action('cafeWorkSrc', {}))) as {
    threadId: string;
    mid: string;
    catId: string;
    insert?: ComposerDraftInsert;
  };
  expect(receipt).toMatchObject({ threadId: 'source-thread', mid: mid || '', catId: 'codex-astra' });
  expect(receipt.insert).toEqual({
    threadId: 'source-thread',
    text: '',
    contextAttachments: [
      { id: expect.any(String), v: 1, kind: 'work', workId: 'content-one', version: 3, title: 'image.png' },
    ],
  });
  syncContextAttachmentDraftToStorage('source-thread', receipt.insert!.contextAttachments!);
  const second = (await act(() => hook.result.current.action('cafeWorkSrc', {}))) as typeof receipt;
  expect(second.insert).toBeUndefined();
  expect(paths.filter((path) => path.includes('composer-draft'))).toEqual([]);
  syncContextAttachmentDraftToStorage('source-thread', []);
});
