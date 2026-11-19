import { videoProjectDocumentSchema, workspaceContentReviewSchema } from '@cat-cafe/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listProjects, loadProject, type ProjectSnapshot } from '@/components/workbench/video-project/api';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { digest, project } from '../../../../shared/src/__tests__/video-project.fixtures';
import { screening } from '../../../../shared/src/__tests__/video-project-screening.fixtures';
import { filmPoints, opinionComparison, useFilmBindings } from '../useFilmBindings';
import { act, cleanup, renderHook, waitFor } from './hook-host';
import { useOwnerProjection } from './owner-console';

function useFilmProjection(...args: Parameters<typeof useFilmBindings>) {
  return useOwnerProjection('film', useFilmBindings(args[0], args[1], true), { ws: args[0] });
}

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'https://api.test' }));
vi.mock('@/components/workbench/video-project/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listProjects: vi.fn(),
  loadProject: vi.fn(),
}));
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const snapshots = ['first', 'second'].map(
  (id, i) =>
    ({
      contentRef: id,
      ownerRevision: i + 1,
      blobDigest: digest,
      document: videoProjectDocumentSchema.parse(project()),
    }) satisfies ProjectSnapshot,
);
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listProjects).mockResolvedValue(snapshots);
  vi.mocked(loadProject).mockImplementation(async (id) => snapshots.find((p) => p.contentRef === id)!);
});
afterEach(cleanup);

it('locates scene nodes in the frozen input, including partial mapping, without choosing an unrelated later shot', () => {
  const document = videoProjectDocumentSchema.parse(project()),
    shot = document.timeline.segments[0];
  document.timeline.scenes = [
    { id: 'scene-1', label: 'First scene' },
    { id: 'scene-2', label: 'Second scene' },
    { id: 'empty', label: 'No shot' },
    { id: 'gap', label: 'No mapping' },
    { id: 'trim', label: 'First shot trimmed' },
  ];
  document.timeline.segments = [
    { ...shot, id: 'later', startTick: 90, durationTicks: 5 },
    { ...shot, id: 'shot-1', startTick: 10, durationTicks: 20 },
    { ...shot, id: 'second', sceneId: 'scene-2', startTick: 40, durationTicks: 10 },
    { ...shot, id: 'unmapped', sceneId: 'gap', startTick: 70, durationTicks: 10 },
    { ...shot, id: 'trim-first', sceneId: 'trim', startTick: 0, durationTicks: 10 },
    { ...shot, id: 'trim-later', sceneId: 'trim', startTick: 30, durationTicks: 10 },
  ]
    .map((s) => ({ ...s, visuals: [] }))
    .sort((a, b) => a.startTick - b.startTick);
  const screen = screening();
  screen.mapping.segments = [
    { mediaStartPts: 15360, mediaEndPts: 30720, projectStartTick: 15, projectEndTick: 25, refs: ['first-part'] },
    { mediaStartPts: 46080, mediaEndPts: 61440, projectStartTick: 40, projectEndTick: 60, refs: ['second-part'] },
  ];
  expect(filmPoints({ ...snapshots[0], document: videoProjectDocumentSchema.parse(document) }, screen)).toEqual([
    { key: 'scene-1', label: 'First scene', at: 1 },
    { key: 'scene-2', label: 'Second scene', at: 3 },
  ]);
});

