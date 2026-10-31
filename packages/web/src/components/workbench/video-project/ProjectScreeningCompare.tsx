'use client';
import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import { browserTimeToTick } from '../../content-review/review-geometry';
import { useWorkspaceSurfaceVisibility } from '../WorkspaceSurfaceVisibility';
import { loadProject, loadScreening, type ProjectSnapshot, type ScreeningDescriptor } from './api';
import { comparePairMatchesInput, type ScreeningCompareSide } from './compare-alignment';
import { VideoProjectScreeningCompare } from './compare-screenings';
import { useScreeningCopy } from './screening-ui/screening.shell-copy';
import { queueScreeningSelection, screeningSelection } from './selection';

export function ProjectScreeningCompare({
  leftId,
  right,
  input,
  markRequest,
}: {
  leftId: string;
  right: ScreeningDescriptor;
  input: ProjectSnapshot;
  markRequest?: number;
}) {
  const t = useScreeningCopy();
  const [left, setLeft] = useState<ScreeningCompareSide | null>(null),
    [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState<{ context: string; time: number | null } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const threadId = useChatStore((state) => state.currentThreadId);
  const visible = useWorkspaceSurfaceVisibility();
  const context = JSON.stringify([
    leftId,
    right.screening.id,
    right.screening.input,
    right.screening.media,
    right.mediaUrl,
    input.contentRef,
    input.ownerRevision,
    input.blobDigest,
    threadId,
  ]);
  const consumed = useRef({ context, request: 0 });
  const frameTime = frame?.context === context && Number.isFinite(frame.time) ? frame.time : null;
  useEffect(() => {
    const controller = new AbortController();
    setLeft(null);
    setError(null);
    void (async () => {
      const descriptor = await loadScreening(input.contentRef, leftId, controller.signal);
      const frozen = await loadProject(input.contentRef, controller.signal, descriptor.screening.input.ownerRevision);
      return { screening: descriptor.screening, input: frozen, mediaUrl: `${API_URL}${descriptor.mediaUrl}` };
    })().then(
      (value) => {
        if (!controller.signal.aborted) setLeft(value);
      },
      (failure: unknown) => {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '旧版暂时不可读。');
      },
    );
    return () => controller.abort();
  }, [leftId, input.contentRef]);
  const mark = () => {
    if (frameTime === null) return;
    const { screening } = right,
      media = screening.media.media,
      startPts = browserTimeToTick(frameTime, media);
    try {
      const result = queueScreeningSelection(threadId, {
        v: 1,
        kind: 'project-screening',
        id: crypto.randomUUID(),
        title: `${input.document.title} · ${screening.title}`,
        contentRef: input.contentRef,
        screeningId: screening.id,
        input: screening.input,
        media: {
          contentRef: screening.media.contentRef,
          ownerRevision: screening.media.ownerRevision,
          blobDigest: screening.media.blobDigest,
        },
        selections: [
          screeningSelection({
            screening,
            document: input.document,
            mode: 'moment',
            mediaRange: { startPts, endPts: Math.min(startPts + 1, media.startTick + media.durationTicks) },
          }),
        ],
      });
      setStatus(result.kind === 'queued' ? t.queuedRight : result.reason);
    } catch (failure) {
      setStatus(failure instanceof Error ? failure.message : t.retry);
    }
  };
  const markAction = useRef(mark);
  markAction.current = mark;
  useEffect(() => {
    // A request belongs to this fixed pair and original chat; navigation never replays it elsewhere.
    if (consumed.current.context !== context) {
      consumed.current = { context, request: markRequest ?? 0 };
      setStatus(null);
      return;
    }
    if (!markRequest) {
      consumed.current.request = 0;
      return;
    }
    if (markRequest <= consumed.current.request) return;
    if (!visible || error) {
      consumed.current.request = markRequest;
      setStatus(error ?? t.markCancelled);
      return;
    }
    if (
      !left ||
      left.screening.id !== leftId ||
      !comparePairMatchesInput(left, { screening: right.screening, input, mediaUrl: right.mediaUrl }) ||
      frameTime === null
    ) {
      setStatus(t.confirming);
      return;
    }
    consumed.current.request = markRequest;
    markAction.current();
  }, [context, markRequest, visible, error, left, leftId, right, input, frameTime, t.confirming, t.markCancelled]);
  if (error) return <p role="alert">{error}</p>;
  if (!left) return <output className="text-sm text-cafe-muted">{t.readingPair}</output>;
  return (
    <>
      <VideoProjectScreeningCompare
        left={left}
        right={{ screening: right.screening, input, mediaUrl: `${API_URL}${right.mediaUrl}` }}
        onRightFrame={(time) => setFrame({ context, time })}
      />
      {markRequest === undefined && (
        <div className="flex justify-end">
          <button
            type="button"
            disabled={frameTime === null}
            onClick={mark}
            className="rounded-lg bg-cafe-accent px-4 py-2 text-sm text-white"
          >
            {t.markRight}
          </button>
        </div>
      )}
      {status && <output className="mt-2 text-xs text-cafe-secondary">{status}</output>}
    </>
  );
}
