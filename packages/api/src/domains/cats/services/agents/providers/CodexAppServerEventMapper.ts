export type CodexAppServerJsonObject = Record<string, unknown>;

export function asCodexAppServerRecord(value: unknown): CodexAppServerJsonObject | null {
  return typeof value === 'object' && value !== null ? (value as CodexAppServerJsonObject) : null;
}

export function codexAppServerErrorMessage(value: unknown): string {
  const record = asCodexAppServerRecord(value);
  return typeof record?.message === 'string' ? record.message : 'Codex app-server request failed';
}

function mapItem(itemValue: unknown): CodexAppServerJsonObject | null {
  const item = asCodexAppServerRecord(itemValue);
  if (!item || typeof item.type !== 'string') return null;
  const typeMap: Readonly<Record<string, string>> = {
    userMessage: 'user_message',
    agentMessage: 'agent_message',
    commandExecution: 'command_execution',
    fileChange: 'file_change',
    mcpToolCall: 'mcp_tool_call',
    dynamicToolCall: 'dynamic_tool_call',
    reasoning: 'reasoning',
  };
  const mapped: CodexAppServerJsonObject = { ...item, type: typeMap[item.type] ?? item.type };
  if (typeof item.aggregatedOutput === 'string') mapped.aggregated_output = item.aggregatedOutput;
  if (typeof item.exitCode === 'number') mapped.exit_code = item.exitCode;
  return mapped;
}

export function mapCodexAppServerTokenUsage(tokenUsageValue: unknown): CodexAppServerJsonObject | null {
  const tokenUsage = asCodexAppServerRecord(tokenUsageValue);
  const last = asCodexAppServerRecord(tokenUsage?.last);
  if (!last) return null;
  const usage: CodexAppServerJsonObject = {};
  if (typeof last.inputTokens === 'number') usage.input_tokens = last.inputTokens;
  if (typeof last.outputTokens === 'number') usage.output_tokens = last.outputTokens;
  if (typeof last.cachedInputTokens === 'number') usage.cached_input_tokens = last.cachedInputTokens;
  return Object.keys(usage).length > 0 ? usage : null;
}

export function mapCodexAppServerNotification(envelopeValue: unknown): CodexAppServerJsonObject | null {
  const envelope = asCodexAppServerRecord(envelopeValue);
  const params = asCodexAppServerRecord(envelope?.params);
  if (!envelope || typeof envelope.method !== 'string') return null;
  switch (envelope.method) {
    case 'item/started':
    case 'item/completed': {
      const item = mapItem(params?.item);
      return item ? { type: envelope.method.replace('/', '.'), item } : null;
    }
    case 'turn/started':
      return { type: 'turn.started' };
    case 'turn/plan/updated': {
      const plan = Array.isArray(params?.plan) ? params.plan : [];
      return {
        type: 'turn.plan.updated',
        ...(typeof params?.explanation === 'string' ? { explanation: params.explanation } : {}),
        plan,
      };
    }
    case 'turn/completed': {
      const turn = asCodexAppServerRecord(params?.turn);
      const status = turn?.status;
      if (status === 'failed') {
        return {
          type: 'turn.failed',
          status,
          error: { message: codexAppServerErrorMessage(asCodexAppServerRecord(turn?.error)) },
        };
      }
      return { type: 'turn.completed', ...(typeof status === 'string' ? { status } : {}) };
    }
    case 'error':
      return { type: 'error', message: codexAppServerErrorMessage(params?.error ?? params) };
    default:
      return null;
  }
}

export function respondToCodexAppServerRequest(request: CodexAppServerJsonObject): CodexAppServerJsonObject | null {
  const id = request.id;
  if (typeof id !== 'number') return null;
  if (
    request.method === 'item/commandExecution/requestApproval' ||
    request.method === 'item/fileChange/requestApproval'
  ) {
    return { id, result: { decision: 'decline' } };
  }
  if (request.method === 'execCommandApproval' || request.method === 'applyPatchApproval') {
    return { id, result: { decision: 'denied' } };
  }
  if (request.method === 'item/tool/requestUserInput') {
    const params = asCodexAppServerRecord(request.params);
    const questions = Array.isArray(params?.questions) ? params.questions : [];
    const questionIds = questions.map((question) => asCodexAppServerRecord(question)?.id);
    const isMcpApprovalRequest =
      questionIds.length > 0 &&
      questionIds.every(
        (questionId): questionId is string =>
          typeof questionId === 'string' && questionId.startsWith('mcp_tool_call_approval_'),
      );
    if (isMcpApprovalRequest) {
      // Upstream's request-user-input compatibility path recognizes this token
      // as a fail-closed decline. The completed tool event is then normalized by
      // codex-event-transform using the host's unavailable approval surface.
      return {
        id,
        result: {
          answers: Object.fromEntries(
            questionIds.map((questionId) => [questionId, { answers: ['__codex_mcp_decline__'] }]),
          ),
        },
      };
    }
  }
  return {
    id,
    error: { code: -32601, message: `Unsupported app-server request: ${String(request.method)}` },
  };
}