function comparedOwner() {
  const nextDigest = `sha256:${'b'.repeat(64)}`;
  const old = {
    ...screening(),
    id: 'screening-old',
    input: { contentRef: 'first', ownerRevision: 1, blobDigest: digest },
  };
  const next = {
    ...screening(),
    id: 'screening-new',
    operationId: 'register-new',
    input: { contentRef: 'first', ownerRevision: 2, blobDigest: nextDigest },
    media: {
      ...screening().media,
      contentRef: 'media-new',
      blobDigest: nextDigest,
      media: {
        ...screening().media.media,
        timebase: { numerator: 1, denominator: 90000 },
        startTick: 180000,
        durationTicks: 360000,
        containerStartSeconds: 2,
      },
    },
    mapping: {
      ...screening().mapping,
      segments: [
        { mediaStartPts: 180000, mediaEndPts: 480000, projectStartTick: 0, projectEndTick: 100, refs: ['render:new'] },
      ],
    },
  };
  const head = {
    ...snapshots[0],
    ownerRevision: 3,
    document: videoProjectDocumentSchema.parse({ ...project(), screenings: [old, next] }),
  };
  const annotation = (screen: typeof old, id: string) => ({
    id,
    body: id,
    state: 'open',
    author: { kind: 'human', actorId: 'owner' },
    anchor: {
      kind: 'video-project',
      baseRevision: screen.input.blobDigest,
      baseOwnerRevision: screen.input.ownerRevision,
      target: { kind: 'project' },
    },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    projectMessage: {
      source: {
        threadId: 'film-thread',
        messageId: id + '-message',
        messageRevision: digest,
        attachmentId: id + '-attachment',
        selectionId: id + '-selection',
        visibility: 'public',
        whisperTo: [],
      },
      screeningId: screen.id,
      input: screen.input,
      media: {
        contentRef: screen.media.contentRef,
        ownerRevision: screen.media.ownerRevision,
        blobDigest: screen.media.blobDigest,
      },
      sourceState: 'current',
      selection: {
        id: id + '-selection',
        mediaRange: {
          startPts: screen.media.media.startTick + screen.media.media.timebase.denominator / 2,
          endPts: screen.media.media.startTick + screen.media.media.timebase.denominator,
        },
        target: { kind: 'project' },
        displayRegion: {
          coordinateSpace: 'display-pixels',
          width: 1280,
          height: 720,
          rotation: 0,
          bbox: { x: 100, y: 100, width: 200, height: 100 },
        },
      },
    },
  });
  const review = workspaceContentReviewSchema.parse({
    version: 1,
    reviewId: 'review-first',
    ownerUserId: 'owner',
    contentRef: 'first',
    revision: 4,
    source: {
      kind: 'video-project',
      contentRef: 'first',
      ownerRevision: 3,
      revision: digest,
      mime: 'application/vnd.cat-cafe.video-project+json',
    },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    annotations: [
      {
        ...annotation(old, 'opinion-old'),
        projectHistory: [
          {
            kind: 'addressed',
            actor: { kind: 'cat', actorId: 'reviewer' },
            at: new Date(1).toISOString(),
            operationId: 'addressed',
            result: { contentRef: 'first', ownerRevision: 2, blobDigest: nextDigest, operationId: 'new-render' },
          },
        ],
      },
      annotation(next, 'opinion-new'),
      annotation({ ...old, id: 'screening-unrelated' }, 'unrelated-opinion'),
    ],
  });
  vi.mocked(listProjects).mockResolvedValue([head]);
  vi.mocked(loadProject).mockImplementation(async (id, _signal, revision) =>
    id === 'second'
      ? snapshots[1]
      : { ...head, ownerRevision: revision ?? head.ownerRevision, blobDigest: revision === 2 ? nextDigest : digest },
  );
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    const p = String(path);
    if (p.includes('/review/sync-status?')) return response({ pending: 0 });
    if (p.endsWith('/review')) return response({ review });
    const screen = p.endsWith('/screening-old') ? old : next;
    return response({ screening: screen, mediaUrl: p + '/media' });
  });
  useChatStore.setState({ currentThreadId: 'film-thread', pendingChatInsert: null });
  return { old, next, head, review };
}

