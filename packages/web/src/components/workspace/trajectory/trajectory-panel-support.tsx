'use client';

import type {
  InvocationTrajectorySummary,
  RequestGenerationGapV1,
  RequestGenerationProjectionV1,
} from '@cat-cafe/shared';
import { type Dispatch, type SetStateAction, useEffect } from 'react';
import { subscribeBrowserThreadRoute } from '@/components/ThreadSidebar/thread-navigation';
import { apiFetch } from '@/utils/api-client';
import type { ResolvedTrajectoryTarget, TrajectoryResolutionError } from './canonical-trajectory-resolution';
import { type InvocationDetailResponse, InvocationTrajectoryDetail } from './InvocationTrajectoryDetail';
import { reconcileInvocationSummary } from './invocation-trajectory-model';
import { TrajectoryResolutionFailure, TrajectoryResolutionLoading } from './TrajectoryResolutionState';
import {
  clearInvocationTrajectoryUrl,
  readTrajectoryTarget,
  restoreTrajectoryOrigin,
  restoreTrajectoryPromptMessage,
  TRAJECTORY_OPEN_EVENT,
  type TrajectoryTarget,
} from './trajectory-navigation';

export type PanelTab = 'trajectory' | 'sessions' | 'search';
export type InvocationListState = { threadId?: string; items: InvocationTrajectorySummary[] };

function invocationDetailMatchesTarget(detail: InvocationDetailResponse, target: ResolvedTrajectoryTarget): boolean {
  const summary = detail.summary;
  if (
    detail.invocationId !== target.invocationId ||
    summary?.invocationId !== target.invocationId ||
    summary.threadId !== target.threadId ||
    summary.sessionId !== target.sessionId
  ) {
    return false;
  }
  return detail.events.every(
    (event) =>
      event.threadId === target.threadId &&
      event.sessionId === target.sessionId &&
      event.invocationId === target.invocationId,
  );
}

export function useControlledTrajectoryTarget(
  targetOverride: TrajectoryTarget | undefined,
  setDetail: Dispatch<SetStateAction<InvocationDetailResponse | null>>,
  setTarget: Dispatch<SetStateAction<TrajectoryTarget | undefined>>,
) {
  useEffect(() => {
    if (targetOverride === undefined) return;
    setDetail(null);
    setTarget(targetOverride);
  }, [setDetail, setTarget, targetOverride]);
}

export function useUncontrolledTrajectoryNavigation({
  enabled,
  activeThreadId,
  setDetail,
  setTab,
  setTarget,
}: {
  enabled: boolean;
  activeThreadId: string;
  setDetail: Dispatch<SetStateAction<InvocationDetailResponse | null>>;
  setTab: Dispatch<SetStateAction<PanelTab>>;
  setTarget: Dispatch<SetStateAction<TrajectoryTarget | undefined>>;
}) {
  useEffect(() => {
    if (!enabled) return;
    void activeThreadId;
    const applyUrlTarget = () => {
      setDetail(null);
      setTarget(readTrajectoryTarget(new URL(window.location.href)));
    };
    applyUrlTarget();
    return subscribeBrowserThreadRoute(applyUrlTarget);
  }, [activeThreadId, enabled, setDetail, setTarget]);
  useEffect(() => {
    if (!enabled) return;
    const listener = (event: Event) => {
      setTab('trajectory');
      setDetail(null);
      setTarget((event as CustomEvent<TrajectoryTarget>).detail);
    };
    window.addEventListener(TRAJECTORY_OPEN_EVENT, listener);
    return () => window.removeEventListener(TRAJECTORY_OPEN_EVENT, listener);
  }, [enabled, setDetail, setTab, setTarget]);
}

export function closeTrajectoryDetail(
  controlled: boolean,
  target: TrajectoryTarget | undefined,
  setDetail: Dispatch<SetStateAction<InvocationDetailResponse | null>>,
  setTarget: Dispatch<SetStateAction<TrajectoryTarget | undefined>>,
) {
  if (!controlled) {
    if (target?.originRef) restoreTrajectoryOrigin(target.originRef);
    else clearInvocationTrajectoryUrl();
  }
  setDetail(null);
  setTarget(undefined);
}

