import { boundExecution, executionClaim, readExecutionEvidence, requireRunning } from './execution-evidence.js';
import { applyTerminalReceipt } from './journal.js';
import type { MemberSessionStore } from './store.js';
import { readMemberTerminalReceipt } from './terminal-receipt.js';
import type {
  HostMemberExecutions,
  MemberCanonicalExecutionSources,
  MemberExecutionClaim,
  MemberSessionExecution,
  MemberSessionRecord,
  MemberSessionScope,
  MemberSessionServices,
} from './types.js';
import { coordinate, memberExecutionKey } from './validation.js';

type SettlementPrincipal = Pick<MemberSessionRecord, 'ownerUserId' | 'pluginInstanceId' | 'packageDigest'>;
function settlementRecord(
  row: SettlementPrincipal | null,
  scope: MemberSessionScope,
): asserts row is SettlementPrincipal {
  if (
    !row ||
    row.ownerUserId !== scope.ownerUserId ||
    row.pluginInstanceId !== scope.pluginInstanceId ||
    row.packageDigest !== scope.packageDigest
  )
    throw new Error('member_session_scope_mismatch');
}

/** Internal lifecycle adapter. Only forInstance() is handed to a plugin. */
export function createHostMemberExecutions(deps: {
  readonly store: MemberSessionStore;
  readonly scope: MemberSessionScope;
  readonly sources: MemberCanonicalExecutionSources;
  readonly messaging: MemberSessionServices['messaging'];
  readonly current: (row: MemberSessionRecord, scope: MemberSessionScope) => Promise<void>;
}): HostMemberExecutions {
  const { store, sources, scope } = deps;
  const current = async (row: MemberSessionRecord | null, input: MemberExecutionClaim) => {
    if (!row) throw new Error('member_session_scope_mismatch');
    await deps.current(row, scope);
    return boundExecution(row, input);
  };
  const replace = (row: MemberSessionRecord, execution: MemberSessionExecution): MemberSessionRecord => ({
    ...row,
    executions: { ...row.executions, [execution.executionId]: execution },
  });

  return {
    async claim(value) {
      const input = executionClaim(value);
      const result = await store.mutate(input.sessionId, async (row) => {
        let run = await current(row, input);
        if (!row) throw new Error('member_session_scope_mismatch');
        if (!['admitting', 'queued', 'running'].includes(run.phase)) throw new Error('member_execution_not_running');
        if (!run.messageId) {
          const original = await deps.messaging.findSent(
            { threadId: row.threadId, idempotencyKey: memberExecutionKey(input) },
            scope,
          );
          if (
            !original ||
            original.threadId !== row.threadId ||
            original.content !== run.content ||
            original.deliveryStatus === 'canceled' ||
            original.routedCatIds.length !== 1 ||
            original.routedCatIds[0] !== row.catId
          )
            throw new Error('member_execution_evidence_mismatch');
          coordinate(original.messageId);
          run = { ...run, messageId: original.messageId };
        }
        requireRunning(await readExecutionEvidence(sources, row, run, input));
        await deps.current(row, scope);
        return replace(row, {
          ...run,
          phase: 'running',
          invocationId: input.invocationId,
          responseMessageId: input.responseMessageId,
        });
      });
      return structuredClone(result.executions[input.executionId]);
    },
    async assertCurrent(value) {
      const input = executionClaim(value);
      const stored = await store.get(input.sessionId);
      const row = stored?.value ?? null;
      const run = await current(row, input);
      if (!row || run.phase !== 'running' || !run.invocationId || !run.responseMessageId)
        throw new Error('member_execution_not_running');
      requireRunning(await readExecutionEvidence(sources, row, run, input));
      // Evidence reads are asynchronous: re-read the grant after them so a concurrent
      // revoke/regrant cannot leave a cached generation authorized for the callback.
      const latest = await store.get(input.sessionId);
      const active = await current(latest?.value ?? null, input);
      if (
        active.phase !== 'running' ||
        active.invocationId !== input.invocationId ||
        active.responseMessageId !== input.responseMessageId
      )
        throw new Error('member_execution_not_running');
    },
    async settle(value) {
      const input = executionClaim(value);
      const result = await store.mutate(input.sessionId, async (row) => {
        // Recording immutable canonical facts is not permission to act. A stopped
        // installation or revoked account must still be able to finish its ledger.
        if (!row || row.ownerUserId !== scope.ownerUserId || row.pluginInstanceId !== scope.pluginInstanceId)
          throw new Error('member_session_scope_mismatch');
        if (row.generation < input.generation) throw new Error('member_session_generation_changed');
        const historical = row.generation !== input.generation;
        const original = historical ? await store.journal.grant(row, input.generation) : row;
        settlementRecord(original, scope);
        const run = boundExecution(original, input, await store.journal.execution(original, input.executionId));
        let receipt: MemberSessionExecution;
        try {
          receipt = await readMemberTerminalReceipt(sources, original, run, input);
        } catch (error) {
          if (error instanceof Error && error.message === 'member_execution_evidence_unavailable')
            throw new Error('member_execution_evidence_mismatch', { cause: error });
          throw error;
        }
        await store.journal.archiveExecution(original, receipt);
        // A late child may finish its original journal after owner renewal.
        // Its old cursor and permission never project into the new generation.
        return historical ? row : applyTerminalReceipt(row, receipt);
      });
      const archived = await store.journal.execution(
        { sessionId: result.sessionId, generation: input.generation },
        input.executionId,
      );
      if (!archived) throw new Error('member_execution_journal_missing');
      return archived;
    },
  };
}