it.each([false, true])('offers only common scene identities when one side is unmapped: %s', async (unmapped) => {
  comparedOwner();
  const load = vi.mocked(loadProject).getMockImplementation()!;
  vi.mocked(loadProject).mockImplementation(async (id, signal, revision) => {
    const snapshot = await load(id, signal, revision);
    if (revision === undefined) return snapshot;
    const document = videoProjectDocumentSchema.parse(snapshot.document),
      next = revision === 2,
      shot = document.timeline.segments[0],
      sideScene = next ? 'new-only' : 'old-only';
    document.timeline.scenes = [
      { id: 'scene-1', label: next ? 'Renamed common scene' : 'Original common scene' },
      { id: sideScene, label: 'Same name, different identity' },
    ];
    document.timeline.segments = [
      { ...shot, startTick: next ? (unmapped ? 200 : 30) : 0, durationTicks: 20 },
      { ...shot, id: 'side-shot', sceneId: sideScene, startTick: 60, durationTicks: 20 },
    ]
      .map((s) => ({ ...s, visuals: [] }))
      .sort((a, b) => a.startTick - b.startTick);
    return { ...snapshot, document: videoProjectDocumentSchema.parse(document) };
  });
  const { result } = renderHook(() => useFilmProjection({}, 'film-thread'));
  await act(() => result.current.action('filmOpen', { id: 'first' }));
  await act(() =>
    result.current.action('filmOpinionCompare', { id: 'opinion-old', from: 'screening-old', to: 'screening-new' }),
  );
  const model = result.current.project().filmProject!;
  expect(model.compareGroup).toEqual({
    group: 'first',
    hasPoints: !unmapped,
    points: unmapped ? [] : [['scene-1', 'Original common scene']],
  });
  expect(model.media?.points).toContainEqual({ key: 'scene-1', label: 'Original common scene', at: 0 });
  if (!unmapped)
    expect(model.comparison?.points).toContainEqual({ key: 'scene-1', label: 'Renamed common scene', at: 3 });
});

