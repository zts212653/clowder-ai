'use client';

import type { CollectiveAcceptedWorkResult } from '@cat-cafe/shared';
import { useCallback, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export function useAcceptedWorkReconciliation() {
  const [notice, setNotice] = useState<string>();
  const reconcile = useCallback(async (input: CollectiveAcceptedWorkResult) => {
    try {
      await reconcileAcceptedWorkResult(input);
      setNotice(undefined);
    } catch (cause) {
      setNotice(cause instanceof WorkReconciliationPending ? cause.message : genericPendingMessage);
      throw cause;
    }
  }, []);
  return { notice, reconcile };
}

const genericPendingMessage = '公共结果已验收；我的 Café 尚未同步原 Task。无需重新验收。';
class WorkReconciliationPending extends Error {}

async function reconcileAcceptedWorkResult(input: CollectiveAcceptedWorkResult): Promise<void> {
  const response = await apiFetch(
    `/api/plugins/official.collective-connector/connections/${encodeURIComponent(input.connectionId)}/work/result/accepted`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw new WorkReconciliationPending(workReconciliationPendingMessage(body));
  if (isCompletedWorkReconciliation(body)) return;
  const pending = typeof body === 'object' && body !== null && 'result' in body && body.result === 'not_admitted';
  throw new WorkReconciliationPending(
    pending ? '公共结果已验收；我的 Café 还在等待原 Task 建立后同步。无需重新验收。' : genericPendingMessage,
  );
}

function workReconciliationPendingMessage(value: unknown): string {
  const code =
    typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string'
      ? value.code
      : undefined;
  if (code === 'OWNER_ADOPTION_REQUIRED') return '公共结果已验收；原 Task 仍在等待我的 Café 接管。无需重新验收。';
  if (code === 'COLLECTIVE_RESULT_TERMINAL_CONFLICT')
    return '公共结果已验收；原 Task 已是终态，家内没有改写它。无需重新验收。';
  return genericPendingMessage;
}

function isCompletedWorkReconciliation(
  value: unknown,
): value is { result: 'closed' | 'already_closed'; taskId: string; revision: number } {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'result' in value &&
      (value.result === 'closed' || value.result === 'already_closed') &&
      'taskId' in value &&
      typeof value.taskId === 'string' &&
      value.taskId.length > 0 &&
      'revision' in value &&
      typeof value.revision === 'number' &&
      Number.isSafeInteger(value.revision) &&
      value.revision > 0,
  );
}
