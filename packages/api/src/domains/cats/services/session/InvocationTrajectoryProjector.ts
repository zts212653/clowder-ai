import type {
  InvocationTrajectoryStatus,
  InvocationTrajectorySummary,
  InvocationTrajectoryTokens,
  SessionRecord,
} from '@cat-cafe/shared';
import type { TranscriptEvent } from './TranscriptReader.js';

type SessionProjection = Pick<SessionRecord, 'id' | 'threadId' | 'catId' | 'seq' | 'status' | 'sealReason'>;

const MESSAGE_TYPES = new Set(['text', 'assistant', 'user', 'system']);
const MAX_KEY_MESSAGES = 3;
const MAX_KEY_MESSAGE_LENGTH = 140;

interface TerminalEvidence {
  status: Exclude<InvocationTrajectoryStatus, 'running' | 'done'>;
  reason: string;
}

interface ProjectionCounters {
  statusEventCount: number;
  toolUseCount: number;
  toolResultCount: number;
  messageCount: number;
  errorCount: number;
  toolNames: Set<string>;
  keyMessages: string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function eventType(event: TranscriptEvent): string {
  return typeof event.event.type === 'string' ? event.event.type : 'unknown';
}

function textContent(event: Record<string, unknown>): string | undefined {
  if (typeof event.content === 'string') return event.content;
  if (!Array.isArray(event.content)) return undefined;
  const parts = event.content.flatMap((part) => {
    const record = asRecord(part);
    return record?.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
  });
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function parseSystemInfoType(event: Record<string, unknown>): string | undefined {
  if (event.type !== 'system_info' || typeof event.content !== 'string') return undefined;
  try {
    const payload = JSON.parse(event.content) as unknown;
    const record = asRecord(payload);
    return typeof record?.type === 'string' ? record.type : undefined;
  } catch {
    return undefined;
  }
}

function structuredReason(event: Record<string, unknown>): string | undefined {
  if (typeof event.errorCode === 'string') return event.errorCode;
  const diagnostics = asRecord(asRecord(event.metadata)?.cliDiagnostics);
  if (typeof diagnostics?.reasonCode === 'string') return diagnostics.reasonCode;
  const systemInfoType = parseSystemInfoType(event);
  if (systemInfoType) return systemInfoType;
  if (typeof event.error === 'string') return event.error;
  return undefined;
}

function terminalEvidence(event: Record<string, unknown>): TerminalEvidence | undefined {
  const reason = structuredReason(event);
  const normalized = reason?.toLowerCase() ?? '';
  if (normalized.includes('timeout') || normalized.includes('timed out')) {
    return { status: 'timeout', reason: reason ?? 'timeout' };
  }
  if (normalized.includes('cancel')) {
    return { status: 'cancelled', reason: reason ?? 'cancelled' };
  }
  if (event.type === 'error' && event.errorDisposition !== 'transient') {
    return { status: 'error', reason: reason ?? 'terminal_error' };
  }
  if (event.type === 'done' && reason) {
    return { status: 'error', reason };
  }
  return undefined;
}

function selectTerminal(group: TranscriptEvent[]): {
  status: InvocationTrajectoryStatus;
  reason?: string;
} {
  let error: TerminalEvidence | undefined;
  let cancelled: TerminalEvidence | undefined;
  let timeout: TerminalEvidence | undefined;
  let done = false;
  for (const envelope of group) {
    done ||= eventType(envelope) === 'done';
    const evidence = terminalEvidence(envelope.event);
    if (!evidence) continue;
    if (evidence.status === 'timeout') timeout ??= evidence;
    else if (evidence.status === 'cancelled') cancelled ??= evidence;
    else error ??= evidence;
  }
  const terminal = timeout ?? cancelled ?? error;
  if (terminal) return { status: terminal.status, reason: terminal.reason };
  return { status: done ? 'done' : 'running' };
}

function latestTokens(group: TranscriptEvent[]): InvocationTrajectoryTokens | undefined {
  for (let index = group.length - 1; index >= 0; index -= 1) {
    const usage = asRecord(asRecord(group[index]?.event.metadata)?.usage);
    if (!usage) continue;
    const tokens: InvocationTrajectoryTokens = {
      ...(typeof usage.inputTokens === 'number' ? { input: usage.inputTokens } : {}),
      ...(typeof usage.outputTokens === 'number' ? { output: usage.outputTokens } : {}),
      ...(typeof usage.cacheReadTokens === 'number' ? { cacheRead: usage.cacheReadTokens } : {}),
      ...(typeof usage.totalTokens === 'number' ? { total: usage.totalTokens } : {}),
    };
    if (Object.keys(tokens).length > 0) return tokens;
  }
  return undefined;
}

function accumulateEvent(counters: ProjectionCounters, envelope: TranscriptEvent): void {
  const type = eventType(envelope);
  if (type === 'status') counters.statusEventCount += 1;
  if (type === 'tool_use') counters.toolUseCount += 1;
  if (type === 'tool_result') counters.toolResultCount += 1;
  if (type === 'error' || (type === 'tool_result' && envelope.event.toolResultStatus === 'error')) {
    counters.errorCount += 1;
  }
  if (MESSAGE_TYPES.has(type)) {
    counters.messageCount += 1;
    const content = textContent(envelope.event);
    if (content && counters.keyMessages.length < MAX_KEY_MESSAGES) {
      counters.keyMessages.push(content.slice(0, MAX_KEY_MESSAGE_LENGTH));
    }
  }
  if (type === 'tool_use') {
    const toolName = envelope.event.toolName ?? envelope.event.name;
    if (typeof toolName === 'string') counters.toolNames.add(toolName);
  }
}

function projectGroup(
  invocationId: string,
  group: TranscriptEvent[],
  session: SessionProjection,
): InvocationTrajectorySummary {
  const first = group[0];
  const last = group[group.length - 1];
  const terminal = selectTerminal(group);
  const counters: ProjectionCounters = {
    statusEventCount: 0,
    toolUseCount: 0,
    toolResultCount: 0,
    messageCount: 0,
    errorCount: 0,
    toolNames: new Set<string>(),
    keyMessages: [],
  };
  for (const envelope of group) accumulateEvent(counters, envelope);

  const startedAt = first?.t ?? 0;
  const observedEndAt = last?.t ?? startedAt;
  const terminalAt = terminal.status === 'running' ? undefined : observedEndAt;
  const tokens = latestTokens(group);
  return {
    invocationId,
    threadId: session.threadId,
    sessionId: session.id,
    sessionSeq: session.seq,
    sessionStatus: session.status,
    ...(session.sealReason ? { sealReason: session.sealReason } : {}),
    catId: session.catId,
    status: terminal.status,
    startedAt,
    ...(terminalAt !== undefined ? { endedAt: terminalAt } : {}),
    durationMs: Math.max(0, observedEndAt - startedAt),
    eventCount: group.length,
    statusEventCount: counters.statusEventCount,
    toolUseCount: counters.toolUseCount,
    toolResultCount: counters.toolResultCount,
    messageCount: counters.messageCount,
    errorCount: counters.errorCount,
    toolNames: [...counters.toolNames],
    keyMessages: counters.keyMessages,
    ...(terminal.reason ? { terminalReason: terminal.reason } : {}),
    ...(tokens ? { tokens } : {}),
  };
}

export function projectInvocationTrajectories(
  events: TranscriptEvent[],
  session: SessionProjection,
): InvocationTrajectorySummary[] {
  const groups = new Map<string, TranscriptEvent[]>();
  for (const event of events) {
    if (!event.invocationId) continue;
    const group = groups.get(event.invocationId);
    if (group) group.push(event);
    else groups.set(event.invocationId, [event]);
  }
  return [...groups].map(([invocationId, group]) => projectGroup(invocationId, group, session));
}