it('compares the exact opinion/result inputs and annotates each side with its own screening and clock', async () => {
  const owner = comparedOwner();
  const { result } = renderHook(() => useFilmProjection({}, 'film-thread'));
  await act(() => result.current.action('filmOpen', { id: 'first' }));
  await act(() => result.current.action('filmScreening', { v: 'screening-old' }));
  expect(result.current.project().filmProject?.opinions.map((a: { id: string }) => a.id)).toEqual(['opinion-old']);
  expect(result.current.project().filmProject?.opinions[0].compare).toEqual({
    from: 'screening-old',
    to: 'screening-new',
  });
  await act(() =>
    result.current.action('filmOpinionCompare', { id: 'opinion-old', from: 'screening-old', to: 'screening-new' }),
  );
  const model = result.current.project().filmProject!;
  expect(model.screening).toBe('screening-old');
  expect(model.compare).toBe('screening-new');
  expect(model.opinions.map((a: { id: string }) => a.id)).toEqual(['opinion-old', 'opinion-new']);
  expect(model.media).toMatchObject({
    canPick: true,
    project: 'first',
    screening: 'screening-old',
    group: 'first',
    points: [{ key: 'scene-1', label: '第一场', at: 0 }],
    marks: [{ label: 'opinion-old', from: 0.5 }],
  });
  expect(model.comparison).toMatchObject({
    canPick: true,
    project: 'first',
    screening: 'screening-new',
    group: 'first',
    points: [{ key: 'scene-1', label: '第一场', at: 2 }],
    marks: [{ label: 'opinion-new', from: 2.5 }],
  });
  expect(model.compareGroup).toEqual({ group: 'first', hasPoints: true, points: [['scene-1', '第一场']] });
  expect(model.media).not.toHaveProperty('sync');
  expect(model.comparison).not.toHaveProperty('sync');
  expect(model.media).not.toHaveProperty('controls', false);
  expect(model.comparison).not.toHaveProperty('controls', false);
  expect(model.opinions[1].location).toEqual({ id: 'film:first:screening-new:reference', at: 2.5 });
  await act(() =>
    result.current.action('filmMark', {
      id: 'first',
      screening: 'screening-new',
      at: '2.5',
      x: '100',
      y: '100',
      width: '200',
      height: '100',
    }),
  );
  expect(useChatStore.getState().pendingChatInsert?.contextAttachments?.[0]).toMatchObject({
    screeningId: 'screening-new',
    input: owner.next.input,
    media: { contentRef: 'media-new', blobDigest: owner.next.media.blobDigest },
    selections: [
      {
        mediaRange: { startPts: 225000, endPts: 225001 },
        displayRegion: { bbox: { x: 100, y: 100, width: 200, height: 100 } },
      },
    ],
  });
  await act(async () => {
    await expect(
      result.current.action('filmMark', { id: 'first', screening: 'screening-old', at: '0.5' }),
    ).rejects.toThrow('一条审片意见只能对应同一版成片');
  });
  expect(useChatStore.getState().pendingChatInsert?.contextAttachments?.[0]).toMatchObject({
    screeningId: 'screening-new',
    input: owner.next.input,
  });
  useChatStore.setState({ pendingChatInsert: null });
  await act(() => result.current.action('filmMark', { id: 'first', screening: 'screening-old', at: '0.5' }));
  expect(useChatStore.getState().pendingChatInsert?.contextAttachments?.[0]).toMatchObject({
    screeningId: 'screening-old',
    input: owner.old.input,
    selections: [{ mediaRange: { startPts: 7680, endPts: 7681 } }],
  });
  await act(() =>
    result.current.action('filmOpinionShow', { id: 'opinion-new', project: 'first', screening: 'screening-new' }),
  );
  expect(result.current.project().filmProject).toMatchObject({
    tab: 'review',
    screening: 'screening-old',
    compare: 'screening-new',
    opinions: [{ cur: false }, { cur: true }],
  });
  await act(() => result.current.action('filmCompare', { v: '' }));
  expect(result.current.project().filmProject).toMatchObject({
    compareGroup: null,
    media: { group: null, points: null },
  });
  await act(async () => {
    await expect(
      result.current.action('filmMark', { id: 'first', screening: 'screening-new', at: '0.5' }),
    ).rejects.toThrow('重新选择');
  });
  expect(vi.mocked(apiFetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.some(([p]) => String(p).includes('synchronize') || String(p).includes('modification')),
  ).toBe(false);
  useChatStore.setState({ pendingChatInsert: null });
});

it('previews either frozen screening with its own annotations without replacing the comparison or writing review', async () => {
  const owner = comparedOwner(),
    workbench = { clipPreview: null as unknown };
  const { result } = renderHook(() => useFilmProjection(workbench, 'film-thread'));
  await act(() => result.current.action('filmOpen', { id: 'first' }));
  await act(() =>
    result.current.action('filmOpinionCompare', { id: 'opinion-old', from: 'screening-old', to: 'screening-new' }),
  );
  await act(() => result.current.action('filmPreview', { id: 'first', screening: 'screening-new' }));
  expect(result.current.project().filmProject).toMatchObject({ screening: 'screening-old', compare: 'screening-new' });
  expect(result.current.project().filmPreview).toMatchObject({
    media: {
      id: 'film:first:screening-new:preview',
      group: null,
      points: null,
      canPick: true,
      project: 'first',
      screening: 'screening-new',
      marks: [{ label: 'opinion-new', from: 2.5 }],
    },
  });
  await act(() => result.current.action('filmMark', { id: 'first', screening: 'screening-new', at: '2.5' }));
  expect(useChatStore.getState().pendingChatInsert?.contextAttachments?.[0]).toMatchObject({
    screeningId: 'screening-new',
    input: owner.next.input,
  });
  expect(result.current.project().filmPreview).toBeNull();
  useChatStore.setState({ pendingChatInsert: null });
  await act(() => result.current.action('filmPreview', { id: 'first', screening: 'screening-old' }));
  expect(result.current.project().filmPreview).toMatchObject({
    media: { marks: [{ label: 'opinion-old', from: 0.5 }] },
  });
  await act(() => result.current.action('filmScreening', { v: 'screening-new' }));
  expect(result.current.project().filmPreview).toBeNull();
  expect(vi.mocked(apiFetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
});

it('does not reopen an old preview after the user switches the frozen screening while review is loading', async () => {
  comparedOwner();
  const workbench = { clipPreview: null as unknown };
  const { result } = renderHook(() => useFilmProjection(workbench, 'film-thread'));
  await act(() => result.current.action('filmOpen', { id: 'first' }));
  const read = vi.mocked(apiFetch).getMockImplementation()!;
  let release!: () => void,
    once = true,
    pending!: Promise<boolean>;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (once && String(path).endsWith('/review')) {
      once = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return read(path, init);
  });
  await act(async () => {
    pending = result.current.action('filmPreview', { id: 'first', screening: 'screening-new' });
    await Promise.resolve();
  });
  await act(() => result.current.action('filmScreening', { v: 'screening-old' }));
  await act(async () => {
    release();
    await pending;
  });
  expect(result.current.project().filmProject?.screening).toBe('screening-old');
  expect(result.current.project().filmPreview).toBeNull();
});

it('does not infer a new screening from an unchanged, reopened, foreign or mismatched result', () => {
  const { review, head } = comparedOwner(),
    annotation = review.annotations[0],
    addressed = annotation.projectHistory![0];
  const compare = (result: NonNullable<typeof addressed.result>) =>
    opinionComparison({ ...annotation, projectHistory: [{ ...addressed, result }] }, head);
  expect(compare({ kind: 'not-changed', reason: 'Keep the original' })).toBeNull();
  expect(
    compare({
      contentRef: 'another-project',
      ownerRevision: 2,
      blobDigest: head.blobDigest,
      operationId: 'other-result',
    }),
  ).toBeNull();
  expect(
    compare({ contentRef: 'first', ownerRevision: 2, blobDigest: head.blobDigest, operationId: 'wrong-digest' }),
  ).toBeNull();
  expect(compare({ assetVersionRef: 'asset-only', ownerRevision: 2 })).toBeNull();
  expect(
    opinionComparison(
      { ...annotation, projectHistory: [...annotation.projectHistory!, { ...addressed, kind: 'reopened' }] },
      head,
    ),
  ).toBeNull();
});

it('keeps both shown inputs unchanged when the comparison read fails and refuses stale comparison args', async () => {
  const owner = comparedOwner();
  const { result } = renderHook(() => useFilmProjection({}, 'film-thread'));
  await act(() => result.current.action('filmOpen', { id: 'first' }));
  await act(() => result.current.action('filmScreening', { v: 'screening-old' }));
  await act(async () => {
    await expect(
      result.current.action('filmOpinionCompare', { id: 'opinion-old', from: 'screening-new', to: 'screening-old' }),
    ).rejects.toThrow('已变化');
  });
  const load = vi.mocked(loadProject).getMockImplementation()!;
  vi.mocked(loadProject).mockImplementation(async (id, signal, revision) => ({
    ...(await load(id, signal, revision)),
    ...(revision === 2 ? { blobDigest: owner.head.blobDigest } : {}),
  }));
  await act(async () => {
    await expect(
      result.current.action('filmOpinionCompare', { id: 'opinion-old', from: 'screening-old', to: 'screening-new' }),
    ).rejects.toThrow('输入版本不一致');
  });
  expect(result.current.project().filmProject).toMatchObject({ screening: 'screening-old', comparison: null });
});

it('freezes registration input and media source across a lost reply and retains a later selected project', async () => {
  const commands: Record<string, unknown>[] = [];
  let probes = 0,
    acknowledge!: () => void;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (String(path).endsWith('/review')) {
      const contentRef = String(path).split('/')[3];
      return response({
        review: {
          version: 1,
          reviewId: 'review-' + contentRef,
          ownerUserId: 'human',
          contentRef,
          revision: 1,
          annotations: [],
          source: {
            kind: 'video-project',
            contentRef,
            ownerRevision: 1,
            revision: digest,
            mime: 'application/vnd.cat-cafe.video-project+json',
          },
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      });
    }
    if (path === '/api/video-projects/media-source') {
      probes++;
      return response({
        locator: { worktreeId: 'wt-owner', path: 'movie.mp4' },
        revision: digest,
        media: screening().media.media,
      });
    }
    if (String(path).endsWith('/screenings')) {
      commands.push(JSON.parse(String(init?.body)));
      if (commands.length === 1) return response({ error: 'reply lost' }, 503);
      await new Promise<void>((r) => {
        acknowledge = r;
      });
      return response({ ok: true });
    }
    if (String(path).includes('/operations/')) return response({ receipt: null });
    throw new Error(String(path));
  });
  const { result } = renderHook(() => useFilmProjection({}));
  await waitFor(() => expect(result.current.project().cafeWsClips.load).toBe(''));
  await act(() => result.current.action('filmOpen', { id: 'first' }));
  const intent = {
    project: snapshots[0],
    worktreeId: 'wt-owner',
    path: 'movie.mp4',
    title: 'Owner screening',
    mapping: null,
    attempt: 'owner-dialog',
  } as unknown as Record<string, string>;
  await act(async () => {
    await expect(result.current.action('filmRegister', intent)).rejects.toThrow();
  });
  let retry!: Promise<boolean>;
  await act(() => {
    retry = result.current.action('filmRegister', intent);
  });
  await waitFor(() => expect(commands).toHaveLength(2));
  expect(commands[1]).toEqual(commands[0]);
  expect(probes).toBe(1);
  expect(commands[0].input).toEqual({ contentRef: 'first', ownerRevision: 1, blobDigest: digest });
  await act(() => result.current.action('filmOpen', { id: 'second' }));
  await act(async () => {
    acknowledge();
    await retry;
  });
  expect(result.current.project().filmOwner?.contentRef).toBe('second');
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => String(path).includes('/synchronize'))).toBe(false);
});

