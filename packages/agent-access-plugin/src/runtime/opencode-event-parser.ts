/**
 * `opencode run --format json` NDJSON → provider-neutral wire event.
 *
 * Extracted from the Host's `opencode-event-transform` so the active Agent Access
 * package owns the CLI's output shape. What stays in the Host: turning the wire
 * event into its `AgentMessage`, sanitising error text, and stamping `catId`.
 * Nothing here may import Host internals — the package is packed standalone.
 *
 * The token arithmetic below is not incidental: the CLI reports cached prompt
 * tokens separately from fresh ones, and the shared usage contract expects the
 * TOTAL prompt. Copying `tokens.input` alone makes a long cached session look
 * nearly empty, so context-fill never triggers a handoff before the CLI hits the
 * context wall (clowder#915 R4).
 */

interface OpenCodeRawPart {
  type?: string;
  text?: string;
  tool?: string;
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
    cache?: { read?: number; write?: number };
  };
  state?: { input?: Record<string, unknown> };
  cost?: number;
}

interface OpenCodeRawEvent {
  type?: string;
  timestamp?: number;
  sessionID?: string;
  part?: OpenCodeRawPart;
  error?: { name?: string; message?: string; data?: { message?: string; statusCode?: number } };
}

export interface OpenCodeUsage {
  inputTokens?: number;
  lastTurnInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
}

export type OpenCodeWireEvent =
  | { kind: 'ignored' }
  | { kind: 'session_init'; sessionId: string; timestamp: number }
  | { kind: 'text'; text: string; timestamp: number }
  | { kind: 'thinking'; text: string; timestamp: number }
  | { kind: 'tool'; name: string; input?: Record<string, unknown>; timestamp: number }
  | { kind: 'usage'; usage: OpenCodeUsage; timestamp: number }
  | { kind: 'error'; message: string; statusCode?: number; timestamp: number };

const IGNORED: OpenCodeWireEvent = { kind: 'ignored' };

function asEvent(value: unknown): OpenCodeRawEvent | null {
  if (typeof value !== 'object' || value === null) return null;
  const event = value as OpenCodeRawEvent;
  return typeof event.type === 'string' ? event : null;
}

function readTimestamp(event: OpenCodeRawEvent): number {
  return typeof event.timestamp === 'number' ? event.timestamp : Date.now();
}

/** Declared error fields only — never stringify an arbitrary provider payload. */
function readError(event: OpenCodeRawEvent): { message: string; statusCode?: number } {
  const data = event.error?.data;
  const message = data?.message ?? event.error?.message ?? event.error?.name ?? 'opencode error';
  const statusCode =
    typeof data?.statusCode === 'number' && Number.isInteger(data.statusCode) ? data.statusCode : undefined;
  return { message, ...(statusCode !== undefined ? { statusCode } : {}) };
}

function readUsage(event: OpenCodeRawEvent): OpenCodeUsage | null {
  const tokens = event.part?.tokens;
  const freshInput = tokens?.input;
  const cacheRead = tokens?.cache?.read;
  const cacheWrite = tokens?.cache?.write;
  const output = tokens?.output;
  const total = tokens?.total;
  const cost = event.part?.cost;

  const hasInput = freshInput != null || cacheRead != null || cacheWrite != null;
  const totalInput = hasInput ? (freshInput ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0) : undefined;

  // No telemetry at all (cached response, pre-flight step) → contribute nothing
  // rather than an empty marker the Host would have to special-case.
  if (totalInput == null && output == null && total == null) return null;

  return {
    ...(totalInput != null ? { inputTokens: totalInput, lastTurnInputTokens: totalInput } : {}),
    ...(output != null ? { outputTokens: output } : {}),
    ...(total != null ? { totalTokens: total } : {}),
    // A zero here means "no cache activity this step"; emitting it is noise.
    ...(cacheRead ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite ? { cacheCreationTokens: cacheWrite } : {}),
    ...(cost != null ? { costUsd: cost } : {}),
  };
}

export function normalizeOpenCodeEvent(value: unknown): OpenCodeWireEvent {
  const event = asEvent(value);
  if (!event) return IGNORED;
  const timestamp = readTimestamp(event);

  switch (event.type) {
    case 'step_start':
      return event.sessionID ? { kind: 'session_init', sessionId: event.sessionID, timestamp } : IGNORED;

    case 'text': {
      const text = event.part?.text;
      if (typeof text !== 'string' || text.length === 0) return IGNORED;
      // F161: reasoning arrives as a text event with part.type = 'reasoning'.
      return event.part?.type === 'reasoning'
        ? { kind: 'thinking', text, timestamp }
        : { kind: 'text', text, timestamp };
    }

    case 'reasoning': {
      const text = event.part?.text;
      if (typeof text !== 'string' || text.length === 0) return IGNORED;
      return { kind: 'thinking', text, timestamp };
    }

    case 'tool_use': {
      const input = event.part?.state?.input;
      return {
        kind: 'tool',
        name: event.part?.tool ?? 'unknown',
        ...(input ? { input } : {}),
        timestamp,
      };
    }

    case 'error': {
      const { message, statusCode } = readError(event);
      return { kind: 'error', message, ...(statusCode !== undefined ? { statusCode } : {}), timestamp };
    }

    case 'step_finish': {
      const usage = readUsage(event);
      return usage ? { kind: 'usage', usage, timestamp } : IGNORED;
    }

    default:
      return IGNORED;
  }
}
