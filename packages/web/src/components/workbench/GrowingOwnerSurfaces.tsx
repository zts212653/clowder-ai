'use client';

import type { ArtifactReviewView } from '@cat-cafe/shared';
import { useCallback, useState } from 'react';
import { invalidateArtifactReviewAccess } from '@/components/content-review/review-access-invalidation';
import { NeedsMePanel } from '@/components/growing/NeedsMePanel';
import { type PreparedArtifactCoordinate, ProductSchedulePanel } from '@/components/growing/ProductSchedulePanel';
import { resolvePreparedArtifact } from '@/components/growing/resolve-prepared-artifact';
import { useGlobalArtifacts } from '@/hooks/useGlobalArtifacts';
import { navigateToEntrustedWorkAction, resolveEntrustedWorkActionTarget } from '@/hooks/useWorkspaceNavigate';
import { apiFetch } from '@/utils/api-client';
import { createArtifactReviewSurface, reviewSurfaceFromPreparedRef } from './artifact-review-surface';
import {
  createApprovalActionSurface,
  createArtifactSurface,
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
  const { artifacts, loading, refetch } = useGlobalArtifacts(true);
  const [unavailable, setUnavailable] = useState(false);
  const openReview = useCallback(
    (review: ArtifactReviewView, returnSurface: WorkspaceSurfaceDescriptor | null) => {
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
  const open = useCallback(
    (coordinate: PreparedArtifactCoordinate, returnSurface: WorkspaceSurfaceDescriptor | null) => {
      const reviewSurface = reviewSurfaceFromPreparedRef(coordinate.openInWorkspaceRef);
      if (reviewSurface && returnSurface) {
        setUnavailable(false);
        onOpen({ artifact: reviewSurface, returnSurface });
        return;
      }
      if (loading) return;
      const artifact = resolvePreparedArtifact(artifacts, coordinate);
      if (!artifact || !returnSurface) {
        setUnavailable(true);
        return;
      }
      setUnavailable(false);
      onOpen({ artifact: createArtifactSurface({ threadId: artifact.threadId, artifact }), returnSurface });
    },
    [artifacts, loading, onOpen],
  );
  const retry = useCallback(() => {
    refetch();
    window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated'));
  }, [refetch]);
  return { artifacts, loading, open, openReview, openReviewAction, unavailable, retry };
}

export function ProductScheduleOwnerSurface({ surface, onOpenArtifactWithReturn }: ArtifactReturnProps) {
  const target = usePreparedArtifactReturn(onOpenArtifactWithReturn);
  const selectedItemRef = resolveProductScheduleReturnTarget(surface)?.itemRef ?? null;
  const openArtifact = (coordinate: PreparedArtifactCoordinate, itemRef: string) =>
    target.open(coordinate, createProductScheduleReturnSurface(surface, itemRef));
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
  const target = usePreparedArtifactReturn(onOpenArtifactWithReturn);
  const selectedItemRef = resolveNeedsMeReturnTarget(surface)?.itemRef ?? null;
  const returnSurface = useCallback((itemRef: string) => createNeedsMeReturnSurface(surface, itemRef), [surface]);
  const openArtifact = (coordinate: PreparedArtifactCoordinate, itemRef: string) =>
    target.open(coordinate, returnSurface(itemRef));
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
      if (actionTarget.kind === 'message') {
        navigateToEntrustedWorkAction(actionRef);
        return;
      }
      const approvalSurface = createApprovalActionSurface(selectedSurface, actionTarget.proposalId);
      if (approvalSurface) onOpenSurface(approvalSurface);
    },
    [onOpenSurface, onRefreshSurface, returnSurface, target.openReviewAction],
  );
  return (
    <div className="min-w-0">
      {target.unavailable ? <ArtifactUnavailable onRetry={target.retry} /> : null}
      <NeedsMePanel
        artifacts={target.artifacts}
        artifactsLoading={target.loading}
        selectedItemRef={selectedItemRef}
        onOpenArtifact={openArtifact}
        onOpenAction={openAction}
        onOpenReview={(review, itemRef) => target.openReview(review, returnSurface(itemRef))}
      />
    </div>
  );
}
