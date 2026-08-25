'use client';

import type {
  InvocationTrajectorySummary,
  RequestGenerationGapV1,
  RequestGenerationProjectionV1,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SessionEventsViewer } from '@/components/audit/SessionEventsViewer';
import { SessionSearchTab } from '@/components/audit/SessionSearchTab';
import { SessionChainPanel } from '@/components/SessionChainPanel';
import { subscribeBrowserThreadRoute } from '@/components/ThreadSidebar/thread-navigation';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { type ResolvedTrajectoryTarget, useCanonicalTrajectoryTarget } from './canonical-trajectory-resolution';
import { type InvocationDetailResponse, InvocationTrajectoryDetail } from './InvocationTrajectoryDetail';
import { InvocationTrajectoryList } from './InvocationTrajectoryList';
import { reconcileInvocationSummary } from './invocation-trajectory-model';
import { TrajectoryResolutionFailure, TrajectoryResolutionLoading } from './TrajectoryResolutionState';
import {
  clearInvocationTrajectoryUrl,
  openInvocationTrajectory,
  readTrajectoryTarget,
  restoreTrajectoryOrigin,
  restoreTrajectoryPromptMessage,
  TRAJECTORY_OPEN_EVENT,
  type TrajectoryTarget,
} from './trajectory-navigation';

type PanelTab = 'trajectory' | 'sessions' | 'search';
type InvocationListState = { threadId?: string; items: InvocationTrajectorySummary[] };
type SessionViewerTarget = { threadId: string; id: string; catId?: string };
type RequestGenerationsResponse = {
  invocationId: string;
  threadId: string;
  generations: RequestGenerationProjectionV1[];
  gaps?: RequestGenerationGapV1[];
};

async function fetchInvocationSummaries(threadId: string): Promise<InvocationTrajectorySummary[]> {
  const response = await apiFetch(`/api/threads/${threadId}/invocations?limit=500`);
  if (!response.ok) throw new Error(`轨迹载入失败 (${response.status})`);
  const body = (await response.json()) as { invocations?: InvocationTrajectorySummary[] };
  return body.invocations ?? [];
}

function selectInvocationSummary(
  invocations: InvocationTrajectorySummary[],
  target: TrajectoryTarget | undefined,
): InvocationTrajectorySummary | undefined {
  if (!target) return undefined;
  return invocations.find(
    (summary) =>
      summary.invocationId === target.invocationId &&
      (target.sessionId === undefined || summary.sessionId === target.sessionId),
  );
}

function invocationItemsForThread(list: InvocationListState, threadId: string | undefined) {
  return list.threadId === threadId ? list.items : [];
}

function threadScopedRecord<T>(
  record: Record<string, T>,
  requestedThreadId: string | undefined,
  currentThreadId: string,
): Record<string, T> {
  return requestedThreadId === currentThreadId ? record : {};
}

function invocationDetailMatchesTarget(
  detail: InvocationDetailResponse,
  target: ResolvedTrajectoryTarget,
  sessionId: string,
): boolean {
  const summary = detail.summary;
  if (
    detail.invocationId !== target.invocationId ||
    summary?.invocationId !== target.invocationId ||
    summary.threadId !== target.threadId ||
    summary.sessionId !== sessionId
  ) {
    return false;
  }
  return detail.events.every(
    (event) =>
      event.threadId === target.threadId && event.sessionId === sessionId && event.invocationId === target.invocationId,
  );
}

function requestGenerationsUrl(target: ResolvedTrajectoryTarget, reveal = false): string {
  const query = new URLSearchParams({ threadId: target.threadId, sessionId: target.sessionId });
  if (reveal) query.set('reveal', 'exact');
  return `/api/invocations/${encodeURIComponent(target.invocationId)}/request-generations?${query.toString()}`;
}