it('reads pending imports without writing and only synchronizes all owner pages after the explicit action', async () => {
  comparedOwner();
  const base = vi.mocked(apiFetch).getMockImplementation()!;
  const writes: unknown[] = [];
  let pending = 2;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (String(path).includes('/review/sync-status?')) return response({ pending });
    if (String(path).endsWith('/synchronize')) {
      writes.push(JSON.parse(String(init?.body)));
      const hasMore = writes.length < 2;
      if (!hasMore) pending = 0;
      return response({ imported: 1, scanned: 100, hasMore });
    }
    return base(path, init);
  });
  const { result } = renderHook(() => useFilmProjection({}, 'film-thread'));
  await act(() => result.current.action('filmOpen', { id: 'first' }));
  await act(() => result.current.action('filmRefresh', { id: 'first' }));
  expect(result.current.project().filmProject?.sync?.pending).toBe(2);
  expect(writes).toEqual([]);
  await act(() => result.current.action('filmSync', { id: 'first' }));
  expect(writes).toEqual([{ threadId: 'film-thread' }, { threadId: 'film-thread' }]);
  expect(result.current.project().filmProject?.sync).toBeNull();
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/video-projects/first/review/sync-status?threadId=film-thread',
    { signal: expect.any(AbortSignal) },
    undefined,
  );
});

