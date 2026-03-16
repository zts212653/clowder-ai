import type { AuditEventInput } from '../../orchestration/EventAuditLog.js';

export interface AuditLogSink {
  append(input: AuditEventInput): Promise<unknown>;
}

export interface RawArchiveSink {
  append(invocationId: string, payload: unknown): Promise<void>;
  /** F118: Get archive file path for diagnostic enrichment (optional) */
  getPath?(invocationId: string): string;
}

export interface CommandExecutionLifecycle {
  phase: 'started' | 'completed';
  command: string;
  status?: string;
  exitCode?: number | null;
}

const REDACTED = '[redacted]';
const MAX_REDACT_DEPTH = 2;

export function extractCommandExecutionLifecycle(event: unknown): CommandExecutionLifecycle | null {
  if (typeof event !== 'object' || event === null) return null;
  const e = event as Record<string, unknown>;

  if (e.type === 'item.started') {
    const item = e.item as Record<string, unknown> | undefined;
    if (item?.type === 'command_execution' && typeof item.command === 'string') {
      return {
        phase: 'started',
        command: item.command,
        ...(typeof item.status === 'string' ? { status: item.status } : {}),
      };
    }
  }

  if (e.type === 'item.completed') {
    const item = e.item as Record<string, unknown> | undefined;
    if (item?.type === 'command_execution' && typeof item.command === 'string') {
      return {
        phase: 'completed',
        command: item.command,
        ...(typeof item.status === 'string' ? { status: item.status } : {}),
        ...(typeof item.exit_code === 'number' ? { exitCode: item.exit_code } : {}),
      };
    }
  }

  return null;
}

/**
 * Redacts known callback token keys within object graphs.
 * We intentionally bound recursion depth for M1 to keep this best-effort and predictable.
 */
export function sanitizeRawEvent(event: unknown): unknown {
  return redactSensitiveFields(event, 0);
}

function redactSensitiveFields(value: unknown, depth: number): unknown {
  if (depth > MAX_REDACT_DEPTH) return value;

  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveFields(entry, depth + 1));
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }

  const record = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (isSensitiveTokenKey(key) && typeof entry === 'string') {
      sanitized[key] = REDACTED;
      continue;
    }

    sanitized[key] = redactSensitiveFields(entry, depth + 1);
  }
  return sanitized;
}

function isSensitiveTokenKey(key: string): boolean {
  const lowered = key.toLowerCase();
  if (lowered === 'callbacktoken') return true;
  if (lowered.endsWith('_token')) return true;
  return lowered.includes('callback_token');
}
