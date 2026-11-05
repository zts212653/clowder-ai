import { AgyNativeResumeMismatchError } from './agy-native-errors.js';
import type { AgyNativePermissionMode } from './agy-native-policy.js';
import { AGY_NATIVE_PROTOCOL_TOOLS } from './agy-native-tools.js';

export interface ExpectedNativeInit {
  readonly sessionId?: string;
  readonly agentName: string;
  readonly spawnCwd: string;
  readonly model: string;
  readonly permissionMode?: AgyNativePermissionMode;
  readonly command?: string;
  readonly invocationId?: string;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function verifiedInitSessionId(
  record: Record<string, unknown>,
  expected: ExpectedNativeInit,
  seen: boolean,
): string {
  const init = asRecord(record.init);
  if (
    seen ||
    init?.agent !== expected.agentName ||
    init.cwd !== expected.spawnCwd ||
    init.permission_mode !== (expected.permissionMode ?? 'request-review') ||
    init.model !== expected.model
  ) {
    throw new Error('AGY native init disagrees with the host-owned agent, spawn cwd, model, or permission mode');
  }
  const sessionId = typeof record.conversation_id === 'string' ? record.conversation_id : '';
  if (!sessionId) throw new Error('AGY native init omitted the conversation ID');
  if (expected.sessionId && expected.sessionId !== sessionId) {
    throw new AgyNativeResumeMismatchError(
      'AGY native init replaced the requested conversation; refusing silent history loss',
    );
  }
  if (
    init.tools !== undefined &&
    (!Array.isArray(init.tools) ||
      init.tools.some((tool) => typeof tool !== 'string' || !AGY_NATIVE_PROTOCOL_TOOLS.has(tool)))
  ) {
    throw new Error('AGY native init advertised an unqualified tool vocabulary');
  }
  return sessionId;
}

/** Only explicitly recognized host observations may bypass the Native protocol. */
export function readAgyNativeEnvelope(raw: unknown): Record<string, unknown> {
  const record = asRecord(raw);
  if (!record || typeof record.event !== 'string' || !record.event.trim()) {
    throw new Error('AGY native stream contains an unrecognized or malformed event envelope');
  }
  return record;
}

export function verifyAgyNativeResult(record: Record<string, unknown>, sessionId: string | null): void {
  const terminal = asRecord(record.result);
  if (!sessionId || terminal?.conversation_id !== sessionId) {
    throw new Error('AGY native terminal conversation ID is missing or disagrees with verified init');
  }
}
