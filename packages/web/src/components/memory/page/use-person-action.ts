import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { PersonOwnerCommand } from './people-types';

const errors: Record<string, string> = {
  stale_revision: '版本已变化，请重读后再决定。',
  source_unavailable: '来源已失效，未执行这次操作。',
  idempotency_conflict: '这次操作与已记录的请求不一致，请重读。',
  not_available: '这条人物记忆已不可用，请重读列表。',
  invalid_action: '无法确认操作权限，请重新打开页面。',
  invalid_request: '填写内容不符合要求，请重读后修改。',
};
const unknownResult = '暂时无法修改；结果尚未确认，可以重试这次操作。';
function readActionResult(response: Response, result: unknown, action: PersonOwnerCommand['action']) {
  const body = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
  const applied = response.ok && body.action === action && (body.outcome === 'applied' || body.outcome === 'replayed');
  const reason = typeof body.error === 'string' ? body.error : '';
  return {
    applied,
    error: errors[reason] ?? unknownResult,
    retryable: response.status >= 500 || (response.ok && !errors[reason]),
  };
}
export function usePersonAction(personId: string, onApplied: (action: PersonOwnerCommand['action']) => void) {
  const [state, setState] = useState({ busy: false, error: '', retryable: false });
  const command = useRef<(PersonOwnerCommand & { requestId: string }) | null>(null);
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
      const response = await apiFetch(`/api/memory/people/${encodeURIComponent(personId)}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(current),
      });
      const result: unknown = await response.json();
      if (!mounted.current) return;
      const outcome = readActionResult(response, result, current.action);
      if (outcome.applied) {
        command.current = null;
        setState({ busy: false, error: '', retryable: false });
        onApplied(current.action);
      } else {
        setState({
          busy: false,
          error: outcome.error,
          retryable: outcome.retryable,
        });
      }
    } catch {
      if (mounted.current) setState({ busy: false, error: unknownResult, retryable: true });
    } finally {
      pending.current = false;
    }
  }
  return {
    ...state,
    reset: () => {
      if (!pending.current) {
        command.current = null;
        setState({ busy: false, error: '', retryable: false });
      }
    },
    submit: (input: PersonOwnerCommand) => {
      if (!pending.current) {
        const requestId = crypto.randomUUID();
        command.current = {
          ...input,
          requestId: input.action === 'hard_forget_person' ? `person_forget_${requestId}` : requestId,
        };
        void execute();
      }
    },
    retry: () => {
      void execute();
    },
  };
}
