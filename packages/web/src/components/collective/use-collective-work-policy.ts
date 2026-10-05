'use client';
import type { CollectiveHostWorkPolicyAction, CollectiveWorkPolicy } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { type CollectiveWorkPolicyBridge, CollectiveWorkPolicyConflict } from './use-collective-work-policy-bridge';

export interface WorkPolicyStatus {
  policy: CollectiveWorkPolicy | null;
  localAdoption: {
    revision: number;
    decisionMode: 'automatic' | 'manual';
    pendingRevocations: string[];
    grants: {
      grantRef: string;
      grantRevision: number;
      state: 'active' | 'changed' | 'blocked' | 'expired';
      decisionMode: 'automatic' | 'manual';
    }[];
  } | null;
}
export interface ListeningStatus {
  attentionRevision: number;
  channelListening: Record<string, { mode: 'mentions' | 'all'; dutyCatId?: string }>;
}
export function useCollectiveWorkPolicy(connectionId: string, bridge?: CollectiveWorkPolicyBridge) {
  const [status, setStatus] = useState<WorkPolicyStatus>();
  const [listening, setListening] = useState<ListeningStatus>();
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<string>();
  const [error, setError] = useState<string>();
  const [newDecisionAvailable, setNewDecisionAvailable] = useState(false);
  const running = useRef(false);
  const current = useRef(connectionId);
  current.current = connectionId;
  const base = `/api/plugins/collective-connector/${encodeURIComponent(connectionId)}`;
  const read = useCallback(async () => {
    const [policy, attention] = await Promise.all([
      hostRequest<WorkPolicyStatus>(`${base}/work-policy`),
      hostRequest<ListeningStatus>(`${base}/listening`),
    ]);
    if (current.current !== connectionId) return;
    setStatus(policy);
    setListening(attention);
  }, [base, connectionId]);
  useEffect(() => {
    let closed = false;
    const refresh = () => {
      if (!running.current)
        void read().catch(() => {
          if (!closed) setError('暂时无法读取授权设置。');
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => {
      closed = true;
      window.clearInterval(timer);
    };
  }, [read]);
  const run = async (operation: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(undefined);
    setNewDecisionAvailable(false);
    setPhase('更新中…');
    try {
      await operation();
      await read();
    } catch (cause) {
      setNewDecisionAvailable(cause instanceof CollectiveWorkPolicyConflict);
      setError(cause instanceof Error ? cause.message : '更改未成功。');
      await read().catch(() => undefined);
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const change = (action: CollectiveHostWorkPolicyAction) =>
    run(async () => {
      if (!bridge) throw new Error('请从已连接的共同体登录会话打开设置。');
      const receipt = await bridge.command(action);
      if (action.kind === 'decline_request') {
        setPhase('已拒绝这项提议');
        bridge.acknowledge(action);
        return;
      }
      if (!receipt.policyRevision) throw new Error('登记结果尚未确认。');
      setPhase('Service 已登记，等待本机采用');
      await hostRequest(`${base}/work-policy/adopt`, { expectedPolicyRevision: receipt.policyRevision });
      const request = bridge.permissionRequest;
      if (action.kind === 'allow_request') {
        if (
          !request ||
          request.workId !== action.workId ||
          request.workRevision !== action.workRevision ||
          !receipt.grantRef ||
          !receipt.grantRevision
        )
          throw new Error('规则已登记；原提议已变化，请回到原消息重新读取。');
        await hostRequest(`${base}/work/reconsider`, {
          sourceEventId: request.sourceEventId,
          catId: request.catId,
          grantRef: receipt.grantRef,
          grantRevision: receipt.grantRevision,
          requestKind: request.requestKind,
        });
        setPhase('规则已生效，猫将重新判断原请求');
      } else setPhase('已生效');
      bridge.acknowledge(action);
    });
  return {
    status,
    listening,
    busy,
    phase,
    error,
    newDecisionAvailable,
    read,
    change,
    newDecision: (action: CollectiveHostWorkPolicyAction) => {
      if (!newDecisionAvailable || !bridge) return;
      bridge.newDecision(action);
      return change(action);
    },
    withdraw: (grantRef: string) =>
      run(() => hostRequest(`${base}/work-policy/revoke`, { grantRefs: [grantRef] }).then(() => undefined)),
    adopt: () =>
      run(async () => {
        if (!status?.policy) throw new Error('尚无可采用的授权。');
        await hostRequest(`${base}/work-policy/adopt`, { expectedPolicyRevision: status.policy.revision });
      }),
    listen: (channelId: string, mode: 'mentions' | 'all', dutyCatId?: string) =>
      run(async () => {
        if (!listening) throw new Error('请先读取当前听取设置。');
        await hostRequest(`${base}/listening`, {
          channelId,
          mode,
          expectedAttentionRevision: listening.attentionRevision,
          ...(mode === 'all' ? { dutyCatId } : {}),
        });
      }),
  };
}
async function hostRequest<T = unknown>(url: string, body?: Record<string, unknown>): Promise<T> {
  const response = await apiFetch(
    url,
    body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined,
  );
  const result = await response.json();
  if (!response.ok) {
    if (result.code === 'WORK_POLICY_REVISION_CONFLICT' || result.code === 'WORK_DELEGATION_UNAVAILABLE')
      throw new CollectiveWorkPolicyConflict('旧规则已失效；重试只核对原决定。可以明确重新授权。');
    throw new Error('当前授权或连接已变化，更改未成功。请重新读取后重试。');
  }
  return result as T;
}
export type CollectiveWorkPolicyState = ReturnType<typeof useCollectiveWorkPolicy>;
