'use client';
import {
  type ArtifactReviewAnchor,
  type ArtifactReviewView,
  artifactReviewActionSchema,
  type ContentModificationChoices,
  type ContentModificationDetailView,
  type ContentModificationRequest,
  contentModificationRequestContractSchema,
  type PreparedMediaReviewContext,
  projectFileContent,
  projectThreadWorks,
  type ThreadArtifactDTO,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { artifactContentSource, prRefToUrl } from '@/components/artifacts/artifact-view';
import { readWorkContent, Unavailable as WorkUnavailable } from '@/components/artifacts/work-content-client';
import { composerAttachments } from '@/components/composer-queue';
import {
  artifactRoundChatTarget,
  artifactRoundRequestSource,
} from '@/components/content-review/artifact-modification-source';
import { contentFileInfo, fileSourceUrl } from '@/components/content-review/file-action-client';
import { contentFileUrl } from '@/components/content-review/file-source';
import { useArtifactReview } from '@/components/content-review/useArtifactReview';
import { useReviewMediaSource } from '@/components/content-review/useReviewMediaSource';
import { useArtifactContent } from '@/hooks/useArtifactContent';
import { readArtifactWidgetBlock, type WidgetBlockState } from '@/hooks/useArtifactWidgetBlock';
import { useGlobalArtifacts } from '@/hooks/useGlobalArtifacts';
import { useThreadArtifacts } from '@/hooks/useThreadArtifacts';
import type { FileData } from '@/hooks/useWorkspace';
import { useChatStore } from '@/stores/chatStore';
import { request, write } from './owner-api';
import type { ChatUiState } from './types';

type ScopedWork = ThreadArtifactDTO & { threadId?: string; threadTitle?: string };
export function workKey(work: ScopedWork) {
  return JSON.stringify([
    work.work?.contentRef,
    work.work?.ownerRevision,
    work.ref,
    work.sourceMessageId,
    work.publicationItem,
    work.threadId,
    ...(work.type === 'widget' ? [work.widgetBlockId] : []),
  ]);
}
function sourceWork<T extends ScopedWork>(work: T, worktreeId: string | null) {
  const fileSource = artifactContentSource(work, worktreeId);
  return {
    ...work,
    navigationId: workKey(work),
    sourceFacts: {
      content: projectFileContent(work),
      fileSource,
      fileUrl: fileSource.kind === 'none' ? null : fileSourceUrl(fileSource),
      mediaUrl: work.url ? contentFileUrl(work.url) : null,
      prUrl: work.type === 'pr' ? prRefToUrl(work.ref) : undefined,
    },
  };
}
interface ReviewDraft {
  annotationId?: string;
  body: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  at?: number;
  from?: number;
  until?: number;
  reanchoredFrom?: unknown;
}
interface ReviewUi {
  work: string;
  round: number | null;
  draft: ReviewDraft | null;
  edit: string | null;
  compare: number | null;
  markup: unknown[] | null;
  focusAnchor?: ArtifactReviewAnchor;
  focusVersion?: number;
}
type Context = PreparedMediaReviewContext;
interface Snapshot {
  controller: ReturnType<typeof useArtifactReview>;
  round: number;
  src: string | null;
  download: string | null;
}
export function ReviewOwnerBinding({
  reviewId,
  round,
  generation = 1,
  changed,
}: {
  reviewId: string;
  generation?: number;
  round: number | null;
  changed: (snapshot: Snapshot) => void;
}) {
  const controller = useArtifactReview(reviewId, generation),
    selected = controller.view?.review.rounds.find((r) => r.number === round) ?? controller.view?.review.rounds.at(-1);
  const media = useReviewMediaSource(
    reviewId,
    selected?.number ?? 1,
    controller.revokeAccess,
    selected?.asset.mediaType,
  );
  const scope = reviewId + ':' + selected?.number,
    readScope = useRef(scope);
  useEffect(() => {
    readScope.current = scope;
  }, [scope]);
  useLayoutEffect(() => {
    if (controller.loading && !controller.view) return;
    changed({
      controller,
      round: selected?.number ?? 1,
      src: selected && scope === readScope.current ? media.src : null,
      download: selected && scope === readScope.current ? media.downloadSrc : null,
    });
  });
  return null;
}
export function reviewAnchor(
  draft: ReviewDraft,
  media: ArtifactReviewView['review']['rounds'][number]['asset']['media'],
) {
  const point = {
    x: draft.x,
    y: draft.y,
    ...(draft.width && draft.height ? { width: draft.width, height: draft.height } : {}),
  };
  if (media.kind === 'image') return { kind: draft.width && draft.height ? 'image-region' : 'image-point', ...point };
  const tick = (s: number) =>
    Math.round(((s + media.containerStartSeconds) * media.timebase.denominator) / media.timebase.numerator);
  return {
    kind: 'video-range',
    streamId: media.streamId,
    startTick: tick(draft.from!),
    endTick: tick(draft.until!),
    [draft.width && draft.height ? 'frameRegion' : 'framePoint']: { ...point, tick: tick(draft.at!) },
  };
}
export function useReviewBindings(
  threadId: string,
  ui: ChatUiState,
  recentOwners: ScopedWork[] = [],
  needed: boolean | number = false,
  globalNeeded = needed,
) {
  const ownerEpoch = useRef(0),
    historySequence = useRef(0),
    compareSequence = useRef(0);
  const artifacts = useThreadArtifacts(threadId, 'works', needed);
  const [widgets, setWidgets] = useState<Record<string, { work: ScopedWork; state: WidgetBlockState }>>({});
  const [, browseChanged] = useState(0);
  const worksReading = useRef({ f: 'all', view: 'list', scope: 'thread', group: 'time', cat: '', page: false });
  const textReading = useRef({ mode: 'render' });
  const [openedWork, setOpenedWork] = useState<{
    artifact: ScopedWork;
    reference?: ThreadArtifactDTO['work'];
  } | null>(null);
  const work = openedWork?.artifact ?? null;
  const worktreeId = useChatStore((s) => s.workspaceWorktreeId);
  const globalEnabled =
    ui.pop?.kind === 'ctx' ||
    worksReading.current.scope === 'global' ||
    worksReading.current.page ||
    (!!work && work.threadId !== threadId) ||
    Object.values(widgets).some((entry) => entry.work.threadId !== threadId);
  const global = useGlobalArtifacts(globalEnabled ? globalNeeded || 1 : false, { view: 'works' }, undefined, {
    paused: !globalNeeded,
  });
  const globalSources = useMemo(
    () => global.artifacts.map((work) => sourceWork(work, worktreeId)),
    [global.artifacts, worktreeId],
  );
  const localWorks = useMemo(
    () => artifacts.works.map((work) => sourceWork({ ...work, threadId }, worktreeId)),
    [artifacts.works, threadId, worktreeId],
  );
  const globalWorks = useMemo(
    () =>
      projectThreadWorks(global.artifacts, global.workLineage === 'resolved').map((work) =>
        sourceWork(work, worktreeId),
      ),
    [global.artifacts, global.workLineage, worktreeId],
  );
  const recentSources = useMemo(
    () => recentOwners.map((work) => sourceWork(work, worktreeId)),
    [recentOwners, worktreeId],
  );
  const catalogue = globalEnabled ? globalWorks : localWorks;
  const [workMetadata, setWorkMetadata] = useState<Partial<
      Pick<FileData, 'mime' | 'size' | 'modifiedAt' | 'pageCount' | 'pageUnit'>
    > | null>(null),
    [reviewId, setReviewId] = useState<string | null>(null),
    [contexts, setContexts] = useState<Context[]>([]),
    [load, setLoad] = useState('');
  const workKind = work ? projectFileContent(work).kind : null;
  const text = useArtifactContent(work, worktreeId, !!work && ['text', 'markdown', 'html', 'jsx'].includes(workKind!));
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [history, setHistory] = useState<{
      entries: { kind: string; receipt: { createdAt: string } }[];
      nextCursor: number | null;
    }>({ entries: [], nextCursor: null });
  const [round, setRound] = useState<number | null>(null),
    [historyLoad, setHistoryLoad] = useState(''),
    [compareSrc, setCompareSrc] = useState<string | null>(null),
    [error, setError] = useState('');
  const modification = useRef<{
    source?: ContentModificationRequest['source'];
    choices?: ContentModificationChoices;
    place: string;
    taskContext?: unknown;
    prompt: string;
    targetId: string;
    threadId: string;
    imageEdit: { kind: string; ratio: string };
    view?: ContentModificationDetailView;
    requestId?: string;
    operation?: unknown;
    load: string;
  } | null>(null);
  const changed = useCallback(
    (next: Snapshot) =>
      setSnapshot((old) =>
        old?.controller.view === next.controller.view &&
        old?.controller.error === next.controller.error &&
        old?.controller.loading === next.controller.loading &&
        old?.controller.saving === next.controller.saving &&
        old?.src === next.src &&
        old?.round === next.round
          ? old
          : next,
      ),
    [],
  );
  const selectionForChat = useRef<{
    target: NonNullable<ReturnType<typeof artifactRoundChatTarget>>;
    anchor: ArtifactReviewAnchor;
    words: string;
  }>();
  const state = () => ui.review as ReviewUi | null | undefined;
  const prepare = async (context: Context, stamp = ownerEpoch.current) => {
    const { title, ...source } = context;
    void title;
    const result = await write<ArtifactReviewView>('/api/artifact-reviews/prepare', {
      ...source,
      operationId: crypto.randomUUID(),
    });
    if (stamp !== ownerEpoch.current) return;
    setReviewId(result.review.reviewId);
    setRound(null);
  };
  useEffect(
    () => () => {
      if (compareSrc) URL.revokeObjectURL(compareSrc);
    },
    [compareSrc],
  );
  const view = snapshot?.controller.view?.review.reviewId === reviewId ? snapshot.controller.view : null;
  const currentRound = () =>
    view?.review.rounds.find((r) => r.number === (state()?.round ?? snapshot?.round)) ?? view?.review.rounds.at(-1);
  const requestSources = useMemo(
    () =>
      Object.fromEntries(
        (view?.review.rounds ?? []).map((round) => [round.number, artifactRoundRequestSource(view!, round)]),
      ),
    [view],
  );
  const historyRead = async (more = false) => {
    if (!reviewId) return;
    const ticket = ++historySequence.current;
    setHistoryLoad('loading');
    try {
      const result = await request<typeof history>(
        `/api/artifact-reviews/${encodeURIComponent(reviewId)}/history?${new URLSearchParams({ afterRevision: String(more ? (history.nextCursor ?? 0) : 0), limit: '10' })}`,
      );
      if (ticket === historySequence.current) {
        setHistory(more ? { ...result, entries: [...history.entries, ...result.entries] } : result);
        setHistoryLoad('');
      }
    } catch (error) {
      if (ticket === historySequence.current) setHistoryLoad('error');
      throw error;
    }
  };
  useEffect(() => {
    if (needed && reviewId) void historyRead().catch((e) => setError(e.message));
  }, [needed, reviewId, view?.review.revision]);
  const act = async (action: unknown, number = currentRound()?.number) => {
    if (!snapshot || number === undefined) throw new Error('请重新读取评审');
    const parsed = artifactReviewActionSchema.parse(action),
      pending = snapshot.controller.pending;
    const result =
      pending && JSON.stringify(pending.action) === JSON.stringify(parsed) && pending.round === number
        ? await snapshot.controller.retry()
        : await snapshot.controller.act(parsed, number);
    if (!result) throw new Error('评审未保存，请核对原版本或重试原操作');
  };
  const action = async (name: string, args: Record<string, string>): Promise<unknown> => {
    const s = state(),
      r = currentRound();
    switch (name) {
      case 'worksPage':
        worksReading.current.page = args.v === 'true';
        browseChanged((n) => n + 1);
        return true;
      case 'worksScope':
        worksReading.current.scope = args.v;
        browseChanged((n) => n + 1);
        return true;
      case 'worksMore':
        global.loadMore!();
        return true;
      case 'worksRestart':
        global.restart!();
        return true;
      case 'worksBrowse':
        browseChanged((n) => n + 1);
        return true;
      case 'workClose':
        ownerEpoch.current++;
        historySequence.current++;
        compareSequence.current++;
        setOpenedWork(null);
        ui.review = null;
        setReviewId(null);
        return true;
      case 'cafeWorkSrc': {
        const source = args.id ? widgets[args.id].work : work;
        if (!source) throw new Error('作品已变化');
        const sourceThread = source.threadId || threadId;
        const reference = source.work;
        // The work goes into that conversation's input once; the input adds it to its draft.
        const insert =
          reference &&
          !composerAttachments(sourceThread).some(
            (attachment) => attachment.kind === 'work' && attachment.workId === reference.contentRef,
          )
            ? {
                threadId: sourceThread,
                text: '',
                contextAttachments: [
                  {
                    id: crypto.randomUUID(),
                    v: 1 as const,
                    kind: 'work' as const,
                    workId: reference.contentRef,
                    version: reference.ownerRevision,
                    title: source.name,
                  },
                ],
              }
            : undefined;
        return { threadId: sourceThread, mid: source.sourceMessageId || '', catId: source.catId, insert };
      }
      case 'workReviewDiscuss': {
        const source = view && r && artifactRoundRequestSource(view, r);
        return source && view && r
          ? {
              threadId: view.review.task.threadId,
              target: view.authority.ownerCatId,
              attachment: {
                v: 1,
                kind: 'media',
                title: view.review.title,
                mediaType: r.asset.mediaType,
                source: source.source,
                selections: [],
                taskContext: source.taskContext,
              },
            }
          : false;
      }
      case 'workSelectionPrepare': {
        const stamp = ownerEpoch.current;
        const pick = ui.lb?.selection;
        if (!work || !pick) throw new Error('请先选择图片区域');
        const response = await request<{ contexts: Context[] }>(
          `/api/artifact-reviews/context?${new URLSearchParams({ threadId: work.threadId || threadId, artifactRef: work.ref ?? work.url ?? '' })}`,
        );
        if (response.contexts.length !== 1) throw new Error('请先选择作品评审的任务');
        const { title, ...context } = response.contexts[0];
        void title;
        const view = await write<ArtifactReviewView>('/api/artifact-reviews/prepare', {
            ...context,
            operationId: crypto.randomUUID(),
          }),
          round = view.review.rounds.at(-1)!,
          target = artifactRoundChatTarget(view, round, work.name);
        if (stamp !== ownerEpoch.current) throw new Error('作品选择已变化');
        if (!target) throw new Error('作品原版本尚未确认');
        selectionForChat.current = {
          target,
          anchor: reviewAnchor(
            { ...pick, body: '', ...(pick.at !== undefined ? { from: pick.at, until: pick.at + 1 } : {}) },
            round.asset.media,
          ) as ArtifactReviewAnchor,
          words: ui.lb?.words ?? '',
        };
        browseChanged((n) => n + 1);
        return selectionForChat.current;
      }
      case 'cafeWidgetRetry':
      case 'workOpen': {
        const stamp = ++ownerEpoch.current;
        historySequence.current++;
        compareSequence.current++;
        const key = args.id || args.k;
        const reference =
          args.i && args.i[0] === '{'
            ? (JSON.parse(args.i) as { contentRef: string; threadId: string; ownerRevision?: number })
            : null;
        const exact = reference
          ? await request<{ artifact: ThreadArtifactDTO }>(
              '/api/works/resolve-file?' +
                new URLSearchParams({
                  threadId: reference.threadId,
                  contentRef: reference.contentRef,
                  ownerRevision: String(args.rev || reference.ownerRevision),
                }),
            )
          : null;
        const found = exact
          ? { ...exact.artifact, threadId: reference!.threadId }
          : key
            ? [...localWorks, ...globalWorks, ...recentOwners].find((w) =>
                [workKey(w), w.ref, w.work?.contentRef].includes(key),
              )
            : catalogue[+args.i];
        if (!found) throw new Error('作品已变化');
        if (found.type === 'widget') {
          ui.lb = null;
          const key = workKey(found),
            update = (state: WidgetBlockState) =>
              setWidgets((previous) => ({ ...previous, [key]: { work: found, state } }));
          update({ status: 'loading' });
          try {
            if (found.work && found.work.contentRef.startsWith('work:')) {
              const content = await readWorkContent(
                found.work,
                found.threadId || threadId,
                new AbortController().signal,
              );
              if (content.kind !== 'html') throw new Error('Unsupported work format');
              update({
                status: 'ready',
                block: {
                  v: 1,
                  kind: 'html_widget',
                  id: found.work.contentRef,
                  html: content.html,
                  title: content.title,
                },
              });
            } else if (found.sourceMessageId && found.widgetBlockId) {
              update(
                await readArtifactWidgetBlock({
                  threadId: found.threadId || threadId,
                  messageId: found.sourceMessageId,
                  blockId: found.widgetBlockId,
                }),
              );
            } else update({ status: 'unavailable' });
          } catch (error) {
            update({ status: error instanceof WorkUnavailable ? 'unavailable' : 'error' });
          }
          return true;
        }
        const content = projectFileContent(found),
          source = artifactContentSource(found, worktreeId);
        let metadata: typeof workMetadata = null;
        if (content.kind === 'office' || content.kind === 'binary') {
          if (source.kind === 'workspace')
            metadata = await request<FileData>(
              `/api/workspace/file?${new URLSearchParams({ worktreeId: source.worktreeId, path: source.path })}`,
            );
          else if (source.kind === 'url') {
            const info = await contentFileInfo(source);
            metadata = {
              mime: info.mime ?? content.mime,
              size: info.byteLength,
              modifiedAt: info.modifiedAt,
            };
          }
        }
        if (stamp !== ownerEpoch.current) return true;
        setWorkMetadata(metadata);
        setOpenedWork({ artifact: found, ...(exact ? { reference: exact.artifact.work } : {}) });
        ui.lb = { mid: '', block: '', i: 0 };
        ui.review = null;
        setReviewId(null);
        setSnapshot(null);
        return true;
      }
      case 'workReview': {
        const stamp = ++ownerEpoch.current;
        historySequence.current++;
        compareSequence.current++;
        const found = catalogue.find((w) => workKey(w) === args.id) || work;
        if (!found) throw new Error('作品已变化');
        setOpenedWork({ artifact: found });
        setSnapshot(null);
        setReviewId(null);
        setHistory({ entries: [], nextCursor: null });
        setError('');
        ui.review = { work: workKey(found), round: null, draft: null, edit: null, compare: null, markup: null };
        ui.lb = { mid: '', block: '', i: 0 };
        setLoad('loading');
        try {
          const result = await request<{ contexts: Context[] }>(
            `/api/artifact-reviews/context?${new URLSearchParams({ threadId: found.threadId || threadId, artifactRef: found.ref ?? (found.work ? `content:${found.work.contentRef}` : (found.url ?? '')) })}`,
          );
          if (stamp !== ownerEpoch.current) return true;
          setContexts(result.contexts);
          if (result.contexts.length === 1) await prepare(result.contexts[0], stamp);
          setLoad('');
        } catch (e) {
          setLoad('error');
          throw e;
        }
        return true;
      }
      case 'workReviewPrepare':
        if (args.round) {
          if (!s) return true;
          s.round = +args.round;
          s.focusAnchor = undefined;
          s.draft = null;
          s.edit = null;
          s.markup = null;
          s.compare = null;
          setRound(+args.round);
        } else {
          const context = contexts.find((c) => c.taskId === args.id);
          if (!context) throw new Error('评审任务已变化');
          await prepare(context);
        }
        return true;
      case 'workReviewPick':
        if (s) {
          s.edit = null;
          s.draft = {
            annotationId: crypto.randomUUID(),
            body: s.draft?.body ?? '',
            ...(s.draft?.reanchoredFrom ? { reanchoredFrom: s.draft.reanchoredFrom } : {}),
            x: +args.x,
            y: +args.y,
            ...(args.width ? { width: +args.width, height: +args.height } : {}),
            ...(args.at !== undefined ? { at: +args.at, from: +args.at, until: +args.at + 1 } : {}),
          };
        }
        return true;
      case 'workReviewText':
        if (s?.draft) s.draft.body = args.v;
        return true;
      case 'workReviewTime':
        if (s?.draft) s.draft[args.id === 'review-from' ? 'from' : 'until'] = +args.v;
        return true;
      case 'workReviewEdit': {
        const annotation = r?.annotations.find((a) => a.id === args.id);
        if (!s || !annotation) return true;
        s.edit = annotation.id;
        s.draft = { body: annotation.body };
        return true;
      }
      case 'workReviewAdd':
        if (!s?.draft || !r) throw new Error('请先选择批注位置');
        await act(
          s.edit
            ? { kind: 'edit', annotationId: s.edit, body: s.draft.body }
            : {
                kind: 'annotate',
                annotationId: s.draft.annotationId ?? (s.draft.annotationId = crypto.randomUUID()),
                body: s.draft.body,
                anchor: reviewAnchor(s.draft, r.asset.media),
                ...(s.draft.reanchoredFrom ? { reanchoredFrom: s.draft.reanchoredFrom } : {}),
              },
        );
        s.draft = null;
        s.edit = null;
        return true;
      case 'reviewAnnotation':
        await act({ kind: 'set_annotation_state', annotationId: args.id, state: args.v });
        return true;
      case 'workReviewReanchor': {
        const annotation = r?.annotations.find((a) => a.id === args.id),
          latest = view?.review.rounds.at(-1);
        if (!s || !r || !annotation || !latest) throw new Error('原批注已变化');
        s.round = latest.number;
        setRound(latest.number);
        s.edit = null;
        s.draft = { body: annotation.body, reanchoredFrom: { round: r.number, annotationId: annotation.id } };
        return true;
      }
      case 'workReviewCompare':
        if (s && view) {
          const stamp = ownerEpoch.current,
            ticket = ++compareSequence.current;
          setCompareSrc(null);
          s.compare = +args.round;
          if (s.compare === r?.number) {
            s.compare = null;
            return true;
          }
          const response = await fetchMedia(reviewId!, +args.round);
          if (stamp !== ownerEpoch.current || ticket !== compareSequence.current) {
            URL.revokeObjectURL(response);
            return true;
          }
          setCompareSrc(response);
        }
        return true;
      case 'workReviewLocate': {
        if (!s || !view) throw new Error('请重新读取评审');
        const round = view.review.rounds.find((r) => r.number === +args.round);
        if (!round) throw new Error('轮次已变化');
        const anchor =
          (args.anchor as unknown as ArtifactReviewAnchor | undefined) ??
          round.annotations.find((a) => a.id === args.annotationId)?.anchor;
        if (!anchor) throw new Error('定位已变化');
        s.round = round.number;
        s.focusAnchor = anchor;
        s.focusVersion = (s.focusVersion ?? 0) + 1;
        s.draft = null;
        s.edit = null;
        s.compare = null;
        s.markup = null;
        setRound(round.number);
        return true;
      }
      case 'reviewJudge': {
        const response = r?.responses?.find((x) => x.annotationId === args.annotationId);
        if (!r || !response || !r.responseSource) throw new Error('结果来源已变化');
        await act({
          kind: 'judge_response',
          sourceRound: r.responseSource.round,
          annotationId: response.annotationId,
          resultOwnerRevision: r.asset.ownerRevision,
          outcome: args.outcome,
        });
        return true;
      }
      case 'reviewMarkupEdit':
        if (s) s.markup = args.markup as unknown as unknown[];
        return true;
      case 'contentModify': {
        if (args.op === 'open') {
          const custom = args.source as unknown as ContentModificationRequest['source'] | undefined;
          const named = !custom && view && r ? artifactRoundRequestSource(view, r) : null;
          if (!custom && !named) throw new Error('原版本身份尚未确认');
          const choices = await request<ContentModificationChoices>('/api/content-modifications/choices');
          modification.current = {
            load: '',
            place: custom ? 'canon' : 'review',
            source: custom ?? named!.source,
            taskContext: named?.taskContext,
            choices,
            prompt: args.prompt ?? '',
            targetId: named ? (view!.authority.ownerCatId ?? '') : '',
            threadId: named ? view!.review.task.threadId : '',
            imageEdit: { kind: '', ratio: '16:9' },
          };
          ui.contentModification = modification.current;
          browseChanged((n) => n + 1);
          return true;
        }
        const m = modification.current;
        if (!m?.prompt.trim() || !m.targetId || !m.threadId) throw new Error('请填写修改要求并选择成员和对话');
        if (!m.operation) {
          if (m.place === 'review') {
            if (!view || !r) throw new Error('请重新读取作品');
            if (s?.markup) {
              const before = (r.visualMarks ?? []).filter((mark) => mark.state === 'active');
              for (const mark of before)
                if (!s.markup.some((x) => (x as { id: string }).id === mark.drawing.id))
                  await act({ kind: 'delete_visual_mark', markId: mark.drawing.id });
              const added = s.markup
                .filter((x) => !before.some((mark) => mark.drawing.id === (x as { id: string }).id))
                .map((x) => {
                  const drawing = { ...(x as Record<string, unknown>) };
                  if (r.asset.media.kind === 'video') {
                    const media = r.asset.media;
                    drawing.frame = {
                      streamId: media.streamId,
                      tick: Math.round(
                        ((Number(drawing.time) + media.containerStartSeconds) * media.timebase.denominator) /
                          media.timebase.numerator,
                      ),
                    };
                  }
                  delete drawing.time;
                  delete drawing.until;
                  delete drawing.readonly;
                  return drawing;
                });
              if (added.length) await act({ kind: 'add_visual_marks', marks: added });
              s.markup = null;
            }
            const fresh = await request<ArtifactReviewView>(
                `/api/artifact-reviews/${encodeURIComponent(view.review.reviewId)}`,
              ),
              freshRound = fresh.review.rounds.find((round) => round.number === r.number),
              named = freshRound && artifactRoundRequestSource(fresh, freshRound);
            if (!named) throw new Error('原版本身份尚未确认');
            m.source = named.source;
            m.taskContext = named.taskContext;
          }
          m.operation = contentModificationRequestContractSchema.parse({
            source: m.source,
            ...(m.taskContext ? { taskContext: m.taskContext } : {}),
            targetCatId: m.targetId,
            threadId: m.threadId,
            operationId: crypto.randomUUID(),
            intent: {
              body: m.prompt,
              ...(m.place === 'review' && m.imageEdit.kind === 'aspect-ratio'
                ? { imageEdit: { kind: 'aspect-ratio', ratio: m.imageEdit.ratio } }
                : m.place === 'review' && m.imageEdit.kind === 'erase-region'
                  ? {
                      imageEdit: {
                        kind: 'erase-region',
                        region: { x: s?.draft?.x, y: s?.draft?.y, width: s?.draft?.width, height: s?.draft?.height },
                      },
                    }
                  : {}),
            },
          });
        }
        const result = await write<{ record: { requestId: string } }>('/api/content-modifications', m.operation);
        m.requestId = result.record.requestId;
        browseChanged((n) => n + 1);
        return true;
      }
      case 'contentModificationRead':
        if (modification.current?.requestId) {
          const m = modification.current;
          m.load = 'loading';
          browseChanged((n) => n + 1);
          try {
            m.view = await request<ContentModificationDetailView>(
              `/api/content-modifications/${encodeURIComponent(m.requestId!)}`,
            );
            m.load = '';
          } catch (error) {
            m.load = 'error';
            throw error;
          } finally {
            browseChanged((n) => n + 1);
          }
        }
        if (modification.current?.view?.candidates.length && snapshot) await snapshot.controller.refresh();
        return true;
      case 'contentModificationCancel':
        if (modification.current?.requestId) {
          await write(`/api/content-modifications/${encodeURIComponent(modification.current.requestId)}/cancel`, {});
          await action('contentModificationRead', {});
        }
        return true;
      case 'refresh':
        if (args.k === 'review') {
          if (snapshot?.controller.pending) {
            if (!(await snapshot.controller.retry())) throw new Error('原操作结果尚未确认');
          } else await snapshot?.controller.refresh();
          return true;
        }
        if (args.k === 'review-history' || args.k === 'review-history-more') {
          await historyRead(args.k.endsWith('more'));
          return true;
        }
        return false;
      default:
        return false;
    }
  };
  const openedSource = useMemo(
    () => openedWork && { ...openedWork, artifact: sourceWork(openedWork.artifact, worktreeId) },
    [openedWork, worktreeId],
  );
  const modificationReader = useRef(action);
  modificationReader.current = action;
  const modificationId = modification.current?.requestId;
  useEffect(() => {
    if (!needed || !modificationId) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      clearTimeout(timer);
      if (document.hidden) return;
      try {
        await modificationReader.current('contentModificationRead', {});
        const view = modification.current?.view;
        const terminal =
          view &&
          (['cancelled', 'retired'].includes(view.stage) ||
            (view.execution &&
              ['finished', 'failed', 'cancelled', 'interrupted', 'withdrawn_running'].includes(view.execution.state)));
        if (!abort.signal.aborted && !terminal) timer = setTimeout(read, 4000);
      } catch {
        /* The source carries the read failure. */
      }
    };
    void read();
    document.addEventListener('visibilitychange', read);
    return () => {
      abort.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', read);
    };
  }, [needed, modificationId]);
  const rawData = useMemo(
    () => ({
      artifacts: {
        artifacts: artifacts.artifacts,
        works: localWorks,
        loading: artifacts.loading,
        error: artifacts.error,
        total: artifacts.total,
        complete: artifacts.complete,
      },
      widgets,
      global: {
        artifacts: globalSources,
        workLineage: global.workLineage,
        loading: global.loading,
        error: global.error,
        complete: global.complete,
        hasMore: global.hasMore,
        loadingMore: global.loadingMore,
        stale: global.stale,
        works: globalWorks,
      },
      recentOwners: recentSources,
      globalEnabled,
      worktreeId,
      reviewId,
      round,
      requestSources,
      selectionForChat: selectionForChat.current,
      openedWork: openedSource,
      workMetadata,
      text,
      contexts,
      load,
      history,
      historyLoad,
      compareSrc,
      error,
      review: snapshot && {
        view: snapshot.controller.view,
        error: snapshot.controller.error,
        loading: snapshot.controller.loading,
        saving: snapshot.controller.saving,
        round: snapshot.round,
        src: snapshot.src,
        download: snapshot.download,
      },
      modification: modification.current && {
        view: modification.current.view,
        choices: modification.current.choices,
        load: modification.current.load,
        source: modification.current.source,
        taskContext: modification.current.taskContext,
        place: modification.current.place,
        requestId: modification.current.requestId,
        operation: modification.current.operation,
      },
    }),
    [
      artifacts.artifacts,
      localWorks,
      artifacts.loading,
      artifacts.error,
      artifacts.total,
      artifacts.complete,
      widgets,
      globalSources,
      global.workLineage,
      global.loading,
      global.error,
      global.complete,
      global.hasMore,
      global.loadingMore,
      global.stale,
      globalWorks,
      recentSources,
      globalEnabled,
      worktreeId,
      reviewId,
      round,
      requestSources,
      selectionForChat.current,
      openedSource,
      workMetadata,
      text,
      contexts,
      load,
      history,
      historyLoad,
      compareSrc,
      error,
      snapshot,
      modification.current,
    ],
  );
  return {
    action,
    reviewId,
    round,
    changed,
    state: useMemo(() => ({ works: worksReading.current, text: textReading.current }), []),
    data: rawData,
  };
}
async function fetchMedia(reviewId: string, round: number) {
  const { apiFetch } = await import('@/utils/api-client');
  const response = await apiFetch(`/api/artifact-reviews/${encodeURIComponent(reviewId)}/media/${round}`);
  if (!response.ok) throw new Error('媒体不可读取');
  return URL.createObjectURL(await response.blob());
}
