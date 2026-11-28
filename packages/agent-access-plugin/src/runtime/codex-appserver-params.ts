import type {
  AgentAccessCodexAppServerThreadRequest,
  AgentAccessCodexAppServerTurnRequest,
} from '@clowder-ai/agent-contract';

type JsonObject = Record<string, unknown>;

/**
 * Codex app-server thread params.
 *
 * The package owns the JSON-RPC parameter shape. Every sensitive value arrives
 * as an opaque Host token; this module never sees L0, MCP, cwd or credentials.
 */
export function buildCodexAppServerThreadParams(input: AgentAccessCodexAppServerThreadRequest) {
  const { groups, options } = input;
  const params: JsonObject = {
    ...(groups.threadId ? { threadId: groups.threadId, excludeTurns: true } : {}),
    ...(options.sandbox ? { sandbox: options.sandbox } : {}),
    ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
    ...(groups.model ? { model: groups.model } : {}),
    ...(groups.cwd ? { cwd: groups.cwd } : {}),
    ...(groups.developerInstructions ? { developerInstructions: groups.developerInstructions } : {}),
    ...(groups.config ? { config: groups.config } : {}),
    ...(Object.hasOwn(options, 'serviceTier') ? { serviceTier: options.serviceTier ?? null } : {}),
    ...(options.approvalsReviewer ? { approvalsReviewer: options.approvalsReviewer } : {}),
  };

  if (!groups.threadId) return { params };
  const { threadId: _threadId, excludeTurns: _excludeTurns, ...startParams } = params;
  return { params, startParams };
}

/** Codex app-server turn/start params. */
export function buildCodexAppServerTurnParams(input: AgentAccessCodexAppServerTurnRequest) {
  const { groups } = input;
  const turnInput: JsonObject[] = [];
  if (groups.prompt) turnInput.push({ type: 'text', text: groups.prompt });
  for (const image of groups.images ?? []) turnInput.push({ type: 'localImage', path: image });

  const params: JsonObject = {
    threadId: groups.threadId,
    ...(groups.clientUserMessageId ? { clientUserMessageId: groups.clientUserMessageId } : {}),
    input: turnInput,
    ...(groups.recoveryContext
      ? {
          additionalContext: {
            'cat-cafe.capacity-recovery': {
              kind: 'application',
              value: groups.recoveryContext,
            },
          },
        }
      : {}),
    ...(groups.outputSchema ? { outputSchema: groups.outputSchema } : {}),
    ...(groups.collaborationMode ? { collaborationMode: groups.collaborationMode } : {}),
  };

  return { params };
}
