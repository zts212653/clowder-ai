import { type CatId, collectiveExecutionGrantSchema, collectiveWorkBindingSchema } from '@cat-cafe/shared';
import {
  AUTH_TERMINAL_DISPOSITIONS,
  type AuthInvocationState,
  type AuthTerminalDisposition,
  type InvocationRecord,
} from './InvocationRegistry.js';
import { normalizeOwnerAuthProvenance } from './owner-auth-provenance.js';
import { parseToolExecutionPolicy } from './tool-execution-policy.js';

const TERMINAL_STATES = new Set<string>(AUTH_TERMINAL_DISPOSITIONS);

export function parseRedisHashArray(arr: unknown): Record<string, string> {
  const output: Record<string, string> = {};
  if (!Array.isArray(arr)) return output;
  for (let index = 0; index < arr.length; index += 2) {
    const key = arr[index];
    const value = arr[index + 1];
    if (typeof key === 'string' && typeof value === 'string') output[key] = value;
  }
  return output;
}

export function isAuthTerminalState(value: unknown): value is AuthTerminalDisposition {
  return typeof value === 'string' && TERMINAL_STATES.has(value);
}

function parseAuthState(value: string | undefined): AuthInvocationState | null {
  if (!value || value === 'active') return 'active';
  return isAuthTerminalState(value) ? value : null;
}

function applyOptionalFields(record: InvocationRecord, fields: Record<string, string>): void {
  if (fields.parentInvocationId) record.parentInvocationId = fields.parentInvocationId;
  if (fields.a2aTriggerMessageId) record.a2aTriggerMessageId = fields.a2aTriggerMessageId;
  if (fields.originTriggerMessageId) record.originTriggerMessageId = fields.originTriggerMessageId;
  if (fields.toolExecutionPolicy) record.toolExecutionPolicy = parseToolExecutionPolicy(fields.toolExecutionPolicy);
  if (fields.executionGrant)
    record.executionGrant = collectiveExecutionGrantSchema.parse(JSON.parse(fields.executionGrant));
  if (fields.collectiveWorkBinding)
    record.collectiveWorkBinding = collectiveWorkBindingSchema.parse(JSON.parse(fields.collectiveWorkBinding));
  if (fields.endedAt) record.endedAt = Number(fields.endedAt);
  if (fields.endReason) record.endReason = fields.endReason;
  if (fields.terminalRef) record.terminalRef = fields.terminalRef;
  if (fields.traceId && fields.spanId) {
    record.traceContext = {
      traceId: fields.traceId,
      spanId: fields.spanId,
      traceFlags: Number(fields.traceFlags ?? 0),
    };
  }
}

export function authRecordFromRedisHash(fields: Record<string, string>, msgs: Set<string>): InvocationRecord | null {
  if (!fields.invocationId || !fields.callbackToken) return null;
  if (Boolean(fields.managedWorkId) !== Boolean(fields.managedWorkAttemptId)) return null;
  const state = parseAuthState(fields.state);
  if (!state) return null;
  const record: InvocationRecord = {
    invocationId: fields.invocationId,
    callbackToken: fields.callbackToken,
    userId: fields.userId ?? '',
    ownerAuthProvenance: normalizeOwnerAuthProvenance(fields.ownerAuthProvenance),
    ...(fields.managedWorkId && fields.managedWorkAttemptId
      ? { managedWorkBinding: Object.freeze({ workId: fields.managedWorkId, attemptId: fields.managedWorkAttemptId }) }
      : {}),
    catId: (fields.catId ?? '') as CatId,
    threadId: fields.threadId ?? '',
    clientMessageIds: msgs,
    createdAt: Number(fields.createdAt ?? 0),
    state,
    expiresAt: fields.expiresAt ? Number(fields.expiresAt) : null,
  };
  try {
    applyOptionalFields(record, fields);
  } catch {
    return null;
  }
  if (record.toolExecutionPolicy?.mode === 'collective_participation' && !record.executionGrant) return null;
  if (
    record.executionGrant &&
    (record.toolExecutionPolicy?.mode !== 'collective_participation' ||
      record.ownerAuthProvenance !== 'unknown' ||
      record.managedWorkBinding ||
      record.collectiveWorkBinding ||
      record.executionGrant.source.catId !== record.catId ||
      record.executionGrant.originTriggerMessageId !== record.originTriggerMessageId)
  )
    return null;
  if (
    record.collectiveWorkBinding &&
    (record.ownerAuthProvenance !== 'strict' || !record.originTriggerMessageId || record.executionGrant)
  )
    return null;
  return record;
}
