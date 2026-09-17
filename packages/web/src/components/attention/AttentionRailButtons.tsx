'use client';

import { useCallback, useMemo } from 'react';
import { useEntrustedWorkProjection } from '@/hooks/useEntrustedWorkProjection';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { useChatStore } from '@/stores/chatStore';
import { selectNeedsMeItems } from '../growing/needs-me-items';
import { useF307ExperienceWorkbenchStore } from '../workbench/experience-workbench-store';
import { resolveApprovalActionTarget, resolveNeedsMeReturnTarget } from '../workbench/real-surface-adapters';

function ApprovalIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
      <title>审批</title>
      <path
        d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function NeedsMeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
      <title>Needs Me</title>
      <path
        d="M12 3a4 4 0 0 0-4 4v3.5M12 3a4 4 0 0 1 4 4v3.5M8 9.5H6.5a2 2 0 0 0-2 2v1.75A7.75 7.75 0 0 0 12.25 21h.5a6.75 6.75 0 0 0 6.75-6.75V12a2 2 0 0 0-4 0v-1a2 2 0 0 0-4 0v-1a2 2 0 0 0-4 0v3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CountBadge({ count, kind }: { count: number; kind: 'approval' | 'needs-me' }) {
  if (count <= 0) return null;
  return (
    <span
      className="absolute -top-0.5 -right-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-micro font-bold"
      style={{
        backgroundColor: kind === 'approval' ? 'var(--semantic-warning)' : 'var(--cafe-accent)',
        color: 'var(--cafe-accent-foreground)',
        maxWidth: '22px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
      data-testid={kind === 'approval' ? 'approval-hub-badge' : 'needs-me-badge'}
      aria-hidden="true"
    >
      {count > 99 ? '99+' : String(count)}
    </span>
  );
}

function ApprovalHubButton() {
  const count = useApprovalHubStore((state) => state.count);
  const isLoading = useApprovalHubStore((state) => state.isLoading);
  const error = useApprovalHubStore((state) => state.error);
  const fetchPending = useApprovalHubStore((state) => state.fetchPending);
  const setWorkspaceMode = useChatStore((state) => state.setWorkspaceMode);
  const rightPanelMode = useChatStore((state) => state.rightPanelMode);
  const rightPanelOpen = useChatStore((state) => state.rightPanelOpen);
  const closeRightPanel = useChatStore((state) => state.closeRightPanel);
  const approvalSurfaceActive = useF307ExperienceWorkbenchStore((state) => {
    const activeSurface = state.layout.surfaces.find((surface) => surface.id === state.layout.activeSurfaceId);
    return activeSurface ? resolveApprovalActionTarget(activeSurface) !== null : false;
  });

  const handleClick = useCallback(() => {
    if (approvalSurfaceActive && rightPanelMode === 'workspace' && rightPanelOpen) {
      closeRightPanel();
      return;
    }
    setWorkspaceMode('approval');
    fetchPending();
  }, [approvalSurfaceActive, rightPanelMode, rightPanelOpen, closeRightPanel, setWorkspaceMode, fetchPending]);

  const visibleCount = isLoading || error ? 0 : count;
  const label = isLoading
    ? '审批正在读取'
    : error
      ? '审批暂时不可用'
      : visibleCount > 0
        ? `审批 · ${visibleCount} 项待处理`
        : '审批';
  return (
    <button
      type="button"
      onClick={handleClick}
      className="relative flex h-10 w-10 items-center justify-center rounded-lg transition-all hover:bg-[var(--console-rail-item)] hover:shadow-[var(--console-rail-shadow)]"
      title={label}
      aria-label={visibleCount > 0 ? `审批，${visibleCount} 项待处理` : label}
      data-testid="approval-hub-button"
    >
      <ApprovalIcon />
      <CountBadge count={visibleCount} kind="approval" />
    </button>
  );
}

function NeedsMeButton() {
  const projection = useEntrustedWorkProjection('needs-me');
  const count = useMemo(
    () => (projection.loading || projection.error ? 0 : selectNeedsMeItems(projection.ownerReads).length),
    [projection.error, projection.loading, projection.ownerReads],
  );
  const setWorkspaceMode = useChatStore((state) => state.setWorkspaceMode);
  const rightPanelMode = useChatStore((state) => state.rightPanelMode);
  const rightPanelOpen = useChatStore((state) => state.rightPanelOpen);
  const closeRightPanel = useChatStore((state) => state.closeRightPanel);
  const needsMeSurfaceActive = useF307ExperienceWorkbenchStore((state) => {
    const activeSurface = state.layout.surfaces.find((surface) => surface.id === state.layout.activeSurfaceId);
    return activeSurface ? resolveNeedsMeReturnTarget(activeSurface) !== null : false;
  });

  const handleClick = useCallback(() => {
    if (needsMeSurfaceActive && rightPanelMode === 'workspace' && rightPanelOpen) {
      closeRightPanel();
      return;
    }
    setWorkspaceMode('needs-me');
    projection.refetch();
  }, [closeRightPanel, needsMeSurfaceActive, projection.refetch, rightPanelMode, rightPanelOpen, setWorkspaceMode]);

  const label = projection.loading
    ? 'Needs Me 正在读取'
    : projection.error
      ? 'Needs Me 暂时不可用'
      : count > 0
        ? `Needs Me · ${count} 项待处理`
        : 'Needs Me';

  return (
    <button
      type="button"
      onClick={handleClick}
      className="relative flex h-10 w-10 items-center justify-center rounded-lg transition-all hover:bg-[var(--console-rail-item)] hover:shadow-[var(--console-rail-shadow)]"
      title={label}
      aria-label={label}
      data-testid="needs-me-button"
    >
      <NeedsMeIcon />
      <CountBadge count={count} kind="needs-me" />
    </button>
  );
}

/** F246 Approval and F310 Needs Me share placement, never count or ownership truth. */
export function AttentionRailButtons() {
  return (
    <>
      <ApprovalHubButton />
      <NeedsMeButton />
    </>
  );
}
