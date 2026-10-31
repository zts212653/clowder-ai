'use client';

import type { ArtifactReviewView } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { invalidateArtifactReviewAccess } from '@/components/content-review/review-access-invalidation';
import { useContentOpen } from '@/components/content-review/useContentOpen';
import { NeedsMePanel } from '@/components/growing/NeedsMePanel';
import { type PreparedArtifactCoordinate, ProductSchedulePanel } from '@/components/growing/ProductSchedulePanel';
import { readPreparedArtifact } from '@/components/growing/read-prepared-artifact';
import { openMailbox } from '@/components/shell/mailbox/mailbox-navigation';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { navigateToEntrustedWorkAction, resolveEntrustedWorkActionTarget } from '@/hooks/useWorkspaceNavigate';
import { apiFetch } from '@/utils/api-client';
import { createArtifactReviewSurface, reviewSurfaceFromPreparedRef } from './artifact-review-surface';
import {
  createApprovalActionSurface,
  createNeedsMeReturnSurface,
  createProductScheduleReturnSurface,
  resolveNeedsMeReturnTarget,
  resolveProductScheduleReturnTarget,
} from './real-surface-adapters';
import type { WorkspaceSurfaceDescriptor } from './workbench-contract';

interface ArtifactReturnProps {
  surface: WorkspaceSurfaceDescriptor;
  onOpenArtifactWithReturn: (input: {
    artifact: WorkspaceSurfaceDescriptor;
    returnSurface: WorkspaceSurfaceDescriptor;
  }) => void;
}

function ArtifactUnavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="m-4 rounded-xl border border-cafe-subtle p-3 text-sm text-cafe-secondary">
      这份内容已更新或暂时不可用，请刷新后再试。
      <button type="button" className="ml-3 underline" onClick={onRetry}>
        刷新
      </button>
    </div>
  );
}

