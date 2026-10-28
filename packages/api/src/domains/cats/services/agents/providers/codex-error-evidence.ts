import type { CliDiagnostics } from '@cat-cafe/shared';
import {
  buildCliDiagnostics,
  classifyCliError,
  extractUpstreamRequestId,
} from '../../../../../utils/cli-diagnostics.js';
import { sanitizeCliStderr } from '../../../../../utils/sanitize-cli-stderr.js';
import { asCodexAppServerRecord } from './CodexAppServerEventMapper.js';

const MAX_CAUSE_CHARS = 1500;

/** One cause for the current failed retry episode, never a session-wide error history. */
export class CodexErrorEvidence {
  private cause = '';
  private binding: { threadId: string; turnId: string } | undefined;
  private requestId: string | undefined;

  observe(event: unknown): void {
    const record = asCodexAppServerRecord(event);
    if (!record) return;
    if (record.type === 'app_server.lifecycle') {
      const lifecycle = asCodexAppServerRecord(record.lifecycle);
      if (
        (lifecycle?.stage === 'turn_accepted' || lifecycle?.stage === 'active') &&
        typeof lifecycle.threadId === 'string' &&
        typeof lifecycle.turnId === 'string' &&
        (lifecycle.threadId !== this.binding?.threadId || lifecycle.turnId !== this.binding?.turnId)
      ) {
        this.binding = { threadId: lifecycle.threadId, turnId: lifecycle.turnId };
        this.cause = '';
        this.requestId = undefined;
      }
      return;
    }
    if (
      this.binding &&
      ((typeof record.thread_id === 'string' && record.thread_id !== this.binding.threadId) ||
        (typeof record.turn_id === 'string' && record.turn_id !== this.binding.turnId))
    )
      return;
    const item = asCodexAppServerRecord(record.item);
    const recovered =
      record.type === 'thread.started' ||
      record.type === 'turn.started' ||
      (record.type === 'turn.completed' && (record.status === undefined || record.status === 'completed')) ||
      (record.type === 'item.completed' &&
        (item?.status === 'completed' || (item?.type === 'agent_message' && item.status === undefined)));
    if (recovered) {
      this.cause = '';
      this.requestId = undefined;
      return;
    }
    const error = record.type === 'turn.failed' ? asCodexAppServerRecord(record.error) : record;
    if (record.type !== 'error' && record.type !== 'turn.failed') return;
    const text = [error?.message, error?.additionalDetails]
      .filter((part): part is string => typeof part === 'string')
      .join('\n');
    const requestId = extractUpstreamRequestId(text);
    const sanitized = sanitizeCliStderr(text);
    const reason = classifyCliError(sanitized);
    if (reason && reason !== 'stream_disconnected') {
      this.cause = sanitized.slice(0, MAX_CAUSE_CHARS);
      this.requestId = requestId;
    } else if (requestId) this.requestId = requestId;
  }

  diagnostics(error: unknown, debugRef: CliDiagnostics['debugRef']): CliDiagnostics {
    const terminalError = error instanceof Error ? error.message : String(error);
    const terminalReason = classifyCliError(terminalError);
    const usePriorCause =
      terminalReason === 'stream_disconnected' || terminalError === 'Codex app-server request failed';
    const rawText = [
      sanitizeCliStderr(terminalError).slice(0, MAX_CAUSE_CHARS),
      ...(usePriorCause && this.cause ? [this.cause] : []),
    ].join('\n');
    const requestId = extractUpstreamRequestId(terminalError) ?? (usePriorCause ? this.requestId : undefined);
    return buildCliDiagnostics({
      rawText,
      debugRef: { ...debugRef, ...(requestId ? { upstreamRequestId: requestId } : {}) },
    });
  }
}
