'use client';
import type { CollectiveEventEnvelope } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export interface ParticipationView {
  revision: number;
  published: boolean;
  reconcileRequired: boolean;
  cats: {
    id: string;
    displayName: string;
    configured: boolean;
    eligible: boolean;
    supported: boolean;
    avatar?: string;
    roleDescription?: string;
    defaultModel?: string;
  }[];
  desiredParticipation: {
    defaultMode: 'include';
    excludedCatIds: string[];
    channelOverrides: Record<string, { excludedCatIds: string[] }>;
  };
  observedEligibility: Record<string, { displayName: string; configured: boolean; eligible: boolean }>;
  channelRoutes: Record<
    string,
    { channelId: string; threadId: string; participants: Record<string, { displayName: string }> }
  >;
  standingInterests: Record<
    string,
    Record<
      string,
      {
        catId: string;
        kind: 'response_requests';
        status: 'active' | 'withdrawn';
        revision: number;
        updatedAt: string;
      }
    >
  >;
  attentionRevision: number;
  bindings: Record<
    string,
    {
      catId: string;
      threadId: string;
      participation?: { channelIds: string[] };
      standingWork?: {
        requestingHumanIds: string[];
        threadId: string;
        expiresAt: string | null;
        channelIds?: string[];
      };
    }
  >;
  threads: { id: string; title?: string }[];
  requests: {
    event: CollectiveEventEnvelope;
    messageId?: string;
    delivery: string;
    failure?: { code: string };
    privateThread?: { id: string; title?: string };
    execution?: { stage: 'queued' | 'started' | 'ended' | 'failed' };
    attention?:
      | { request: 'response_requested'; state: 'unclaimed' }
      | {
          request: 'response_requested';
          state: 'wake_queued';
          catId: string;
          interestRevision: number;
        };
    response?: CollectiveEventEnvelope;
  }[];
  tasks: {
    id: string;
    title: string;
    threadId: string;
    status: string;
    revision: number;
    closure: string;
    sourceRefs: string[];
  }[];
}

export function useCollectiveParticipation(connectionId: string) {
  const [view, setView] = useState<ParticipationView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const busyRef = useRef(false);
  const readRevision = useRef(0);
  const base = `/api/plugins/collective-connector/${encodeURIComponent(connectionId)}`;
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const revision = ++readRevision.current;
      const response = await apiFetch(`${base}/participation`, { signal }, { afterCurrentGet: true });
      if (!response.ok) throw new Error('暂时无法读取参与设置，请重试。');
      const data = (await response.json()) as ParticipationView;
      if (
        !Array.isArray(data.cats) ||
        !Array.isArray(data.requests) ||
        !Array.isArray(data.tasks) ||
        !data.bindings ||
        !data.desiredParticipation ||
        !data.channelRoutes ||
        !data.standingInterests ||
        !Number.isInteger(data.attentionRevision) ||
        !Number.isInteger(data.revision)
      )
        throw new Error('参与设置暂不可用，请稍后重试。');
      if (signal?.aborted || revision !== readRevision.current) return;
      setView(data);
      setError(undefined);
    },
    [base],
  );
  useEffect(() => {
    const abort = new AbortController();
    const refresh = () => {
      if (busyRef.current) return;
      void load(abort.signal).catch((cause) => {
        if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : '读取失败，请重试。');
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => {
      abort.abort();
      readRevision.current++;
      window.clearInterval(timer);
    };
  }, [load]);
  const mutate = async (path: string, body: Record<string, unknown>, method = 'POST') => {
    if (busyRef.current) return;
    busyRef.current = true;
    readRevision.current++;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const operationKey = resumeOperationKey(path, connectionId, body);
      if (operationKey) {
        const requestId = localStorage.getItem(operationKey) ?? crypto.randomUUID();
        localStorage.setItem(operationKey, requestId);
        body = { ...body, requestId };
      }
      const response = await apiFetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = (await response.json()) as { code?: string; result?: string; disposition?: string };
      if (!response.ok) throw new Error(actionError(result.code, result.result));
      if (operationKey) localStorage.removeItem(operationKey);
      setNotice(successNotice(path, result.disposition));
      await load();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作未完成，请重试。');
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return { view, busy, error, notice, mutate, reload: () => load().catch((cause) => setError(cause.message)) };
}

function resumeOperationKey(path: string, connectionId: string, body: Record<string, unknown>) {
  return path === '/work/resume'
    ? `collective-work-resume:${connectionId}:${body.taskId}:${body.observedRevision}`
    : undefined;
}

function successNotice(path: string, disposition?: string) {
  if (path === '/participation/reconcile') return '家里的可参与伙伴已自动接入。';
  if (path === '/participation' || path === '/participation/policy') return '参与设置已发布。';
  return disposition === 'queued'
    ? '已进入猫的私人执行队列；完成情况会留在原工作里。'
    : '已恢复原执行记录；完成情况可以在私人工作里查看。';
}

export function useCollectiveAutoReconcile(
  state: ReturnType<typeof useCollectiveParticipation>,
  channels: readonly string[],
  enabled = true,
) {
  const attempt = useRef<string>();
  const channelKey = [...new Set(channels)].sort().join('\u0000');
  useEffect(() => {
    const channelIds = channelKey ? channelKey.split('\u0000') : [];
    if (!state.view || !enabled || !needsReconcile(state.view, channelIds)) return;
    const key = `${state.view.revision}:${channelKey}`;
    if (attempt.current === key) return;
    attempt.current = key;
    void state.mutate('/participation/reconcile', { expectedRevision: state.view.revision, channelIds }, 'POST');
  }, [channelKey, enabled, state]);
}

function needsReconcile(view: ParticipationView, channelIds: readonly string[]) {
  if (!channelIds.length) return false;
  if (view.reconcileRequired || !view.published) return true;
  if (Object.keys(view.channelRoutes).sort().join('\u0000') !== [...channelIds].sort().join('\u0000')) return true;
  return channelIds.some((channelId) => {
    const expected = view.cats
      .filter(
        (cat) =>
          cat.configured &&
          cat.eligible &&
          !view.desiredParticipation.excludedCatIds.includes(cat.id) &&
          !view.desiredParticipation.channelOverrides[channelId]?.excludedCatIds.includes(cat.id),
      )
      .map((cat) => cat.id)
      .sort();
    const materialized = Object.keys(view.channelRoutes[channelId]?.participants ?? {}).sort();
    return expected.join('\u0000') !== materialized.join('\u0000');
  });
}

function actionError(code?: string, result?: string) {
  if (code === 'PARTICIPATION_REVISION_CONFLICT') return '参与设置已被更新，请重新展开后再操作。';
  if (code === 'PARTICIPATION_REVOKED' || code === 'OWNER_ADMISSION_UNAVAILABLE')
    return '当前授权已失效。原工作仍保留，可以打开私人工作安排后续。';
  if (code === 'RETURN_UNAVAILABLE') return '原请求暂不可用，无法继续执行或回流。原工作仍保留。';
  if (result === 'needs_clarification') return '这项请求包含期限，请填写截止时间后再安排。';
  return '操作未完成，请检查连接和当前参与设置后重试。';
}
