import type { CliDiagnostics } from '@cat-cafe/shared';
import type { ChatMessage, ChatMessagePatch, TimeoutDiagnostics } from '@/stores/chat-types';
import { isRecord, type SystemRowSink, upsertSystemRow } from './system-projections';
import type { AgentEventFields } from './types';

/**
 * F117 error rule: a turn's result — including its failure — is carried by its one response.
 * An `error` that names the response writes no row; only an error with no admitted response
 * (preflight / registration failure) gets an error row, under its own id.
 */

/** Recoverable provider errors mid-run: the turn keeps streaming. */
export function isRecoverableInFlightError(msg: Pick<AgentEventFields, 'type' | 'errorCode' | 'isFinal'>): boolean {
  if (msg.type !== 'error' || msg.isFinal === true) return false;
  return msg.errorCode === 'upstream_error' || msg.errorCode === 'tool_error';
}

const ERROR_SUBTYPE_LABELS: Record<string, string> = {
  error_max_turns: '超出 turn 限制',
  error_max_budget_usd: '预算用尽',
  error_during_execution: '运行时错误',
  error_max_structured_output_retries: '结构化输出重试超限',
};

/** Open-thread copy: `Error: …`, labelled with the provider's error subtype when it names one. */
export function labelledErrorContent(msg: Pick<AgentEventFields, 'error' | 'content'>): string {
  const base = `Error: ${msg.error ?? 'Unknown error'}`;
  try {
    const meta: unknown = JSON.parse(msg.content ?? '{}');
    const subtype = isRecord(meta) ? meta.errorSubtype : undefined;
    const label = typeof subtype === 'string' ? ERROR_SUBTYPE_LABELS[subtype] : undefined;
    return label ? `${base} (${label})` : base;
  } catch {
    return base;
  }
}

export function timeoutDiagnosticsFrom(diag: Record<string, unknown>): TimeoutDiagnostics {
  return {
    silenceDurationMs: diag.silenceDurationMs as number,
    processAlive: diag.processAlive as boolean,
    lastEventType: diag.lastEventType as string | undefined,
    firstEventAt: diag.firstEventAt as number | undefined,
    lastEventAt: diag.lastEventAt as number | undefined,
    cliSessionId: diag.cliSessionId as string | undefined,
    invocationId: diag.invocationId as string | undefined,
    rawArchivePath: diag.rawArchivePath as string | undefined,
  };
}

/** F118 AC-C3 timeout diagnostics + F212 CLI diagnostics fold into the error row's panel. */
export function errorRowExtra(
  timeoutDiag: Record<string, unknown> | null,
  cliDiagnostics: CliDiagnostics | undefined,
): ChatMessage['extra'] | undefined {
  if (!timeoutDiag && !cliDiagnostics) return undefined;
  return {
    ...(timeoutDiag ? { timeoutDiagnostics: timeoutDiagnosticsFrom(timeoutDiag) } : {}),
    ...(cliDiagnostics ? { cliDiagnostics } : {}),
  };
}

/**
 * The row of one failed turn keeps one id, so a repeated error updates it instead of stacking a
 * duplicate. Without any invocation identity there is none: each such error is its own row.
 */
export function invocationErrorRowId(
  msg: Pick<AgentEventFields, 'catId' | 'invocationId' | 'turnInvocationId'>,
): string | undefined {
  const turn = msg.turnInvocationId ?? msg.invocationId;
  return turn ? `err-${turn}-${msg.catId}` : undefined;
}

export function upsertErrorRow(sink: SystemRowSink, row: ChatMessage): void {
  const patch: ChatMessagePatch = {
    content: row.content,
    timestamp: row.timestamp,
    ...(row.extra ? { extra: row.extra } : {}),
  };
  upsertSystemRow(sink, row, patch);
}
