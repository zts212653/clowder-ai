import { applyTerminalReceipt, executionIsTerminal } from './journal.js';
import type { MemberSessionStore } from './store.js';
import type {
  ExecuteMemberSession,
  MemberSessionExecution,
  MemberSessionRecord,
  MemberSessionScope,
  MemberSessionServices,
} from './types.js';
import { coordinate, digest, executeInput, memberExecutionKey } from './validation.js';

function assertNextSemanticInput(row: MemberSessionRecord, cursor: number): void {
  if (Object.values(row.executions).some((run) => ['admitting', 'queued', 'running'].includes(run.phase)))
    throw new Error('member_execution_pending');
  if (cursor < row.consumedCursor || (cursor === row.consumedCursor && row.hasConsumedInput))
    throw new Error('member_semantic_cursor_regressed');
}

function attachMessage(row: MemberSessionRecord, input: ExecuteMemberSession, messageId: string): MemberSessionRecord {
  const run = row.executions[input.executionId];
  if (run.inputDigest !== digest(input)) throw new Error('member_execution_id_conflict');
  if (run.messageId && run.messageId !== messageId) throw new Error('member_execution_message_conflict');
  return {
    ...row,
    executions: {
      ...row.executions,
      [input.executionId]: {
        ...run,
        phase: run.phase === 'admitting' ? 'queued' : run.phase,
        messageId,
      },
    },
  };
}

/** One active CAS lease, with permanent receipts outside the bounded grant value. */
export function createMemberAdmission(deps: {
  readonly store: MemberSessionStore;
  readonly scope: MemberSessionScope;
  readonly messaging: MemberSessionServices['messaging'];
  readonly required: (id: string, scope: MemberSessionScope, generation: number) => Promise<MemberSessionRecord>;
  readonly current: (row: MemberSessionRecord, scope: MemberSessionScope) => Promise<void>;
}) {
  const { store, scope } = deps;
  const mutate = (input: ExecuteMemberSession, change: (row: MemberSessionRecord) => Promise<MemberSessionRecord>) =>
    store.mutate(input.sessionId, async (row) => {
      if (!row) throw new Error('member_session_scope_mismatch');
      await deps.current(row, scope);
      if (row.generation !== input.generation) throw new Error('member_session_generation_changed');
      return change(row);
    });
  const archivedExecution = async (row: MemberSessionRecord, input: ExecuteMemberSession) => {
    const archived = await store.journal.execution(row, input.executionId);
    if (archived && archived.inputDigest !== digest(input)) throw new Error('member_execution_id_conflict');
    return archived;
  };
  const receipt = async (row: MemberSessionRecord, input: ExecuteMemberSession) => {
    const run = row.executions[input.executionId] ?? (await archivedExecution(row, input));
    if (!run) throw new Error('member_execution_journal_missing');
    return structuredClone(run);
  };
  const reserve = (input: ExecuteMemberSession) =>
    mutate(input, async (row) => {
      const archived = await archivedExecution(row, input);
      if (archived && executionIsTerminal(archived)) return applyTerminalReceipt(row, archived);
      const existing = Object.hasOwn(row.executions, input.executionId) ? row.executions[input.executionId] : undefined;
      if (existing) {
        if (existing.inputDigest !== digest(input)) throw new Error('member_execution_id_conflict');
        return row;
      }
      assertNextSemanticInput(row, input.semanticCursor);
      const run: MemberSessionExecution = {
        executionId: input.executionId,
        inputDigest: digest(input),
        semanticCursor: input.semanticCursor,
        content: input.content,
        phase: 'admitting',
        dispatchStarted: false,
      };
      return { ...row, executions: { ...row.executions, [input.executionId]: run } };
    });
  const acknowledge = (input: ExecuteMemberSession, messageId: string) =>
    mutate(input, async (row) => {
      const run = row.executions[input.executionId];
      // The child may finish before the sender's ACK. Preserve its original result.
      if (!run) {
        const archived = await archivedExecution(row, input);
        if (!archived) throw new Error('member_execution_id_conflict');
        if (archived.messageId !== messageId || !executionIsTerminal(archived))
          throw new Error('member_execution_message_conflict');
        return applyTerminalReceipt(row, archived);
      }
      return attachMessage(row, input, messageId);
    });

  return async (value: ExecuteMemberSession): Promise<MemberSessionExecution> => {
    const input = executeInput(value),
      row = await deps.required(input.sessionId, scope, input.generation);
    const executionScope: MemberSessionScope = {
      ...scope,
      assertCurrent: async () => {
        await deps.required(input.sessionId, scope, input.generation);
      },
    };
    const existing = await receipt(await reserve(input), input);
    if (existing.phase !== 'admitting') return existing;
    const lookup = { threadId: row.threadId, idempotencyKey: memberExecutionKey(input) };
    let message = await deps.messaging.findSent(lookup, executionScope);
    await executionScope.assertCurrent();
    if (
      message &&
      (message.threadId !== row.threadId || message.content !== input.content || message.deliveryStatus === 'canceled')
    )
      throw new Error('member_original_admission_canceled_or_changed');
    if (!message || message.routedCatIds.length === 0) {
      // Commit the possibility of an append before calling the transport. A
      // renewed grant cannot archive an unclaimed reserve and then let this
      // old generation cross into send after its asynchronous lookup returns.
      await mutate(input, async (current) => {
        const run = current.executions[input.executionId];
        if (!run || run.inputDigest !== digest(input)) throw new Error('member_execution_id_conflict');
        return {
          ...current,
          executions: { ...current.executions, [input.executionId]: { ...run, dispatchStarted: true } },
        };
      });
      await deps.messaging.send(
        { ...lookup, identity: row.identity, content: input.content, wake: { catId: row.catId, exact: true } },
        executionScope,
      );
      await executionScope.assertCurrent();
      message = await deps.messaging.findSent(lookup, executionScope);
      await executionScope.assertCurrent();
    }
    if (
      !message ||
      message.threadId !== row.threadId ||
      message.content !== input.content ||
      message.deliveryStatus === 'canceled' ||
      message.routedCatIds.length !== 1 ||
      message.routedCatIds[0] !== row.catId
    )
      throw new Error('member_queue_admission_unconfirmed');
    coordinate(message.messageId);
    return receipt(await acknowledge(input, message.messageId), input);
  };
}
