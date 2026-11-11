'use client';
import {
  projectTickToMediaPts,
  type VideoProjectScreening,
  type WorkspaceContentAnnotation,
  type WorkspaceContentReview,
} from '@cat-cafe/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { browserTimeToTick, tickToBrowserTime } from '@/components/content-review/review-geometry';
import {
  listProjects,
  loadProject,
  loadScreening,
  type ProjectSnapshot,
  projectPath,
  projectRequest,
  type ScreeningDescriptor,
} from '@/components/workbench/video-project/api';
import {
  isUnchanged,
  readProjectReview,
  reopenProjectOpinion,
  synchronizeProjectReview,
} from '@/components/workbench/video-project/screening-ui/project-review-read';
import { queuePresentedScreeningSelection } from '@/components/workbench/video-project/screening-ui/screening-player-selection';
import {
  confirmScreeningRegistration,
  createScreeningRegistration,
  type ScreeningRegistrationCommand,
} from '@/components/workbench/video-project/screening-ui/screening-registration';
import { API_URL } from '@/utils/api-client';
import { failRead, request } from './owner-api';

interface FrozenScreening {
  descriptor: ScreeningDescriptor;
  input: ProjectSnapshot;
}
async function readScreeningInput(project: ProjectSnapshot, id: string, signal: AbortSignal): Promise<FrozenScreening> {
  const expected = project.document.screenings?.find((s) => s.id === id);
  if (!expected) throw new Error('成片已变化，请重新读取');
  const descriptor = await loadScreening(project.contentRef, id, signal),
    frozen = descriptor.screening.input;
  if (frozen.ownerRevision !== expected.input.ownerRevision || frozen.blobDigest !== expected.input.blobDigest)
    throw new Error('成片输入版本不一致');
  const input = await loadProject(project.contentRef, signal, frozen.ownerRevision);
  if (input.blobDigest !== frozen.blobDigest) throw new Error('成片输入版本不一致');
  return { descriptor, input };
}
export function opinionComparison(annotation: WorkspaceContentAnnotation, project: ProjectSnapshot) {
  const last = [...(annotation.projectHistory ?? [])]
    .reverse()
    .find((h) => ['addressed', 'reopened', 'resolved'].includes(h.kind));
  const result = last?.kind === 'addressed' ? last.result : undefined;
  const anchor = annotation.anchor;
  if (
    !('kind' in anchor) ||
    anchor.kind !== 'video-project' ||
    !result ||
    !('contentRef' in result) ||
    result.contentRef !== project.contentRef
  )
    return null;
  const from = project.document.screenings?.find(
    (s) => s.input.ownerRevision === anchor.baseOwnerRevision && s.input.blobDigest === anchor.baseRevision,
  );
  const to = project.document.screenings?.find(
    (s) => s.input.ownerRevision === result.ownerRevision && s.input.blobDigest === result.blobDigest,
  );
  return from && to && from.id !== to.id ? { from: from.id, to: to.id } : null;
}