it('keeps pending source work visible after a rejected import and lets the owner cursor resume on retry', async () => {
  comparedOwner();
  const base = vi.mocked(apiFetch).getMockImplementation()!;
  let reject = true;
  let pending = 1;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (String(path).includes('/review/sync-status?')) return response({ pending });
    if (String(path).endsWith('/synchronize')) {
      if (reject) return response({ error: 'source_changed' }, 409);
      pending = 0;
      return response({ imported: 1, scanned: 1, hasMore: false });
    }
    return base(path, init);
  });
  const { result } = renderHook(() => useFilmProjection({}, 'film-thread'));
  await act(() => result.current.action('filmOpen', { id: 'first' }));
  const original = result.current.project().filmProject;
  await act(async () => {
    await expect(result.current.action('filmSync', { id: 'first' })).rejects.toThrow('原消息或素材已变化');
  });
  expect(result.current.project().filmProject).toEqual(original);
  reject = false;
  await act(() => result.current.action('filmSync', { id: 'first' }));
  expect(result.current.project().filmProject?.sync).toBeNull();
});

it('imports a chosen document through its real owner and revalidates the project list', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response({ ok: true }));
  const { result } = renderHook(() => useFilmProjection({}));
  await waitFor(() => expect(result.current.project().cafeWsClips.load).toBe(''));
  await act(() =>
    result.current.action('filmImport', {
      operationId: 'owner-import',
      document: snapshots[0].document,
    } as unknown as Record<string, string>),
  );
  const [path, init] = vi.mocked(apiFetch).mock.calls[0];
  expect(path).toBe('/api/video-projects');
  expect(JSON.parse(String(init?.body))).toEqual({ operationId: 'owner-import', document: snapshots[0].document });
  expect(listProjects).toHaveBeenCalledTimes(2);
});

