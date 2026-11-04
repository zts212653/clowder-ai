import { MemberSessionJournal } from './journal.js';
import type { MemberSessionRecord, MemberSessionServices } from './types.js';
import { coordinate, digest, prepareInput, runtimeSnapshot } from './validation.js';

// Composition supplies a separate Host storage keyspace. A package may choose
// any plugin id, so a reserved-looking plugin id alone is not an authority fence.
const NAMESPACE = 'grants';
export function sessionIdFor(ownerUserId: string, threadId: string): string {
  return `member-session:${digest([ownerUserId, threadId])}`;
}
function recordOf(value: unknown): MemberSessionRecord {
  if (!value || typeof value !== 'object' || !('schema' in value) || value.schema !== 'host.member-session.v1')
    throw new Error('invalid_persisted_member_session');
  const row = structuredClone(value) as MemberSessionRecord;
  prepareInput({
    threadId: row.threadId,
    catId: row.catId,
    contributionId: row.contributionId,
    identity: row.identity,
    memory: row.memory,
    ...(row.accountSelection ? { accountSelection: row.accountSelection } : {}),
  });
  runtimeSnapshot(row.runtime);
  if (row.activationId !== undefined) coordinate(row.activationId);
  for (const item of [
    row.sessionId,
    row.ownerUserId,
    row.pluginInstanceId,
    row.packageDigest,
    row.ownerRequestId,
    row.prepareDigest,
  ])
    coordinate(item);
  if (
    row.sessionId !== sessionIdFor(row.ownerUserId, row.threadId) ||
    !Number.isSafeInteger(row.generation) ||
    row.generation < 1 ||
    typeof row.revoked !== 'boolean' ||
    !Number.isSafeInteger(row.consumedCursor) ||
    row.consumedCursor < 0 ||
    !row.executions ||
    typeof row.executions !== 'object' ||
    Array.isArray(row.executions) ||
    typeof row.hasConsumedInput !== 'boolean'
  )
    throw new Error('invalid_persisted_member_session');
  return row;
}
export class MemberSessionStore {
  readonly journal: MemberSessionJournal;
  constructor(private readonly storage: MemberSessionServices['storage']) {
    this.journal = new MemberSessionJournal(storage);
  }
  async get(id: string) {
    coordinate(id);
    const row = await this.storage.get(NAMESPACE, id);
    return row ? { revision: row.revision, value: recordOf(row.value) } : null;
  }
  async mutate(id: string, change: (current: MemberSessionRecord | null) => Promise<MemberSessionRecord>) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const before = await this.get(id);
      const next = await change(before?.value ?? null);
      if (next.sessionId !== id) throw new Error('member_session_storage_scope_mismatch');
      const stored = await this.storage.compareAndSet(NAMESPACE, id, before?.revision ?? null, next);
      if (stored.applied) return structuredClone(next);
    }
    throw new Error('member_session_concurrent_write');
  }
}
