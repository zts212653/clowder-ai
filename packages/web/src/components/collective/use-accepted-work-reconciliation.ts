'use client';

import type { CollectiveAcceptedWorkResult } from '@cat-cafe/shared';
import { useCallback, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export function useAcceptedWorkReconciliation() {
  const [error, setError] = useState<string>();
  const reconcile = useCallback(async (input: CollectiveAcceptedWorkResult) => {
    try {
      await reconcileAcceptedWorkResult(input);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '公共结果已验收，但私人 Task 尚未同步');
      throw cause;
    }
  }, []);
  return { error, reconcile };
}

async function reconcileAcceptedWorkResult(input: CollectiveAcceptedWorkResult): Promise<void> {
  const response = await apiFetch(
    `/api/plugins/collective-connector/${encodeURIComponent(input.connectionId)}/work/result/accepted`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(workReconciliationFailure(body, response.status));
  if (isCompletedWorkReconciliation(body)) return;
  const pending = typeof body === 'object' && body !== null && 'result' in body && body.result === 'not_admitted';
  throw new Error(pending ? '公共结果已验收，正在等待私人 Task 建立后同步' : '私人 Task 尚未确认本次公共结果');
}

function workReconciliationFailure(value: unknown, status: number): string {
  return typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string'
    ? value.error
    : `Work reconciliation failed (${status})`;
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
