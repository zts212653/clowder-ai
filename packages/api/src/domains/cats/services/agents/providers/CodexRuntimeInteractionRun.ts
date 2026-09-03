import {
  asCodexAppServerRecord,
  type CodexAppServerJsonObject,
  respondToCodexAppServerRequest,
} from './CodexAppServerEventMapper.js';
import {
  type CodexRuntimeInteractionContext,
  isCodexApprovalInteractionMethod,
  isCodexRuntimeInteractionMethod,
  respondToCodexRuntimeInteraction,
} from './CodexRuntimeInteractionAdapter.js';
import type { CodexAppServerApprovalsReviewer } from './codex-app-server-client-helpers.js';

export type CodexRuntimeInteractionCloseReason = 'provider_cancelled' | 'transport_lost';

export interface CodexRuntimeInteractionRunState {
  bindProviderTurn(binding: { threadId: string; turnId: string }): void;
  close(reasonCode: CodexRuntimeInteractionCloseReason): void;
  dispatch(
    request: CodexAppServerJsonObject,
    write: (response: CodexAppServerJsonObject) => Promise<void>,
    onFailure: (error: Error) => void,
  ): void;
}

export function createCodexRuntimeInteractionRunState(
  input: Omit<CodexRuntimeInteractionContext, 'signal'> | undefined,
  approvalsReviewer: CodexAppServerApprovalsReviewer | undefined,
): CodexRuntimeInteractionRunState | null {
  if (!input) return null;
  const controller = new AbortController();
  let closed = false;
  let providerTurn: { threadId: string; turnId: string } | null = null;
  const context: CodexRuntimeInteractionContext = { ...input, signal: controller.signal };

  const close = (reasonCode: CodexRuntimeInteractionCloseReason): void => {
    if (closed) return;
    closed = true;
    controller.abort(reasonCode);
    void input.port.invalidateInvocation?.(input.owner.invocationId, reasonCode).catch(() => {});
  };

  return {
    bindProviderTurn: (binding) => {
      providerTurn = binding;
    },
    close,
    dispatch: (request, write, onFailure) => {
      const task = (async () => {
        if (isCodexRuntimeInteractionMethod(request.method) && !matchesProviderTurn(request, providerTurn)) {
          if (!closed && typeof request.id === 'number') {
            await write({
              id: request.id,
              error: { code: -32602, message: 'Invalid runtime interaction provider binding' },
            });
          }
          return;
        }
        if (isCodexApprovalInteractionMethod(request.method) && approvalsReviewer !== 'user') {
          // auto_review and guardian_subagent own permission decisions upstream.
          // If a host still emits a raw approval request, fail closed instead of
          // silently downgrading it into a shell-bearing human card. Undefined is
          // treated the same way so a missing reviewer can never widen authority.
          const response = respondToCodexAppServerRequest(request);
          if (response && !closed) await write(response);
          return;
        }
        const adapted = await respondToCodexRuntimeInteraction(request, context);
        const response = adapted ?? respondToCodexAppServerRequest(request);
        if (!response || closed) return;
        await write(response);
      })();
      void task.catch((error) => {
        if (closed) return;
        const failure = error instanceof Error ? error : new Error(String(error));
        close('transport_lost');
        onFailure(failure);
      });
    },
  };
}

function matchesProviderTurn(
  request: CodexAppServerJsonObject,
  binding: { threadId: string; turnId: string } | null,
): boolean {
  if (!binding) return false;
  const params = asCodexAppServerRecord(request.params);
  if (params?.threadId !== binding.threadId) return false;
  if (request.method === 'mcpServer/elicitation/request' && params.turnId == null) return true;
  return params.turnId === binding.turnId;
}