export function useInvocationDetail({
  controlled,
  reload,
  target,
  setDetail,
  setDetailError,
  setInvocationList,
  setLoadingDetail,
  setTarget,
}: {
  controlled: boolean;
  reload: number;
  target: ResolvedTrajectoryTarget | undefined;
  setDetail: Dispatch<SetStateAction<InvocationDetailResponse | null>>;
  setDetailError: Dispatch<SetStateAction<boolean>>;
  setInvocationList: Dispatch<SetStateAction<InvocationListState>>;
  setLoadingDetail: Dispatch<SetStateAction<boolean>>;
  setTarget: Dispatch<SetStateAction<TrajectoryTarget | undefined>>;
}) {
  useEffect(() => {
    void reload;
    if (!target) {
      setDetail(null);
      setDetailError(false);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    setDetailError(false);
    void apiFetch(`/api/sessions/${target.sessionId}/invocations/${encodeURIComponent(target.invocationId)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return response.json() as Promise<InvocationDetailResponse>;
      })
      .then((body) => {
        if (cancelled) return;
        if (!invocationDetailMatchesTarget(body, target)) {
          if (!controlled) clearInvocationTrajectoryUrl();
          setTarget(undefined);
          setDetail(null);
          return;
        }
        setDetail(body);
        if (body.summary) {
          setInvocationList((current) => ({
            ...current,
            items: current.items.map((item) =>
              item.invocationId === body.summary?.invocationId && item.sessionId === body.summary.sessionId
                ? reconcileInvocationSummary(item, body.summary)
                : item,
            ),
          }));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDetail(null);
          setDetailError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [controlled, reload, setDetail, setDetailError, setInvocationList, setLoadingDetail, setTarget, target]);
}

export function renderTrajectoryTargetState({
  activeThreadId,
  back,
  detail,
  detailError,
  displayedSummary,
  generationsError,
  generationsLoading,
  loadingDetail,
  onRetryDetail,
  onRevealGenerations,
  requestGenerationGaps,
  requestGenerations,
  resolutionError,
  resolvedTarget,
  resolvingTarget,
  revealingGenerations,
  retryResolution,
  scopedTarget,
  target,
}: {
  activeThreadId: string;
  back: () => void;
  detail: InvocationDetailResponse | null;
  detailError: boolean;
  displayedSummary: InvocationTrajectorySummary | undefined;
  generationsError: boolean;
  generationsLoading: boolean;
  loadingDetail: boolean;
  onRetryDetail: () => void;
  onRevealGenerations: () => void;
  requestGenerationGaps: RequestGenerationGapV1[];
  requestGenerations: RequestGenerationProjectionV1[] | null;
  resolutionError: TrajectoryResolutionError | null;
  resolvedTarget: ResolvedTrajectoryTarget | undefined;
  resolvingTarget: boolean;
  revealingGenerations: boolean;
  retryResolution: () => void;
  scopedTarget: ResolvedTrajectoryTarget | undefined;
  target: TrajectoryTarget | undefined;
}) {
  if (displayedSummary) {
    return (
      <InvocationTrajectoryDetail
        key={displayedSummary.invocationId}
        summary={displayedSummary}
        detail={detail}
        loading={loadingDetail}
        error={detailError}
        onBack={back}
        onRetry={onRetryDetail}
        onOpenPromptMessage={(messageId) => restoreTrajectoryPromptMessage(displayedSummary.threadId, messageId)}
        requestGenerations={requestGenerations}
        requestGenerationGaps={requestGenerationGaps}
        generationsLoading={generationsLoading}
        generationsError={generationsError}
        revealingGenerations={revealingGenerations}
        onRevealGenerations={onRevealGenerations}
      />
    );
  }
  if (target && resolutionError) {
    return (
      <TrajectoryResolutionFailure target={target} error={resolutionError} onRetry={retryResolution} onBack={back} />
    );
  }
  if (target && scopedTarget && detailError) {
    return (
      <div
        className="flex h-full items-center justify-center p-4 text-sm text-cafe-muted"
        data-testid="trajectory-direct-open"
      >
        <button
          type="button"
          className="rounded-lg border border-cafe px-3 py-2 font-semibold text-cafe-secondary"
          onClick={back}
        >
          轨迹读取失败，返回列表
        </button>
      </div>
    );
  }
  if (target && (resolvingTarget || !scopedTarget)) {
    return (
      <TrajectoryResolutionLoading
        switchingThread={Boolean(resolvedTarget && resolvedTarget.threadId !== activeThreadId)}
      />
    );
  }
  return null;
}