it('reads actual opinions, compares frozen inputs, queues a position without writing review, and confirms a lost reopen reply', async () => {
  const old = {
    ...screening(),
    id: 'old-screening',
    input: { ...screening().input, contentRef: 'first', ownerRevision: 1 },
  };
  const current = {
    ...screening(),
    id: 'current-screening',
    operationId: 'register-current',
    input: { ...screening().input, contentRef: 'first', ownerRevision: 2 },
  };
  const document = videoProjectDocumentSchema.parse({ ...project(), screenings: [old, current] });
  const head = { ...snapshots[0], ownerRevision: 3, document };
  vi.mocked(listProjects).mockResolvedValue([head]);
  vi.mocked(loadProject).mockImplementation(async (_id, _signal, revision) => ({
    ...head,
    ownerRevision: revision ?? 3,
  }));
  let review = workspaceContentReviewSchema.parse({
    version: 1,
    reviewId: 'review-first',
    ownerUserId: 'human',
    contentRef: 'first',
    revision: 4,
    source: {
      kind: 'video-project',
      contentRef: 'first',
      ownerRevision: 3,
      revision: digest,
      mime: 'application/vnd.cat-cafe.video-project+json',
    },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    annotations: [
      {
        id: 'opinion-owner',
        body: 'Owner opinion',
        state: 'resolved',
        author: { kind: 'human', actorId: 'owner' },
        anchor: { kind: 'video-project', baseRevision: digest, baseOwnerRevision: 2, target: { kind: 'project' } },
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        projectHistory: [
          {
            kind: 'addressed',
            actor: { kind: 'cat', actorId: 'reviewer' },
            at: new Date(0).toISOString(),
            operationId: 'owner-address',
            result: { kind: 'not-changed', reason: 'Owner evidence says keep' },
          },
        ],
      },
    ],
  });
  const writes: unknown[] = [];
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    const p = String(path);
    if (p.includes('/review/sync-status?')) return response({ pending: 0 });
    if (p.endsWith('/review')) return response({ review });
    if (p.endsWith('/review/actions')) {
      writes.push(JSON.parse(String(init?.body)));
      review = {
        ...review,
        revision: 5,
        annotations: [
          {
            ...review.annotations[0],
            state: 'open',
            projectHistory: [
              ...review.annotations[0].projectHistory!,
              {
                kind: 'reopened',
                actor: { kind: 'human', actorId: 'owner' },
                at: new Date(1).toISOString(),
                operationId: 'reopen-owner',
                reason: 'Owner followup',
              },
            ],
          },
        ],
      };
      return response({ error: 'reply lost' }, 503);
    }
    if (p.includes('/review/operations/')) return response({ receipt: { operationId: 'reopen-owner' } });
    const item = p.endsWith('/old-screening') ? old : current;
    return response({ screening: item, mediaUrl: p + '/media' });
  });
  useChatStore.setState({ currentThreadId: 'film-thread', pendingChatInsert: null });
  const { result } = renderHook(() => useFilmProjection({}, 'film-thread'));
  await act(() => result.current.action('filmOpen', { id: 'first' }));
  expect(result.current.project().filmProject).toMatchObject({
    opinions: [
      {
        id: 'opinion-owner',
        title: 'Owner opinion',
        last: expect.objectContaining({ kind: 'addressed', unchanged: true }),
        canReopen: true,
      },
    ],
  });
  await act(() => result.current.action('filmCompare', { v: 'old-screening' }));
  expect(result.current.project().filmProject?.comparison).toMatchObject({
    group: 'first',
    points: [{ key: 'scene-1', label: '第一场', at: 0 }],
  });
  expect(result.current.project().filmProject?.comparison?.src).toContain('old-screening/media');
  await act(() => result.current.action('filmMark', { id: 'first', screening: 'current-screening', at: '0.5' }));
  expect(writes).toEqual([]);
  const attachment = useChatStore.getState().pendingChatInsert?.contextAttachments?.[0];
  expect(attachment).toMatchObject({
    kind: 'project-screening',
    contentRef: 'first',
    screeningId: 'current-screening',
    input: current.input,
    selections: [{ mediaRange: { startPts: 7680, endPts: 7681 } }],
  });
  await act(() =>
    result.current.action('filmReopen', {
      project: 'first',
      id: 'opinion-owner',
      revision: '4',
      reason: 'Owner followup',
      operationId: 'reopen-owner',
    }),
  );
  expect(writes).toEqual([
    {
      expectedRevision: 4,
      operationId: 'reopen-owner',
      action: { kind: 'reopened', annotationId: 'opinion-owner', reason: 'Owner followup' },
    },
  ]);
  expect(result.current.project().filmProject?.opinions[0].state).toBe('open');
  expect(vi.mocked(apiFetch).mock.calls.some(([p]) => String(p).includes('/synchronize'))).toBe(false);
  useChatStore.setState({ pendingChatInsert: null });
});