export function filmPoints(input: ProjectSnapshot, screening: VideoProjectScreening) {
  return input.document.timeline.scenes.flatMap((scene) => {
    const segment = input.document.timeline.segments
      .filter((s) => s.sceneId === scene.id)
      .sort((a, b) => a.startTick - b.startTick)[0];
    if (!segment) return [];
    const mapping = screening.mapping.segments.find(
      (m) => m.projectStartTick < segment.startTick + segment.durationTicks && m.projectEndTick > segment.startTick,
    );
    if (!mapping) return [];
    const pts = projectTickToMediaPts(screening, Math.max(segment.startTick, mapping.projectStartTick));
    return pts === null
      ? []
      : [{ key: scene.id, label: scene.label, at: tickToBrowserTime(pts, screening.media.media) }];
  });
}
function screeningFacts(source: FrozenScreening, review: WorkspaceContentReview) {
  const screen = source.descriptor.screening;
  return {
    scenePositions: Object.fromEntries(filmPoints(source.input, screen).map((point) => [point.key, point.at])),
    segmentPositions: Object.fromEntries(
      source.input.document.timeline.segments.map((segment) => {
        const pts = projectTickToMediaPts(screen, segment.startTick);
        return [segment.startTick, pts === null ? null : tickToBrowserTime(pts, screen.media.media)];
      }),
    ),
    annotationTimes: Object.fromEntries(
      review.annotations.flatMap((annotation) => {
        const message = annotation.projectMessage;
        return message && message.screeningId === screen.id
          ? [
              [
                annotation.id,
                {
                  from: tickToBrowserTime(message.selection.mediaRange.startPts, screen.media.media),
                  to: tickToBrowserTime(message.selection.mediaRange.endPts, screen.media.media),
                },
              ],
            ]
          : [];
      }),
    ),
  };
}
function reviewSource(review: WorkspaceContentReview, head: ProjectSnapshot) {
  return {
    ...review,
    annotations: review.annotations.map((annotation) => ({
      ...annotation,
      sourceComparison: opinionComparison(annotation, head),
      projectHistory: annotation.projectHistory?.map((event) => ({ ...event, unchanged: !!isUnchanged(event) })),
    })),
  };
}
interface FilmUi {
  layout: string;
  tab: string;
  assets: Record<string, string>;
  compare: string;
  opinion: string | null;
}
interface Preview {
  title: string;
  sub?: string;
  url: string;
  media: { id: string; kind: string; src: string; label: string };
  markArgs?: { id: string; screening: string };
}
export function useFilmBindings(
  workbench: { film?: unknown; clipPreview?: unknown },
  threadId: string | null = null,
  needed: boolean | number = false,
) {
  const ui = useRef<FilmUi>({ layout: 'list', tab: 'story', assets: {}, compare: '', opinion: null });
  workbench.film = ui.current;
  const [projects, setProjects] = useState<ProjectSnapshot[]>([]),
    [load, setLoad] = useState('loading');
  const [selected, setSelected] = useState<{
    head: ProjectSnapshot;
    input: ProjectSnapshot;
    descriptor: ScreeningDescriptor | null;
    review: WorkspaceContentReview;
    sync: { pending: number } | null;
  } | null>(null);
  const [reference, setReference] = useState<FrozenScreening | null>(null);
  const compareSequence = useRef(0);
  const previewSequence = useRef(0);
  const sequence = useRef(0);
  const registrations = useRef(new Map<string, ScreeningRegistrationCommand>());
  useEffect(() => {
    if (!needed) return;
    const abort = new AbortController();
    void listProjects(abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) {
          setProjects(value);
          setLoad('');
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) setLoad('error');
      });
    return () => {
      abort.abort();
      sequence.current++;
      previewSequence.current++;
    };
  }, [needed]);
  const open = async (contentRef: string, screeningId?: string) => {
    const ticket = ++sequence.current;
    setLoad('loading');
    try {
      const abort = new AbortController(),
        [head, review, sync] = await Promise.all([
          loadProject(contentRef, abort.signal),
          readProjectReview(contentRef, abort.signal),
          threadId
            ? request<{ pending: number }>(
                `${projectPath(contentRef)}/review/sync-status?${new URLSearchParams({ threadId })}`,
                { signal: abort.signal },
              )
            : Promise.resolve(null),
        ]),
        id = screeningId ?? head.document.screenings?.at(-1)?.id,
        frozen = id ? await readScreeningInput(head, id, abort.signal) : null,
        descriptor = frozen?.descriptor ?? null,
        input = frozen ? frozen.input : head;
      if (ticket === sequence.current) {
        setSelected({ head, input, descriptor, review, sync });
        compareSequence.current++;
        setReference(null);
        ui.current.compare = '';
        ui.current.opinion = null;
        workbench.clipPreview = null;
        setLoad('');
        ui.current.assets = {};
      }
      return { head, input, descriptor, review, sync };
    } catch (e) {
      if (ticket === sequence.current) setLoad('error');
      failRead(e);
    }
  };
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    if (!needed) return;
    const abort = new AbortController();
    const update = async () => {
      if (document.hidden) return;
      const current = selectedRef.current;
      if (!current) return;
      const [head, review, sync] = await Promise.all([
        loadProject(current.head.contentRef, abort.signal),
        readProjectReview(current.head.contentRef, abort.signal),
        threadId
          ? request<{ pending: number }>(
              `${projectPath(current.head.contentRef)}/review/sync-status?${new URLSearchParams({ threadId })}`,
              { signal: abort.signal },
            )
          : Promise.resolve(null),
      ]);
      if (!abort.signal.aborted)
        setSelected((value) =>
          value?.head.contentRef === current.head.contentRef ? { ...value, head, review, sync } : value,
        );
    };
    const read = () => {
      void update().catch(() => {
        if (!abort.signal.aborted) setLoad('error');
      });
    };
    read();
    const timer = setInterval(read, 3000);
    document.addEventListener('visibilitychange', read);
    return () => {
      abort.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', read);
    };
  }, [needed, threadId]);
  const sourceFor = (screening: string): FrozenScreening | null => {
    if (selected?.descriptor?.screening.id === screening)
      return { descriptor: selected.descriptor, input: selected.input };
    return reference?.descriptor.screening.id === screening ? reference : null;
  };
  const action = async (name: string, args: Record<string, string>) => {
    if (name === 'filmSync') {
      const current = selected!,
        stamp = sequence.current;
      if (!threadId || args.id !== current.head.contentRef) throw new Error('请重新打开当前影片');
      const abort = new AbortController();
      let result: Awaited<ReturnType<typeof synchronizeProjectReview>>;
      do {
        result = await synchronizeProjectReview(args.id, threadId, abort.signal);
        if (result.error) throw result.error;
      } while (result.pending);
      if (stamp === sequence.current) await open(args.id, current.descriptor?.screening.id);
      return true;
    }
    if (name === 'filmOpinionCompare') {
      const s = selected!,
        stamp = sequence.current,
        ticket = ++compareSequence.current;
      const annotation = s.review.annotations.find((a) => a.id === args.id);
      const compare = annotation ? opinionComparison(annotation, s.head) : null;
      if (!compare || compare.from !== args.from || compare.to !== args.to)
        throw new Error('意见或成片已变化，请重新读取');
      const abort = new AbortController();
      const [left, right] = await Promise.all([
        readScreeningInput(s.head, compare.from, abort.signal),
        readScreeningInput(s.head, compare.to, abort.signal),
      ]).catch(failRead);
      if (stamp === sequence.current && ticket === compareSequence.current) {
        setSelected({ ...s, ...left });
        setReference(right);
        ui.current.compare = compare.to;
        ui.current.opinion = args.id;
        ui.current.assets = {};
      }
      return true;
    }
    if (name === 'filmOpinionShow') {
      const s = selected!;
      if (
        s.head.contentRef !== args.project ||
        !sourceFor(args.screening) ||
        !s.review.annotations.some((a) => a.id === args.id && a.projectMessage?.screeningId === args.screening)
      )
        throw new Error('意见或成片已变化，请重新读取');
      ui.current.opinion = args.id;
      ui.current.tab = 'review';
      workbench.clipPreview = null;
      return true;
    }
    if (name === 'filmCompare') {
      const stamp = sequence.current,
        ticket = ++compareSequence.current;
      if (!args.v) {
        ui.current.compare = '';
        setReference(null);
        return true;
      }
      const frozen = await readScreeningInput(selected!.head, args.v, new AbortController().signal).catch(failRead);
      if (stamp === sequence.current && ticket === compareSequence.current) {
        ui.current.compare = args.v;
        setReference(frozen);
      }
      return true;
    }
    if (name === 'filmReopen') {
      const s = selected!,
        stamp = sequence.current;
      if (s.head.contentRef !== args.project) throw new Error('影片已切换，请重新打开意见');
      await reopenProjectOpinion(args.project, Number(args.revision), args.id, args.reason, args.operationId);
      const review = await readProjectReview(args.project, new AbortController().signal).catch(failRead);
      if (stamp === sequence.current) setSelected({ ...s, review });
      return true;
    }
    if (name === 'filmMark') {
      const s = selected!;
      const source = sourceFor(args.screening);
      if (!threadId || s.head.contentRef !== args.id || !source) throw new Error('请重新选择当前成片');
      const screening = source.descriptor.screening,
        media = screening.media.media;
      const queued = queuePresentedScreeningSelection({
        threadId,
        project: source.input,
        screening,
        pts: browserTimeToTick(Number(args.at), media),
        rangeStart: null,
        frameSeconds: media.frameRate ? media.frameRate.denominator / media.frameRate.numerator : null,
        mode: 'moment',
        region:
          args.width && args.height
            ? {
                coordinateSpace: 'display-pixels',
                width: media.width,
                height: media.height,
                rotation: media.rotation,
                bbox: { x: Number(args.x), y: Number(args.y), width: Number(args.width), height: Number(args.height) },
              }
            : undefined,
      });
      if (queued.kind === 'refused') throw new Error(queued.reason);
      workbench.clipPreview = null;
      return true;
    }
    if (name === 'filmImport') {
      await projectRequest('/api/video-projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId: args.operationId, document: args.document }),
      });
      setProjects(await listProjects(new AbortController().signal));
      return true;
    }
    if (name === 'filmRegister') {
      const intent = args as unknown as Parameters<typeof createScreeningRegistration>[0] & { attempt: string };
      const key = JSON.stringify([
        intent.attempt,
        intent.project.contentRef,
        intent.project.ownerRevision,
        intent.worktreeId,
        intent.path,
        intent.title,
        intent.mapping,
      ]);
      const at = sequence.current;
      let command = registrations.current.get(key);
      if (!command) {
        command = await createScreeningRegistration(intent);
        registrations.current.set(key, command);
      }
      await confirmScreeningRegistration(intent.project.contentRef, command);
      if (sequence.current === at) await open(intent.project.contentRef, command.id);
      setProjects(await listProjects(new AbortController().signal));
      registrations.current.delete(key);
      return true;
    }
    if (name === 'filmOpen' || name === 'filmRefresh') {
      await open(args.id || selected!.head.contentRef);
      return true;
    }
    if (name === 'refresh' && args.k === 'clips') {
      setLoad('loading');
      try {
        setProjects(await listProjects(new AbortController().signal));
        setLoad('');
      } catch (error) {
        setLoad('error');
        failRead(error);
      }
      return true;
    }
    if (name === 'filmScreening') {
      await open(selected!.head.contentRef, args.v);
      return true;
    }
    if (name === 'filmAssetVersion') {
      ui.current.assets[args.id] = args.v;
      return true;
    }
    if (name === 'filmPreview') {
      const ticket = ++previewSequence.current,
        source = selected?.head.contentRef === args.id ? sourceFor(args.screening) : null,
        stamp = sequence.current + (source ? 0 : 1);
      const current =
        source && selected
          ? {
              ...selected,
              ...source,
              review: await readProjectReview(args.id, new AbortController().signal).catch(failRead),
            }
          : await open(args.id, args.screening);
      if (stamp !== sequence.current || ticket !== previewSequence.current) return true;
      const { head, descriptor } = current;
      if (!descriptor) throw new Error('该成片还没有可播放版本');
      if (source) setSelected((s) => (s ? { ...s, review: current.review } : s));
      const url = `${API_URL}${descriptor.mediaUrl}`;
      workbench.clipPreview = {
        title: head.document.title,
        sub: descriptor.screening.title,
        url,
        markArgs: { id: head.contentRef, screening: descriptor.screening.id },
        media: {
          id: `film:${head.contentRef}:${descriptor.screening.id}:preview`,
          kind: 'video',
          src: url,
          label: descriptor.screening.title,
        },
      } satisfies Preview;
      return true;
    }
    if (name === 'filmAssetPreview') {
      previewSequence.current++;
      if (!selected || selected.head.contentRef !== args.id) throw new Error('请重新读取成片');
      const asset = selected.input.document.assets.find((a) => a.id === args.asset),
        version = asset?.versions.find((v) => v.id === args.version);
      if (!asset || !version) throw new Error('素材版本已变化');
      const url = `${API_URL}/api/video-projects/${encodeURIComponent(args.id)}/assets/${encodeURIComponent(version.id)}`;
      workbench.clipPreview = {
        title: asset.name,
        sub: version.recordedAt,
        url,
        media: { id: version.id, kind: version.mediaType.split('/')[0], src: url, label: asset.name },
      } satisfies Preview;
      return true;
    }
    return false;
  };
  const selectedSource = useMemo(
    () =>
      selected && {
        ...selected,
        review: reviewSource(selected.review, selected.head),
        facts: selected.descriptor
          ? screeningFacts({ descriptor: selected.descriptor, input: selected.input }, selected.review)
          : null,
      },
    [selected],
  );
  const referenceReview = selected?.review;
  const referenceSource = useMemo(
    () =>
      reference && {
        ...reference,
        facts: screeningFacts(reference, referenceReview!),
      },
    [reference, referenceReview],
  );
  const rawData = useMemo(
    () => ({ projects, load, selected: selectedSource, reference: referenceSource }),
    [projects, load, selectedSource, referenceSource],
  );
  return { action, state: ui.current, data: rawData };
}