export function TrajectoryPanel({ threadId }: { threadId?: string }) {
  const currentThreadId = useChatStore((state) => state.currentThreadId);
  const catInvocations = useChatStore((state) => state.catInvocations);
  const activeInvocations = useChatStore((state) => state.activeInvocations);
  const activeThreadId = threadId ?? currentThreadId;
  const [tab, setTab] = useState<PanelTab>('trajectory');
  const [invocationList, setInvocationList] = useState<InvocationListState>({ items: [] });
  const [target, setTarget] = useState<TrajectoryTarget | undefined>(() =>
    typeof window === 'undefined' ? undefined : readTrajectoryTarget(new URL(window.location.href)),
  );
  const [detail, setDetail] = useState<InvocationDetailResponse | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState(false);
  const [requestGenerations, setRequestGenerations] = useState<RequestGenerationProjectionV1[] | null>(null);
  const [requestGenerationGaps, setRequestGenerationGaps] = useState<RequestGenerationGapV1[]>([]);
  const [generationsLoading, setGenerationsLoading] = useState(false);
  const [generationsError, setGenerationsError] = useState(false);
  const [revealingGenerations, setRevealingGenerations] = useState(false);
  const [detailReload, setDetailReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sessionViewer, setSessionViewer] = useState<SessionViewerTarget | null>(null);
  const listRequestIdRef = useRef(0);
  const generationsRequestIdRef = useRef(0);
  const { resolvedTarget, resolutionError, resolvingTarget, retryResolution } = useCanonicalTrajectoryTarget(
    target,
    activeThreadId,
  );
  const loadList = useCallback(async () => {
    const requestId = ++listRequestIdRef.current;
    if (!activeThreadId) {
      setInvocationList({ items: [] });
      setLoadingList(false);
      return;
    }
    setLoadingList(true);
    setError(null);
    try {
      const nextInvocations = await fetchInvocationSummaries(activeThreadId);
      if (requestId !== listRequestIdRef.current) return;
      setInvocationList({ threadId: activeThreadId, items: nextInvocations });
    } catch (cause) {
      if (requestId !== listRequestIdRef.current) return;
      setError(cause instanceof Error ? cause.message : '轨迹载入失败');
    } finally {
      if (requestId === listRequestIdRef.current) setLoadingList(false);
    }
  }, [activeThreadId]);

  useEffect(() => {
    void loadList();
  }, [loadList]);
  useEffect(() => {
    void activeThreadId;
    const applyUrlTarget = () => {
      const next = readTrajectoryTarget(new URL(window.location.href));
      setDetail(null);
      setTarget(next);
    };
    applyUrlTarget();
    return subscribeBrowserThreadRoute(applyUrlTarget);
  }, [activeThreadId]);
  useEffect(() => {
    const listener = (event: Event) => {
      const next = (event as CustomEvent<TrajectoryTarget>).detail;
      setTab('trajectory');
      setDetail(null);
      setTarget(next);
    };
    window.addEventListener(TRAJECTORY_OPEN_EVENT, listener);
    return () => window.removeEventListener(TRAJECTORY_OPEN_EVENT, listener);
  }, []);

  const invocations = invocationItemsForThread(invocationList, activeThreadId);
  const threadCatInvocations = threadScopedRecord(catInvocations, activeThreadId, currentThreadId);
  const threadActiveInvocations = threadScopedRecord(activeInvocations, activeThreadId, currentThreadId);
  const scopedTarget = resolvedTarget?.threadId === activeThreadId ? resolvedTarget : undefined;
  const selectedSummary = selectInvocationSummary(invocations, scopedTarget);
  const detailSessionId = scopedTarget?.sessionId;
  const activeSessionViewer = sessionViewer?.threadId === activeThreadId ? sessionViewer : null;
  useEffect(() => {
    void detailReload;
    if (!scopedTarget || !detailSessionId) {
      setDetail(null);
      setDetailError(false);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    setDetailError(false);
    void apiFetch(`/api/sessions/${detailSessionId}/invocations/${encodeURIComponent(scopedTarget.invocationId)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return response.json() as Promise<InvocationDetailResponse>;
      })
      .then((body) => {
        if (cancelled) return;
        if (!invocationDetailMatchesTarget(body, scopedTarget, detailSessionId)) {
          clearInvocationTrajectoryUrl();
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
  }, [detailReload, detailSessionId, scopedTarget]);

  useEffect(() => {
    const requestId = ++generationsRequestIdRef.current;
    if (!scopedTarget) {
      setRequestGenerations(null);
      setRequestGenerationGaps([]);
      setGenerationsLoading(false);
      setGenerationsError(false);
      return;
    }
    setGenerationsLoading(true);
    setGenerationsError(false);
    void apiFetch(requestGenerationsUrl(scopedTarget))
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return response.json() as Promise<RequestGenerationsResponse>;
      })
      .then((body) => {
        if (requestId !== generationsRequestIdRef.current) return;
        if (body.invocationId !== scopedTarget.invocationId || body.threadId !== scopedTarget.threadId) {
          throw new Error('request_generation_scope_mismatch');
        }
        setRequestGenerations(body.generations);
        setRequestGenerationGaps(body.gaps ?? []);
      })
      .catch(() => {
        if (requestId !== generationsRequestIdRef.current) return;
        setRequestGenerations(null);
        setRequestGenerationGaps([]);
        setGenerationsError(true);
      })
      .finally(() => {
        if (requestId === generationsRequestIdRef.current) setGenerationsLoading(false);
      });
  }, [scopedTarget]);

  const revealRequestGenerations = async () => {
    if (!scopedTarget) return;
    const requestId = ++generationsRequestIdRef.current;
    setRevealingGenerations(true);
    setGenerationsError(false);
    try {
      const response = await apiFetch(requestGenerationsUrl(scopedTarget, true));
      if (!response.ok) throw new Error();
      const body = (await response.json()) as RequestGenerationsResponse;
      if (
        requestId !== generationsRequestIdRef.current ||
        body.invocationId !== scopedTarget.invocationId ||
        body.threadId !== scopedTarget.threadId
      ) {
        return;
      }
      setRequestGenerations(body.generations);
      setRequestGenerationGaps(body.gaps ?? []);
    } catch {
      if (requestId === generationsRequestIdRef.current) setGenerationsError(true);
    } finally {
      if (requestId === generationsRequestIdRef.current) setRevealingGenerations(false);
    }
  };

  const openSummary = (summary: InvocationTrajectorySummary) => {
    const next = {
      threadId: summary.threadId,
      sessionId: summary.sessionId,
      invocationId: summary.invocationId,
    };
    setTarget(next);
    openInvocationTrajectory(next);
  };
  const openDirectInvocation = (sessionId: string, invocationId: string) => {
    if (!activeThreadId) return;
    const next = { threadId: activeThreadId, sessionId, invocationId };
    setDetail(null);
    setTarget(next);
    openInvocationTrajectory(next);
  };
  const openSessionViewer = (sessionId: string, catId?: string) => {
    if (!activeThreadId) return;
    setSessionViewer({ threadId: activeThreadId, id: sessionId, catId });
  };
  const back = () => {
    if (target?.originRef) restoreTrajectoryOrigin(target.originRef);
    else clearInvocationTrajectoryUrl();
    setDetail(null);
    setTarget(undefined);
  };

  const displayedSummary = selectedSummary ?? (scopedTarget ? detail?.summary : undefined);
  if (displayedSummary)
    return (
      <InvocationTrajectoryDetail
        key={displayedSummary.invocationId}
        summary={displayedSummary}
        detail={detail}
        loading={loadingDetail}
        error={detailError}
        onBack={back}
        onRetry={() => setDetailReload((value) => value + 1)}
        onOpenPromptMessage={(messageId) => restoreTrajectoryPromptMessage(displayedSummary.threadId, messageId)}
        requestGenerations={requestGenerations}
        requestGenerationGaps={requestGenerationGaps}
        generationsLoading={generationsLoading}
        generationsError={generationsError}
        revealingGenerations={revealingGenerations}
        onRevealGenerations={() => void revealRequestGenerations()}
      />
    );
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

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--console-shell-bg)]" data-testid="trajectory-panel">
      <div className="flex items-center justify-between border-b border-cafe-subtle px-3">
        <div className="flex">
          {(['trajectory', 'sessions', 'search'] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setTab(item)}
              className={`px-3 py-2.5 text-xs font-semibold ${tab === item ? 'border-b-2 border-cafe-accent text-cafe-accent' : 'text-cafe-muted'}`}
            >
              {item === 'trajectory' ? 'Invocations' : item === 'sessions' ? 'Sessions' : '搜索'}
            </button>
          ))}
        </div>
        {tab === 'trajectory' && (
          <button
            type="button"
            onClick={() => void loadList()}
            className="rounded-lg px-2 py-1 text-micro font-semibold text-cafe-secondary hover:bg-cafe-surface"
          >
            刷新
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'trajectory' ? (
          <InvocationTrajectoryList
            invocations={invocations}
            loading={loadingList}
            error={error}
            onOpen={openSummary}
            onRetry={() => void loadList()}
            targetInvocationId={scopedTarget?.invocationId}
          />
        ) : tab === 'sessions' ? (
          <div className="space-y-3 p-3">
            <SessionChainPanel
              threadId={activeThreadId}
              catInvocations={threadCatInvocations}
              activeInvocations={threadActiveInvocations}
              onViewSession={openSessionViewer}
            />
            {activeSessionViewer && (
              <SessionEventsViewer
                sessionId={activeSessionViewer.id}
                catId={activeSessionViewer.catId}
                onClose={() => setSessionViewer(null)}
              />
            )}
          </div>
        ) : (
          <div className="p-3">
            <SessionSearchTab
              threadId={activeThreadId}
              onViewInvocation={(sessionId, invocationId, sourceThreadId) => {
                if (sourceThreadId !== activeThreadId) return;
                const summary = invocations.find(
                  (item) => item.sessionId === sessionId && item.invocationId === invocationId,
                );
                if (summary) openSummary(summary);
                else openDirectInvocation(sessionId, invocationId);
              }}
              onViewSession={(sessionId, sourceThreadId) => {
                if (sourceThreadId !== activeThreadId) return;
                setTab('sessions');
                openSessionViewer(sessionId);
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
