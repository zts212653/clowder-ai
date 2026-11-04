import { createHash } from 'node:crypto';
import { memberInputPayload } from './input-message.js';
import type {
  ExecuteMemberSession,
  MemberExecutionLookup,
  MemberRuntimeSnapshot,
  PrepareMemberSession,
} from './types.js';

export function coordinate(value: unknown, maximum = 256): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > maximum || value.trim() !== value)
    throw new Error('invalid_member_session_coordinate');
}
export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
/** A new owner grant has its own admission namespace, even when its local ids repeat. */
export function memberExecutionKey(
  input: Pick<ExecuteMemberSession, 'sessionId' | 'generation' | 'executionId'>,
): string {
  return `member:v1:${digest([input.sessionId, input.generation, input.executionId])}`;
}
function closed(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    throw new Error('invalid_member_session_input');
}
export function executionLookup(value: MemberExecutionLookup): MemberExecutionLookup {
  closed(value, ['sessionId', 'generation', 'executionId']);
  coordinate(value.sessionId);
  coordinate(value.executionId);
  if (!Number.isSafeInteger(value.generation) || value.generation < 1)
    throw new Error('invalid_member_execution_lookup');
  return { sessionId: value.sessionId, generation: value.generation, executionId: value.executionId };
}
export function prepareInput(value: PrepareMemberSession): PrepareMemberSession {
  closed(value, ['threadId', 'catId', 'contributionId', 'identity', 'accountSelection', 'memory']);
  for (const item of [value.threadId, value.catId, value.contributionId, value.identity]) coordinate(item);
  if (!Array.isArray(value.memory) || value.memory.length > 16) throw new Error('invalid_member_memory_references');
  const memory = value.memory.map((ref) => {
    closed(ref, ['sourceRef', 'revision']);
    coordinate(ref.sourceRef, 1000);
    coordinate(ref.revision);
    return { sourceRef: ref.sourceRef, revision: ref.revision };
  });
  if (new Set(memory.map((ref) => ref.sourceRef)).size !== memory.length) throw new Error('duplicate_member_memory');
  let selection: PrepareMemberSession['accountSelection'];
  if (value.accountSelection !== undefined) {
    closed(value.accountSelection, ['accountRef', 'authType', 'expectedRevision']);
    coordinate(value.accountSelection.accountRef);
    if (!['oauth', 'api_key'].includes(value.accountSelection.authType)) throw new Error('invalid_member_auth_type');
    if (value.accountSelection.expectedRevision !== undefined) coordinate(value.accountSelection.expectedRevision);
    selection = { ...value.accountSelection };
  }
  return {
    threadId: value.threadId,
    catId: value.catId,
    contributionId: value.contributionId,
    identity: value.identity,
    memory,
    ...(selection ? { accountSelection: selection } : {}),
  };
}
export function executeInput(value: ExecuteMemberSession): ExecuteMemberSession {
  closed(value, ['sessionId', 'generation', 'executionId', 'semanticCursor', 'content']);
  coordinate(value.sessionId);
  coordinate(value.executionId);
  if (
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !Number.isSafeInteger(value.semanticCursor) ||
    value.semanticCursor < 0 ||
    typeof value.content !== 'string' ||
    !value.content ||
    Buffer.byteLength(value.content) > 65536
  )
    throw new Error('invalid_member_execution_input');
  memberInputPayload(value.content);
  return {
    sessionId: value.sessionId,
    generation: value.generation,
    executionId: value.executionId,
    semanticCursor: value.semanticCursor,
    content: value.content,
  };
}
export function runtimeSnapshot(value: MemberRuntimeSnapshot): MemberRuntimeSnapshot {
  for (const item of [
    value.clientId,
    value.model,
    value.carrier,
    value.account?.accountRef,
    value.account?.accountRevision,
  ])
    coordinate(item);
  if (!['oauth', 'api_key'].includes(value.account.authType)) throw new Error('invalid_member_runtime_auth');
  return {
    clientId: value.clientId,
    model: value.model,
    carrier: value.carrier,
    account: {
      accountRef: value.account.accountRef,
      authType: value.account.authType,
      accountRevision: value.account.accountRevision,
    },
  };
}
