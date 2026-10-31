'use client';
import type { WorkspaceContentAnnotation } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { createVideoProjectSurface, type VideoProjectTarget } from '../video-project-surface';
import { useWorkspaceSurfaceVisibility } from '../WorkspaceSurfaceVisibility';
import type { WorkspaceSurfaceDescriptor } from '../workbench-contract';
import { ProjectModificationView } from './ProjectModificationView';
import { ProjectReviewPanel } from './ProjectReviewPanel';
import { ProjectScreeningCompare } from './ProjectScreeningCompare';
import { RegisterScreening } from './RegisterScreening';
import { projectReviewCounts } from './review-counts';
import { CurrentProjectDecisions, ProjectReviewHeader } from './screening-ui/ProjectReviewSummary';
import { ScreeningVersionControls } from './screening-ui/ScreeningVersionControls';
import { useScreeningComparison } from './screening-ui/screening-comparison';
import { useProjectReview } from './useProjectReview';
import { useScreeningProject } from './useScreeningProject';
import styles from './VideoProjectReviewSurface.module.css';
import { VideoProjectScreeningPlayer } from './VideoProjectScreeningPlayer';

export function VideoProjectReviewSurface({
  target,
  onRefreshSurface,
}: {
  target: VideoProjectTarget;
  onRefreshSurface: (surface: WorkspaceSurfaceDescriptor) => void;
}) {
  const [refresh, setRefresh] = useState(0);
  const [markRequest, setMarkRequest] = useState(0);
  const stage = useRef<HTMLDivElement>(null),
    decisionsPanel = useRef<HTMLDivElement>(null);
  const [modification, setModification] = useState<WorkspaceContentAnnotation | null>(null);
  const opinions = useProjectReview(target.contentRef, refresh);
  const { state, error, loading } = useScreeningProject(target, refresh);
  const screening = state?.descriptor?.screening;
  const visible = useWorkspaceSurfaceVisibility();
  const canMark = Boolean(
    !loading && !error && state?.descriptor && state.input && !state.head.document.archivedAt && !modification,
  );
  const { compareId, setCompareId } = useScreeningComparison(target, state?.head.document.screenings, screening?.id);
  const contentRef = target.contentRef,
    selectedScreeningId = target.screeningId,
    resolvedScreeningId = screening?.id,
    resolvedTitle = state?.head.document.title;
  // biome-ignore lint/correctness/useExhaustiveDependencies: transient controls belong to the selected frozen film.
  useEffect(() => {
    setModification(null);
    setMarkRequest(0);
  }, [contentRef, selectedScreeningId]);
  useEffect(() => {
    if (resolvedScreeningId && !selectedScreeningId && resolvedTitle)
      onRefreshSurface(
        createVideoProjectSurface({ contentRef, screeningId: resolvedScreeningId, title: resolvedTitle }),
      );
  }, [resolvedScreeningId, selectedScreeningId, contentRef, resolvedTitle, onRefreshSurface]);
  useEffect(() => {
    if (!visible || !canMark) return;
    const key = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (
        event.key.toLowerCase() !== 'm' ||
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        target?.closest(
          'input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=textbox],[role=combobox]',
        )
      )
        return;
      event.preventDefault();
      setMarkRequest((value) => value + 1);
      stage.current?.scrollIntoView?.({ block: 'start' });
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [visible, canMark]);
  if (loading) return <output className="p-6 text-sm text-cafe-muted">正在打开审片…</output>;
  if (error || !state)
    return (
      <div className="p-6 text-sm text-cafe-secondary" role="alert">
        {error ?? '项目不可用。'}{' '}
        <button type="button" onClick={() => setRefresh((value) => value + 1)}>
          重试
        </button>
      </div>
    );
  const { head, input, descriptor } = state;
  const jumpTo = (screeningId: string, pts: number) => {
    setCompareId(null);
    setModification(null);
    setMarkRequest(0);
    onRefreshSurface(
      createVideoProjectSurface({
        contentRef: head.contentRef,
        title: head.document.title,
        screeningId,
        position: { pts, requestId: Date.now() },
      }),
    );
  };
  if (head.document.archivedAt)
    return <p className="p-6 text-sm text-cafe-secondary">这个项目已归档，恢复后可继续审片。</p>;
  const counts = screening
    ? projectReviewCounts(head.document, screening.input, input?.document)
    : { hasRecords: false, reviewed: 0 };
  const decisions = head.document.decisions.filter((decision) => decision.state === 'open');
  return (
    <div
      className={`${styles.surface} flex h-full min-h-0 flex-col bg-[var(--shell-work,var(--cafe-surface-elevated))] text-cafe-primary`}
      data-video-project={head.contentRef}
    >
      <ProjectReviewHeader
        title={head.document.title}
        counts={counts}
        decisionCount={decisions.length}
        onDecisions={() => decisionsPanel.current?.scrollIntoView?.({ block: 'nearest' })}
        onMark={
          visible && canMark
            ? () => {
                setMarkRequest((value) => value + 1);
                stage.current?.scrollIntoView?.({ block: 'start' });
              }
            : undefined
        }
      >
        <ScreeningVersionControls
          project={head}
          screening={screening}
          canCompare={Boolean(descriptor && input)}
          compareId={compareId}
          onCompare={(id) => {
            setMarkRequest(0);
            setCompareId(id);
          }}
          onSelect={(screeningId) => {
            setModification(null);
            setMarkRequest(0);
            onRefreshSurface(
              createVideoProjectSurface({
                contentRef: head.contentRef,
                title: head.document.title,
                screeningId,
              }),
            );
          }}
        />
      </ProjectReviewHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div ref={stage} className={`${styles.stage} grid gap-4`}>
          <div className="min-w-0">
            <ProjectPicture
              modification={modification}
              state={state}
              compareId={compareId}
              markRequest={markRequest}
              opinions={opinions.review}
              focus={target.position}
              onJump={jumpTo}
              onClose={() => setModification(null)}
            />
          </div>
          {screening && (
            <ProjectReviewPanel
              contentRef={head.contentRef}
              review={opinions.review}
              screeningId={screening.id}
              pending={opinions.pending}
              error={opinions.error}
              onRefresh={() => setRefresh((value) => value + 1)}
              onLocate={(annotation) => {
                const context = annotation.projectMessage;
                if (!context) return;
                jumpTo(context.screeningId, context.selection.mediaRange.startPts);
              }}
              onCompare={(annotation) => {
                setModification(annotation);
                setMarkRequest(0);
                stage.current?.scrollIntoView?.({ block: 'start' });
              }}
            />
          )}
        </div>
        <div className="mt-5">
          <RegisterScreening
            project={head}
            onRegistered={() => {
              onRefreshSurface(createVideoProjectSurface({ contentRef: head.contentRef, title: head.document.title }));
              setRefresh((value) => value + 1);
            }}
          />
        </div>
        <div ref={decisionsPanel}>
          <CurrentProjectDecisions decisions={decisions} />
        </div>
      </div>
    </div>
  );
}

function ProjectPicture({
  modification,
  state,
  compareId,
  markRequest,
  opinions,
  focus,
  onJump,
  onClose,
}: {
  modification: WorkspaceContentAnnotation | null;
  state: NonNullable<ReturnType<typeof useScreeningProject>['state']>;
  compareId: string | null;
  markRequest: number;
  opinions: ReturnType<typeof useProjectReview>['review'];
  focus: VideoProjectTarget['position'];
  onJump: (screeningId: string, pts: number) => void;
  onClose: () => void;
}) {
  const { head, input, descriptor } = state;
  if (modification)
    return (
      <ProjectModificationView
        contentRef={head.contentRef}
        annotation={modification}
        screenings={head.document.screenings ?? []}
        onJump={onJump}
        onClose={onClose}
      />
    );
  if (!descriptor || !input) return <p className="mb-4 text-sm text-cafe-secondary">还没有登记可播放的成片。</p>;
  if (compareId && compareId !== descriptor.screening.id)
    return <ProjectScreeningCompare leftId={compareId} right={descriptor} input={input} markRequest={markRequest} />;
  const positions = (opinions?.annotations ?? []).flatMap((annotation) =>
    annotation.projectMessage?.screeningId === descriptor.screening.id
      ? [{ id: annotation.id, pts: annotation.projectMessage.selection.mediaRange.startPts }]
      : [],
  );
  return (
    <VideoProjectScreeningPlayer
      key={descriptor.screening.id}
      screening={descriptor.screening}
      input={input}
      mediaUrl={descriptor.mediaUrl}
      focus={focus}
      markRequest={markRequest}
      opinionPositions={positions}
    />
  );
}
