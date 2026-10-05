import type { CatId } from '@cat-cafe/shared';
import { isCliError, isCliTimeout } from '../../../../../../utils/cli-spawn.js';
import type { AgentMessage, MessageMetadata } from '../../../types.js';
import { type AgyStreamJsonTurn, summarizeAgyStreamJsonTurn } from '../agy-stream-json-parser.js';
import { AGY_NATIVE_FILE_TOOLS } from './agy-native-policy.js';

export interface AgyNativeObservedTurn {
  readonly sessionId: string;
  readonly turn: AgyStreamJsonTurn;
  readonly transportError: string | null;
  readonly cancelledBeforeTerminal?: boolean;
}

const MAX_AGY_NATIVE_STREAM_CHARS = 8 * 1024 * 1024;
const DECLARED_NATIVE_TOOLS = new Set<string>(AGY_NATIVE_FILE_TOOLS);
const RECOVERABLE_NATIVE_READ_TOOLS = new Set(['view_file', 'list_dir', 'grep_search', 'find_by_name']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function verifiedInitSessionId(
  record: Record<string, unknown>,
  expected: { readonly agentName: string; readonly spawnCwd: string; readonly model: string },
  seen: boolean,
): string {
  const init = asRecord(record.init);
  if (
    seen ||
    init?.agent !== expected.agentName ||
    init.cwd !== expected.spawnCwd ||
    init.permission_mode !== 'request-review' ||
    init.model !== expected.model
  ) {
    throw new Error('AGY native init disagrees with the host-owned agent, spawn cwd, model, or permission mode');
  }
  const sessionId = typeof record.conversation_id === 'string' ? record.conversation_id : '';
  if (!sessionId) throw new Error('AGY native init omitted the conversation ID');
  return sessionId;
}

function verifiedNativeTerminal(lines: readonly string[], sessionId: string, resultCount: number): AgyStreamJsonTurn {
  if (resultCount > 1) throw new Error('AGY native one-turn process emitted multiple terminal results');
  const turn = summarizeAgyStreamJsonTurn(lines);
  if (turn.conversationId && turn.conversationId !== sessionId) {
    throw new Error('AGY native terminal conversation ID disagrees with init');
  }
  return turn;
}

/** Treat init as a claim that must match the launch plan, never as proof that L0 reached the model. */
export async function readAgyNativeTurn(
  stream: AsyncIterable<unknown>,
  expected: { readonly agentName: string; readonly spawnCwd: string; readonly model: string },
  signal?: AbortSignal,
): Promise<AgyNativeObservedTurn> {
  const lines: string[] = [];
  let sessionId: string | null = null;
  let transportError: string | null = null;
  let resultCount = 0;
  let resultSeenBeforeCancellation = false;
  let streamChars = 0;
  for await (const raw of stream) {
    if (isCliError(raw) || isCliTimeout(raw)) {
      transportError = raw.message;
      continue;
    }
    const record = asRecord(raw);
    if (!record) continue;
    if (record.event === 'init') {
      sessionId = verifiedInitSessionId(record, expected, sessionId !== null);
    }
    if (record.event === 'result') {
      resultCount++;
      if (!signal?.aborted) resultSeenBeforeCancellation = true;
    }
    const line = JSON.stringify(raw);
    streamChars += line.length;
    if (streamChars > MAX_AGY_NATIVE_STREAM_CHARS)
      throw new Error('AGY native stream exceeded the bounded output limit');
    lines.push(line);
  }
  if (!sessionId) throw new Error('AGY native stream ended without a verified init');
  const turn = verifiedNativeTerminal(lines, sessionId, resultCount);
  return {
    sessionId,
    turn,
    transportError,
    cancelledBeforeTerminal: signal?.aborted === true && !resultSeenBeforeCancellation,
  };
}

function projectToolMessages(catId: CatId, metadata: MessageMetadata, turn: AgyStreamJsonTurn): AgentMessage[] {
  return turn.toolCalls.flatMap((call) => {
    const toolUseId = `${metadata.sessionId}:${call.stepIndex}`;
    return [
      {
        type: 'tool_use' as const,
        catId,
        toolName: call.toolName,
        toolUseId,
        toolInput: call.parameters,
        toolSource: call.toolName === 'call_mcp_tool' ? ('mcp' as const) : ('host_cli' as const),
        metadata,
        timestamp: Date.now(),
      },
      {
        type: 'tool_result' as const,
        catId,
        toolName: call.toolName,
        toolUseId,
        content: call.output || call.errorMessage || '',
        toolResultStatus: call.state === 'DONE' && call.errorMessage === null ? ('ok' as const) : ('error' as const),
        metadata,
        timestamp: Date.now(),
      },
    ];
  });
}

function isDeclaredTurnTool(
  call: AgyStreamJsonTurn['toolCalls'][number],
  grantedMcpTools: ReadonlySet<string>,
): boolean {
  if (DECLARED_NATIVE_TOOLS.has(call.toolName)) return true;
  if (call.toolName !== 'call_mcp_tool') return false;
  const server = call.parameters.ServerName;
  const tool = call.parameters.ToolName;
  return typeof server === 'string' && typeof tool === 'string' && grantedMcpTools.has(`${server}/${tool}`);
}

function isRecoveredReadError(call: AgyStreamJsonTurn['toolCalls'][number], turn: AgyStreamJsonTurn): boolean {
  return (
    RECOVERABLE_NATIVE_READ_TOOLS.has(call.toolName) &&
    turn.toolCalls.some(
      (later) =>
        later.stepIndex > call.stepIndex &&
        later.toolName === call.toolName &&
        later.state === 'DONE' &&
        later.errorMessage === null,
    )
  );
}

/** Map upstream SUCCESS+denied_actions to failure and keep provider status as evidence. */
export function projectAgyNativeTurn(
  catId: CatId,
  metadata: MessageMetadata,
  observed: AgyNativeObservedTurn,
  cancelled: boolean,
  grantedMcpTools: readonly string[] = [],
): AgentMessage[] {
  const { turn, transportError } = observed;
  metadata.sessionId = observed.sessionId;
  metadata.diagnostics = {
    ...metadata.diagnostics,
    agyNative: { upstreamStatus: turn.upstreamStatus, outcome: turn.outcome },
  };
  if (turn.usage.totalTokens > 0) {
    metadata.usage = {
      inputTokens: turn.usage.inputTokens,
      outputTokens: turn.usage.outputTokens,
      totalTokens: turn.usage.totalTokens,
    };
  }
  const messages: AgentMessage[] = [
    { type: 'session_init', catId, sessionId: observed.sessionId, metadata, timestamp: Date.now() },
    ...projectToolMessages(catId, metadata, turn),
  ];
  const incompleteTool = turn.toolCalls.some((call) => call.state !== 'DONE' && call.state !== 'ERROR');
  const failedTool = turn.toolCalls.find(
    (call) => (call.state === 'ERROR' || call.errorMessage !== null) && !isRecoveredReadError(call, turn),
  );
  const grants = new Set(grantedMcpTools);
  const unexpectedTool = turn.toolCalls.find((call) => !isDeclaredTurnTool(call, grants));
  if (turn.outcome === 'ok' && !transportError && !cancelled && !incompleteTool && !unexpectedTool && !failedTool) {
    messages.push({ type: 'text', catId, content: turn.finalText, metadata, timestamp: Date.now() });
    messages.push({ type: 'done', catId, metadata, timestamp: Date.now() });
    return messages;
  }
  const errorCode = cancelled
    ? 'AGY_CANCELLED'
    : turn.outcome === 'denied'
      ? 'AGY_PERMISSION_DENIED'
      : incompleteTool
        ? 'AGY_TOOL_INCOMPLETE'
        : unexpectedTool
          ? 'AGY_UNEXPECTED_TOOL'
          : failedTool
            ? 'AGY_TOOL_FAILED'
            : 'AGY_NATIVE_FAILED';
  messages.push({
    type: 'error',
    catId,
    errorCode,
    error: cancelled
      ? 'AGY native turn was cancelled before its terminal result'
      : unexpectedTool
        ? `AGY emitted undeclared native tool ${unexpectedTool.toolName}`
        : failedTool
          ? `AGY ${failedTool.toolName} step failed; upstream final cannot certify this turn`
          : (transportError ?? turn.diagnosis),
    metadata,
    timestamp: Date.now(),
  });
  messages.push({ type: 'done', catId, errorCode, metadata, timestamp: Date.now() });
  return messages;
}
