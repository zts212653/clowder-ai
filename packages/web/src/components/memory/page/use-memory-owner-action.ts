import type { MemoryOwnerAction, MemoryOwnerActionReceipt } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { memoryObject } from './owner-memory-read';

type WithoutRequestId<T> = T extends unknown ? Omit<T, 'requestId'> : never;
export type MemoryActionInput = WithoutRequestId<MemoryOwnerAction>;
const unknownResult = '暂时无法修改；结果尚未确认，可以重试这次操作。';
const errors: Record<string, string> = {
  stale_revision: '版本已变化，请重读后再决定。',
  source_unavailable: '来源已失效，未执行这次操作。',
  candidate_unavailable: '概括候选已失效，请重读后再决定。',
  idempotency_conflict: '这次操作与已记录的请求不一致，请重读。',
  not_available: '这条记忆已不可用，请重读列表。',
  invalid_action: '无法确认操作权限，请重新打开页面。',
  invalid_request: '填写内容不符合要求，请检查后重读。',
  invalid_content: '关于你需要有内容，正文不能超过 300 字。',
};
function appliedReceipt(body: unknown, memoryId: string, action: string): body is MemoryOwnerActionReceipt {
  if (
    !memoryObject(body) ||
    body.action !== action ||
    body.memoryId !== memoryId ||
    (body.outcome !== 'applied' && body.outcome !== 'replayed')
  )
    return false;
  if (action !== 'hard_forget') return true;
  const scope = body.forgetScope;
  return (
    memoryObject(scope) &&
    scope.canonicalMemory === 'deleted' &&
    scope.derivedProjections === 'invalidated' &&
    scope.originalSource === 'preserved' &&
    ['not_applicable', 'redacted', 'retained'].includes(String(scope.immutableAudit))
  );
}
function failedResponse(body: unknown, response: { status: number; ok: boolean }) {
  const reason = memoryObject(body) && typeof body.error === 'string' ? body.error : '';
  return {
    busy: false,
    error: errors[reason] ?? unknownResult,
    retryable: response.status >= 500 || (response.ok && !errors[reason]),
  };
}
/** Shared browser transport state; each caller retains its original lane route, DTO and domain authority. */
export function useMemoryOwnerAction(
  endpoint: string,
  memoryId: string,
  onApplied: (receipt: MemoryOwnerActionReceipt) => void,
) {
  const [state, setState] = useState({ busy: false, error: '', retryable: false });
  const command = useRef<(MemoryActionInput & { requestId: string }) | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function execute() {
    if (pending.current || !command.current) return;
    const current = command.current;
    pending.current = true;
    setState({ busy: true, error: '', retryable: false });
    try {
      const response = await apiFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(current),
      });
      const body: unknown = await response.json();
      if (!mounted.current) return;
      if (response.ok && appliedReceipt(body, memoryId, current.action)) {
        command.current = null;
        setState({ busy: false, error: '', retryable: false });
        onApplied(body);
      } else {
        setState(failedResponse(body, response));
      }
    } catch {
      if (mounted.current) setState({ busy: false, error: unknownResult, retryable: true });
    } finally {
      pending.current = false;
    }
  }
  return {
    ...state,
    blocked: state.busy || !!state.error,
    submit: (input: MemoryActionInput) => {
      if (!pending.current && !state.error) {
        command.current = { ...input, requestId: crypto.randomUUID() };
        void execute();
      }
    },
    retry: () => {
      void execute();
    },
    reset: () => {
      if (!pending.current) {
        command.current = null;
        setState({ busy: false, error: '', retryable: false });
      }
    },
  };
}
export type MemoryOwnerActionState = ReturnType<typeof useMemoryOwnerAction>;