function usePreparedArtifactReturn(onOpen: ArtifactReturnProps['onOpenArtifactWithReturn']) {
  const { openContent, lightbox } = useContentOpen();
  const [loading, setLoading] = useState(false);
  const readRef = useRef<AbortController | null>(null);
  useEffect(() => () => readRef.current?.abort(), []);
  const [unavailable, setUnavailable] = useState(false);
  const openReview = useCallback(
    (review: ArtifactReviewView, returnSurface: WorkspaceSurfaceDescriptor | null) => {
      readRef.current?.abort();
      setLoading(false);
      if (!returnSurface) {
        setUnavailable(true);
        return;
      }
      setUnavailable(false);
      onOpen({
        artifact: createArtifactReviewSurface(review.review.reviewId, review.review.task.threadId, review.review.title),
        returnSurface,
      });
    },
    [onOpen],
  );
  const openReviewAction = useCallback(
    async (reviewId: string, returnSurface: WorkspaceSurfaceDescriptor) => {
      try {
        const response = await apiFetch(`/api/artifact-reviews/${reviewId}`, undefined, { afterCurrentGet: true });
        if (!response.ok) {
          if ([401, 403, 404, 410].includes(response.status)) invalidateArtifactReviewAccess(reviewId);
          throw new Error('Review is not available');
        }
        const review = (await response.json()) as ArtifactReviewView;
        if (review.review.reviewId !== reviewId) throw new Error('Review identity changed');
        openReview(review, returnSurface);
      } catch {
        setUnavailable(true);
      }
    },
    [openReview],
  );
  const openPublication = useCallback(
    async (coordinate: PreparedArtifactCoordinate, returnSurface: WorkspaceSurfaceDescriptor) => {
      const controller = new AbortController();
      readRef.current = controller;
      setLoading(true);
      setUnavailable(false);
      try {
        const artifact = await readPreparedArtifact(coordinate, controller.signal);
        if (controller.signal.aborted) return;
        if (!artifact) {
          setUnavailable(true);
          return;
        }
        const opened = await openContent({
          kind: 'artifact',
          threadId: artifact.threadId,
          artifact,
          attach: (surface) => onOpen({ artifact: surface, returnSurface }),
        });
        if (!opened && !controller.signal.aborted) setUnavailable(true);
      } catch {
        if (!controller.signal.aborted) setUnavailable(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [onOpen, openContent],
  );
  const open = useCallback(
    (coordinate: PreparedArtifactCoordinate, returnSurface: WorkspaceSurfaceDescriptor | null, title?: string) => {
      readRef.current?.abort();
      setLoading(false);
      if (!returnSurface) {
        setUnavailable(true);
        return;
      }
      const reviewSurface = reviewSurfaceFromPreparedRef(coordinate.openInWorkspaceRef, title);
      if (reviewSurface) {
        setUnavailable(false);
        onOpen({ artifact: reviewSurface, returnSurface });
        return;
      }
      void openPublication(coordinate, returnSurface);
    },
    [onOpen, openPublication],
  );
  const retry = useCallback(() => {
    setUnavailable(false);
    window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated'));
  }, []);
  return { loading, open, openReview, openReviewAction, unavailable, retry, lightbox };
}

export function ProductScheduleOwnerSurface({ surface, onOpenArtifactWithReturn }: ArtifactReturnProps) {
  const target = usePreparedArtifactReturn(onOpenArtifactWithReturn);
  const selectedItemRef = resolveProductScheduleReturnTarget(surface)?.itemRef ?? null;
  const openArtifact = (coordinate: PreparedArtifactCoordinate, itemRef: string, title?: string) =>
    target.open(coordinate, createProductScheduleReturnSurface(surface, itemRef), title);
  return (
    <div className="min-w-0">
      {target.unavailable ? <ArtifactUnavailable onRetry={target.retry} /> : null}
      <ProductSchedulePanel
        selectedItemRef={selectedItemRef}
        onOpenArtifact={openArtifact}
        artifactsLoading={target.loading}
        onOpenReview={(review, itemRef) =>
          target.openReview(review, createProductScheduleReturnSurface(surface, itemRef))
        }
      />
      {target.lightbox}
    </div>
  );
}

export function NeedsMeOwnerSurface({
  surface,
  onOpenSurface,
  onOpenArtifactWithReturn,
  onRefreshSurface,
}: ArtifactReturnProps & {
  onOpenSurface: (surface: WorkspaceSurfaceDescriptor) => void;
  onRefreshSurface: (surface: WorkspaceSurfaceDescriptor) => void;
}) {
  const presentation = useShellPresentation();
  const target = usePreparedArtifactReturn(onOpenArtifactWithReturn);
  const selectedItemRef = resolveNeedsMeReturnTarget(surface)?.itemRef ?? null;
  const returnSurface = useCallback((itemRef: string) => createNeedsMeReturnSurface(surface, itemRef), [surface]);
  const openArtifact = (coordinate: PreparedArtifactCoordinate, itemRef: string, title?: string) =>
    target.open(coordinate, returnSurface(itemRef), title);
  const openAction = useCallback(
    (actionRef: string, itemRef: string) => {
      const selectedSurface = returnSurface(itemRef);
      if (!selectedSurface) return;
      const reviewMatch = /^content-review:(review-[a-f0-9]{64})$/.exec(actionRef);
      if (reviewMatch?.[1]) {
        void target.openReviewAction(reviewMatch[1], selectedSurface);
        return;
      }
      const actionTarget = resolveEntrustedWorkActionTarget(actionRef);
      if (!actionTarget) return;
      onRefreshSurface(selectedSurface);
      if (
        actionTarget.kind === 'message' ||
        actionTarget.kind === 'collective-work' ||
        actionTarget.kind === 'collective-accountability' ||
        actionTarget.kind === 'collective-project'
      ) {
        navigateToEntrustedWorkAction(actionRef);
        return;
      }
      if (presentation === 'v2') {
        openMailbox({ section: 'pending', proposalId: actionTarget.proposalId });
        return;
      }
      const approvalSurface = createApprovalActionSurface(selectedSurface, actionTarget.proposalId);
      if (approvalSurface) onOpenSurface(approvalSurface);
    },
    [onOpenSurface, onRefreshSurface, presentation, returnSurface, target.openReviewAction],
  );
  return (
    <div className="min-w-0">
      {target.unavailable ? <ArtifactUnavailable onRetry={target.retry} /> : null}
      <NeedsMePanel
        artifactsLoading={target.loading}
        selectedItemRef={selectedItemRef}
        onOpenArtifact={openArtifact}
        onOpenAction={openAction}
        onOpenReview={(review, itemRef) => target.openReview(review, returnSurface(itemRef))}
      />
      {target.lightbox}
    </div>
  );
}
