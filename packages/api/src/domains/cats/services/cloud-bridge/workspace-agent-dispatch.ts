/**
 * F247 Workspace Agent (slice 2): bridge transport decision for the official
 * Trigger API path.
 *
 * Precedence contract (KD-24 pending in the F247 spec): when a Workspace
 * Agent trigger adapter is explicitly configured (trigger id + token +
 * workspace id via Settings/env), it OWNS the outbound outcome for cloud
 * dispatches — success returns the 202 boundary as the transport receipt,
 * and failures fail closed with typed recovery instead of silently falling
 * through to the Personal Chrome Host. A silent provider switch would split
 * one thread's conversation across two provider-side continuities; owners
 * move between plans by enabling/disabling the workspace-agent config, never
 * by per-dispatch fallback.
 *
 * When no adapter/workspace is configured this returns null and the bridge
 * proceeds with the existing Personal Chrome Host path byte-for-byte.
 */

import type { CloudInvokeDispatchParams } from './types.js';
import {
  buildWorkspaceAgentConversationKey,
  type IWorkspaceAgentTriggerAdapter,
  WorkspaceAgentTriggerError,
} from './workspace-agent/workspace-agent-trigger-adapter.js';

export interface WorkspaceAgentDispatchDecision {
  readonly outcome: import('./types.js').BridgeDispatchOutcome;
  readonly fallback?: {
    readonly reason: import('./types.js').BridgeFallbackReason;
    readonly detail: string;
  };
}

function shortMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 200);
  return String(error).slice(0, 200);
}

export async function dispatchThroughWorkspaceAgent(args: {
  readonly adapter: IWorkspaceAgentTriggerAdapter | null | undefined;
  readonly workspaceId: string | null | undefined;
  readonly renderedPrompt: string;
  readonly params: CloudInvokeDispatchParams;
}): Promise<WorkspaceAgentDispatchDecision | null> {
  if (!args.adapter || !args.workspaceId) return null;
  if (!args.params.sourceMessageId) {
    const detail = 'Workspace Agent trigger requires the persisted source message ID as its exact idempotency key';
    return {
      outcome: { kind: 'fallback', reason: 'missing-source-message-id', detail },
      fallback: { reason: 'missing-source-message-id', detail },
    };
  }

  let receipt;
  try {
    receipt = await args.adapter.trigger({
      input: args.renderedPrompt,
      conversationKey: buildWorkspaceAgentConversationKey({
        workspaceId: args.workspaceId,
        threadId: args.params.threadId,
      }),
      idempotencyKey: args.params.sourceMessageId,
    });
  } catch (error) {
    if (error instanceof WorkspaceAgentTriggerError) {
      if (error.code === 'WORKSPACE_AGENT_UNAUTHORIZED' || error.code === 'WORKSPACE_AGENT_FORBIDDEN') {
        const detail = `Workspace Agent authorization rejected: ${error.message}`;
        return {
          outcome: { kind: 'fallback', reason: 'workspace-agent-unauthorized', detail },
          fallback: { reason: 'workspace-agent-unauthorized', detail },
        };
      }
      if (error.code === 'WORKSPACE_AGENT_TRIGGER_NOT_FOUND' || error.code === 'WORKSPACE_AGENT_NOT_RUNNABLE') {
        const detail = `Workspace Agent rejected the dispatch: ${error.message}`;
        return {
          outcome: { kind: 'fallback', reason: 'workspace-agent-rejected', detail },
          fallback: { reason: 'workspace-agent-rejected', detail },
        };
      }
      return {
        outcome: {
          kind: 'error',
          reason: 'workspace-agent-failed',
          message: shortMessage(error),
          detail: `Workspace Agent trigger failed: ${shortMessage(error)}`,
        },
        fallback: {
          reason: 'workspace-agent-failed',
          detail: `Workspace Agent trigger failed: ${shortMessage(error)}`,
        },
      };
    }
    return {
      outcome: {
        kind: 'error',
        reason: 'workspace-agent-failed',
        message: shortMessage(error),
        detail: `Workspace Agent trigger failed unexpectedly: ${shortMessage(error)}`,
      },
      fallback: {
        reason: 'workspace-agent-failed',
        detail: `Workspace Agent trigger failed unexpectedly: ${shortMessage(error)}`,
      },
    };
  }

  return {
    outcome: {
      kind: 'sent',
      capturedUrl: receipt.conversationUrl,
      transport: 'workspace-agent',
      ...(receipt.providerRunId ? { providerRunId: receipt.providerRunId } : {}),
    },
  };
}
