import { isDeepStrictEqual } from 'node:util';
import type { MemberSessionExecution, MemberSessionRecord, MemberSessionServices } from './types.js';
import { memberExecutionKey } from './validation.js';

export type MemberGrantHistory = Omit<
  MemberSessionRecord,
  'executions' | 'consumedCursor' | 'hasConsumedInput' | 'revoked'
>;
type Coordinates = Pick<MemberSessionRecord, 'sessionId' | 'generation'>;

export function executionIsTerminal(run: MemberSessionExecution): boolean {
  return ['succeeded', 'failed', 'canceled', 'interrupted'].includes(run.phase);
}

/** Called only after the durable terminal receipt exists. The active lease and
 * cursor change together in the grant CAS; retrying this projection is safe. */
export function applyTerminalReceipt(row: MemberSessionRecord, run: MemberSessionExecution): MemberSessionRecord {
  if (!executionIsTerminal(run)) throw new Error('member_execution_not_terminal');
  const pending = row.executions[run.executionId];
  if (pending && pending.inputDigest !== run.inputDigest) throw new Error('member_execution_id_conflict');
  const { [run.executionId]: _finished, ...executions } = row.executions;
  return {
    ...row,
    executions,
    ...(run.phase === 'succeeded'
      ? { consumedCursor: Math.max(row.consumedCursor, run.semanticCursor), hasConsumedInput: true }
      : {}),
  };
}

function decodeExecution(value: unknown, row: Coordinates, executionId: string): MemberSessionExecution {
  const stored = value as {
    schema?: string;
    sessionId?: string;
    generation?: number;
    execution?: MemberSessionExecution;
  } | null;
  if (
    stored?.schema !== 'host.member-execution.v1' ||
    stored.sessionId !== row.sessionId ||
    stored.generation !== row.generation ||
    stored.execution?.executionId !== executionId
  )
    throw new Error('invalid_member_execution_journal');
  return structuredClone(stored.execution);
}

function retainedExecution(
  existing: MemberSessionExecution | null,
  next: MemberSessionExecution,
): MemberSessionExecution {
  if (!existing) return next;
  if (existing.inputDigest !== next.inputDigest) throw new Error('member_execution_id_conflict');
  for (const field of ['messageId', 'invocationId', 'responseMessageId'] as const) {
    if (existing[field] && next[field] && existing[field] !== next[field])
      throw new Error('member_execution_journal_identity_conflict');
  }
  if (executionIsTerminal(existing)) {
    if (executionIsTerminal(next) && existing.phase !== next.phase)
      throw new Error('member_execution_terminal_conflict');
    return existing;
  }
  return {
    ...existing,
    ...next,
    // A stale grant archive must never erase an already-started dispatch.
    ...(existing.dispatchStarted === true ? { dispatchStarted: true } : {}),
  };
}

/** Durable entries have independent bounded values. They are never a second
 * authority: active admission remains in the grant's CAS-protected record. */
export class MemberSessionJournal {
  constructor(private readonly storage: MemberSessionServices['storage']) {}

  async execution(row: Coordinates, executionId: string): Promise<MemberSessionExecution | null> {
    const key = memberExecutionKey({ ...row, executionId });
    const stored = await this.storage.get('executions', key);
    if (!stored) return null;
    return decodeExecution(stored.value, row, executionId);
  }

  async archiveExecution(row: Coordinates, execution: MemberSessionExecution): Promise<void> {
    const key = memberExecutionKey({ ...row, executionId: execution.executionId });
    for (let attempt = 0; attempt < 10; attempt++) {
      const before = await this.storage.get('executions', key);
      const existing = before ? decodeExecution(before.value, row, execution.executionId) : null;
      const retained = retainedExecution(existing, execution);
      if (isDeepStrictEqual(existing, retained)) return;
      const value = {
        schema: 'host.member-execution.v1',
        sessionId: row.sessionId,
        generation: row.generation,
        execution: structuredClone(retained),
      };
      if ((await this.storage.compareAndSet('executions', key, before?.revision ?? null, value)).applied) return;
    }
    throw new Error('member_execution_journal_concurrent_write');
  }

  async grant(row: MemberSessionRecord, generation: number): Promise<MemberGrantHistory | null> {
    const stored = await this.storage.get('grant-history', `${row.sessionId}:${generation}`);
    if (!stored) return null;
    const value = stored.value as { schema?: string; grant?: MemberGrantHistory };
    const grant = value?.grant;
    if (
      value?.schema !== 'host.member-grant-history.v1' ||
      !grant ||
      grant.generation !== generation ||
      ['sessionId', 'ownerUserId', 'pluginInstanceId', 'threadId', 'catId'].some(
        (key) => grant[key as keyof MemberGrantHistory] !== row[key as keyof MemberSessionRecord],
      ) ||
      typeof grant.packageDigest !== 'string' ||
      !grant.packageDigest
    )
      throw new Error('invalid_member_grant_history');
    return structuredClone(grant);
  }

  async archiveGrant(row: MemberSessionRecord): Promise<void> {
    for (const run of Object.values(row.executions)) await this.archiveExecution(row, run);
    const {
      executions: _runs,
      consumedCursor: _cursor,
      hasConsumedInput: _consumed,
      revoked: _revoked,
      ...grant
    } = row;
    const key = `${row.sessionId}:${row.generation}`;
    const value = { schema: 'host.member-grant-history.v1', grant };
    for (let attempt = 0; attempt < 10; attempt++) {
      const before = await this.storage.get('grant-history', key);
      if (before) {
        if (!isDeepStrictEqual(before.value, value)) throw new Error('member_grant_history_conflict');
        return;
      }
      if ((await this.storage.compareAndSet('grant-history', key, null, value)).applied) return;
    }
    throw new Error('member_grant_history_concurrent_write');
  }
}
