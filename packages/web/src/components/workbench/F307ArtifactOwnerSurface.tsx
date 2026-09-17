'use client';

import { ArtifactDetailView } from '@/components/artifacts/ArtifactDetailView';
import { ArtifactReviewEntry } from '@/components/content-review/ReviewArtifactButton';
import { useThreadArtifacts } from '@/hooks/useThreadArtifacts';
import { useChatStore } from '@/stores/chatStore';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { createArtifactReviewSurface } from './artifact-review-surface';
import { F307OwnerUnavailable as OwnerUnavailable } from './F307OwnerUnavailable';
import { artifactObjectId, resolveArtifactTarget } from './real-surface-adapters';
import type { WorkspaceSurfaceDescriptor } from './workbench-contract';

export function F307ArtifactOwnerSurface({
  surface,
  onRequestDetach,
  onOpenSurface,
}: {
  surface: WorkspaceSurfaceDescriptor;
  onRequestDetach: () => void;
  onOpenSurface: (surface: WorkspaceSurfaceDescriptor) => void;
}) {
  const target = resolveArtifactTarget(surface);
  const { artifacts, loading, error } = useThreadArtifacts(target?.threadId);
  const hostThreadId = useChatStore((state) => state.currentThreadId);
  const hostWorktreeId = useChatStore((state) => state.workspaceWorktreeId);
  if (!target) return <OwnerUnavailable message="Artifact descriptor 没有合法的 F232 owner 引用。" />;
  if (loading) return <div className="p-5 text-xs text-cafe-muted">正在从原 Thread 恢复产物…</div>;
  if (error) return <OwnerUnavailable message="F232 产物 owner 暂时不可用；Workbench 没有猜测或复制内容。" />;
  const artifact = artifacts.find((candidate) => artifactObjectId(candidate) === target.artifactId);
  if (!artifact) return <OwnerUnavailable message="原 owner 已找不到这个产物；其余 Workbench surface 保持可用。" />;
  return (
    <ArtifactDetailView
      artifact={artifact}
      worktreeId={target.threadId === hostThreadId ? hostWorktreeId : null}
      onBack={onRequestDetach}
      onJump={(messageId) => scrollToMessage(messageId)}
      reviewAction={
        artifact.url && /\.(png|mp4)$/i.test(artifact.url) ? (
          <ArtifactReviewEntry
            artifactRef={artifact.url}
            threadId={target.threadId}
            onPrepared={(review) =>
              onOpenSurface(
                createArtifactReviewSurface(review.review.reviewId, review.review.task.threadId, review.review.title),
              )
            }
          />
        ) : undefined
      }
    />
  );
}
