import { createMemberAdmission } from './admission.js';
import { readHistoricalMemberAdmission } from './admission-recovery.js';
import { createHostMemberCallback } from './callback.js';
import { createHostMemberExecutions } from './execution.js';
import { executionIsTerminal } from './journal.js';
import { ownerRequest } from './owner-authority.js';
import { MemberSessionStore, sessionIdFor } from './store.js';
import { readMemberTerminalReceipt } from './terminal-receipt.js';
import { createOwnerMemberThread, ensureOwnerMemberThread, readMemberThreadBinding } from './threads.js';
import type {
  CreateMemberSession,
  ExecuteMemberSession,
  MemberSessionRecord,
  MemberSessionScope,
  MemberSessionServices,
  MemberSessionSummary,
  PluginMemberSessions,
} from './types.js';
import { coordinate, digest, executeInput, executionLookup, prepareInput, runtimeSnapshot } from './validation.js';

const evidencePending = (error: unknown): boolean =>
  error instanceof Error &&
  ['member_execution_settlement_pending', 'member_execution_evidence_unavailable'].includes(error.message);

function summary(row: MemberSessionRecord): MemberSessionSummary {
  const {
    executions: _runs,
    prepareDigest: _digest,
    ownerRequestId: _ownerRequest,
    hasConsumedInput: _consumed,
    ...publicRow
  } = row;
  return structuredClone(publicRow);
}
function owned(row: MemberSessionRecord | null, scope: MemberSessionScope): asserts row is MemberSessionRecord {
  if (!row || row.pluginInstanceId !== scope.pluginInstanceId || row.ownerUserId !== scope.ownerUserId)
    throw new Error('member_session_scope_mismatch');
}
function scoped(row: MemberSessionRecord | null, scope: MemberSessionScope): asserts row is MemberSessionRecord {
  owned(row, scope);
  if (row.packageDigest !== scope.packageDigest) throw new Error('member_session_scope_mismatch');
}
function preparationIsRetry(
  before: MemberSessionRecord,
  scope: MemberSessionScope,
  ownerRequestId: string,
  inputDigest: string,
): boolean {
  owned(before, scope);
  if (before.packageDigest !== scope.packageDigest) return false;
  if (before.activationId !== scope.activationId) {
    if (before.ownerRequestId === ownerRequestId) throw new Error('member_session_activation_changed');
    return false;
  }
  if (before.ownerRequestId === ownerRequestId) {
    if (before.prepareDigest !== inputDigest) throw new Error('member_session_prepare_conflict');
    return true;
  }
  if (!before.revoked) throw new Error('member_session_already_prepared');
  return false;
}

/** Persistent owner grant and exact Queue admission. Providers and callbacks stay
 * in the existing Host execution pipeline; a package never receives credentials. */
export function createPluginMemberSessions(deps: MemberSessionServices) {
  const store = new MemberSessionStore(deps.storage);
  const current = async (row: MemberSessionRecord, scope: MemberSessionScope): Promise<void> => {
    scoped(row, scope);
    if (row.revoked) throw new Error('member_session_revoked');
    if (row.activationId !== scope.activationId) throw new Error('member_session_activation_changed');
    await scope.assertCurrent();
    await deps.assertInstallation(scope, row.contributionId);
    await deps.assertThread(scope.ownerUserId, row.threadId, row.catId);
    const runtime = runtimeSnapshot(await deps.resolveRuntime(row, scope));
    if (digest(runtime) !== digest(row.runtime)) throw new Error('member_session_runtime_changed');
    let bytes = 0;
    for (const ref of row.memory) {
      const memory = await deps.resolveMemory(ref, { ...scope, catId: row.catId });
      if (memory.sourceRef !== ref.sourceRef || memory.revision !== ref.revision || typeof memory.text !== 'string')
        throw new Error('member_session_memory_changed');
      bytes += Buffer.byteLength(memory.text);
      if (bytes > 65536) throw new Error('member_session_memory_too_large');
    }
    await scope.assertCurrent();
  };
  const required = async (id: string, scope: MemberSessionScope, generation: number) => {
    const stored = await store.get(id);
    scoped(stored?.value ?? null, scope);
    const row = stored?.value;
    if (!row) throw new Error('member_session_scope_mismatch');
    if (row.generation !== generation) throw new Error('member_session_generation_changed');
    await current(row, scope);
    // Runtime/memory checks await external sources. A new grant may have won
    // during them; only the same still-live generation authorizes admission.
    const latest = (await store.get(id))?.value ?? null;
    scoped(latest, scope);
    if (latest.generation !== generation) throw new Error('member_session_generation_changed');
    if (latest.revoked) throw new Error('member_session_revoked');
    return latest;
  };

  const reconcile = async (scope: MemberSessionScope, input: ExecuteMemberSession) => {
    if (deps.canonicalExecution) {
      const row = (await store.get(input.sessionId))?.value ?? null;
      scoped(row, scope);
      if (row.generation !== input.generation) throw new Error('member_session_generation_changed');
      await scope.assertCurrent();
      await deps.assertInstallation(scope, row.contributionId);
      const finalizer = createHostMemberExecutions({
        store,
        scope,
        sources: deps.canonicalExecution,
        messaging: deps.messaging,
        current,
      });
      for (const run of Object.values(row.executions)) {
        let receipt: Awaited<ReturnType<typeof readMemberTerminalReceipt>>;
        try {
          receipt = await readMemberTerminalReceipt(deps.canonicalExecution, row, run);
        } catch (error) {
          if (evidencePending(error)) continue;
          throw error;
        }
        await finalizer.settle({
          sessionId: row.sessionId,
          generation: row.generation,
          executionId: run.executionId,
          invocationId: receipt.invocationId,
          responseMessageId: receipt.responseMessageId,
        });
      }
    }
  };

  const api = {
    hostReconcileForInstance(inputScope: MemberSessionScope) {
      const scope = { ...inputScope };
      return (value: ExecuteMemberSession) => reconcile(scope, executeInput(value));
    },
    hostGrantForInstance(inputScope: MemberSessionScope) {
      const scope = { ...inputScope };
      return (sessionId: string, generation: number) => required(sessionId, scope, generation);
    },
    hostThreadBinding(threadId: string) {
      return readMemberThreadBinding(deps.storage, threadId);
    },
    hostDescribeForInstance(inputScope: MemberSessionScope) {
      const scope = { ...inputScope };
      return async (value: { readonly catId: string }) => {
        const owner = ownerRequest(scope, false, deps.assertOwnerDelegation);
        if (
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          Object.keys(value).some((key) => key !== 'catId')
        )
          throw new Error('invalid_member_resource_input');
        coordinate(value.catId);
        const catId = value.catId;
        await owner.assertCurrent();
        await scope.assertCurrent();
        if (!deps.describeResources) throw new Error('member_resource_description_unavailable');
        const result = await deps.describeResources(catId, scope);
        await scope.assertCurrent();
        await owner.assertCurrent();
        return structuredClone(result);
      };
    },
    hostEnsureThreadForInstance(scope: MemberSessionScope) {
      return ensureOwnerMemberThread({
        scope: { ...scope },
        storage: deps.storage,
        threads: deps.threadCreation,
        assertInstallation: deps.assertInstallation,
        assertOwnerDelegation: deps.assertOwnerDelegation,
      });
    },
    hostCreateForInstance(
      inputScope: MemberSessionScope,
    ): (input: CreateMemberSession) => Promise<MemberSessionSummary> {
      const scope = { ...inputScope };
      return createOwnerMemberThread({
        scope,
        storage: deps.storage,
        threads: deps.threadCreation,
        prepare: (input) => api.forInstance(scope).prepare(input),
        assertOwnerDelegation: deps.assertOwnerDelegation,
      });
    },
    hostCallbackForInstance(scope: MemberSessionScope) {
      if (!deps.canonicalExecution) throw new Error('member_execution_canonical_sources_unavailable');
      const capturedScope = { ...scope };
      return createHostMemberCallback(
        store,
        capturedScope,
        createHostMemberExecutions({
          store,
          scope: capturedScope,
          sources: deps.canonicalExecution,
          messaging: deps.messaging,
          current,
        }),
      );
    },
    hostExecutionsForInstance(inputScope: MemberSessionScope) {
      const scope = { ...inputScope };
      if (!deps.canonicalExecution) throw new Error('member_execution_canonical_sources_unavailable');
      return createHostMemberExecutions({
        store,
        scope,
        sources: deps.canonicalExecution,
        messaging: deps.messaging,
        current,
      });
    },
    forInstance(inputScope: MemberSessionScope): PluginMemberSessions {
      const scope = { ...inputScope };
      for (const id of [scope.pluginInstanceId, scope.ownerUserId, scope.packageDigest]) coordinate(id);
      if (scope.activationId !== undefined) coordinate(scope.activationId);
      const admit = createMemberAdmission({ store, scope, messaging: deps.messaging, current, required });
      return {
        async prepare(value) {
          const owner = ownerRequest(scope, true, deps.assertOwnerDelegation),
            input = prepareInput(value);
          await owner.assertCurrent();
          await scope.assertCurrent();
          const id = sessionIdFor(scope.ownerUserId, input.threadId),
            inputDigest = digest(input);
          const runtime = runtimeSnapshot(await deps.resolveRuntime(input, scope));
          const record = await store.mutate(id, async (before) => {
            await owner.assertCurrent();
            if (before && preparationIsRetry(before, scope, owner.requestId, inputDigest)) {
              await current(before, scope);
              return before;
            }
            const next: MemberSessionRecord = {
              ...input,
              ...(scope.activationId ? { activationId: scope.activationId } : {}),
              schema: 'host.member-session.v1',
              sessionId: id,
              ownerUserId: scope.ownerUserId,
              pluginInstanceId: scope.pluginInstanceId,
              packageDigest: scope.packageDigest,
              ownerRequestId: owner.requestId,
              prepareDigest: inputDigest,
              generation: (before?.generation ?? 0) + 1,
              revoked: false,
              runtime,
              consumedCursor: 0,
              hasConsumedInput: false,
              executions: {},
            };
            await current(next, scope);
            await owner.assertCurrent();
            if (before) await store.journal.archiveGrant(before);
            return next;
          });
          return summary(record);
        },
        async execute(value) {
          const input = executeInput(value);
          await reconcile(scope, input);
          return admit(input);
        },
        async get(id) {
          const row = await store.get(id);
          if (!row) return null;
          scoped(row.value, scope);
          // A revoked grant stays readable to its owner; it cannot execute.
          await scope.assertCurrent();
          await deps.assertInstallation(scope, row.value.contributionId);
          return summary(row.value);
        },
        async getExecution(value) {
          const input = executionLookup(value);
          const stored = await store.get(input.sessionId);
          scoped(stored?.value ?? null, scope);
          if (!stored) throw new Error('member_session_scope_mismatch');
          const row = stored.value;
          if (input.generation > row.generation) throw new Error('member_session_generation_changed');
          await scope.assertCurrent();
          await deps.assertInstallation(scope, row.contributionId);
          // Only the immutable journal lookup uses the historical generation.
          // No action permission or current grant is synthesized from old data.
          const receipt = await store.journal.execution({ ...row, generation: input.generation }, input.executionId);
          const active =
            input.generation === row.generation && Object.hasOwn(row.executions, input.executionId)
              ? row.executions[input.executionId]
              : null;
          let result = receipt ?? active;
          if (result && !executionIsTerminal(result) && deps.canonicalExecution) {
            const original =
              input.generation === row.generation ? row : await store.journal.grant(row, input.generation);
            if (!original) throw new Error('member_original_grant_unavailable');
            result = await readHistoricalMemberAdmission(deps.canonicalExecution, original, row.generation, result);
            if (result.admissionState !== 'not_dispatched') {
              try {
                result = await readMemberTerminalReceipt(deps.canonicalExecution, original, result);
              } catch (error) {
                if (!evidencePending(error)) throw error;
              }
            }
          }
          await scope.assertCurrent();
          return structuredClone(result);
        },
        async revoke(id) {
          const owner = ownerRequest(scope, false, deps.assertOwnerDelegation);
          const result = await store.mutate(id, async (before) => {
            scoped(before, scope);
            await owner.assertCurrent();
            await scope.assertCurrent();
            return { ...before, revoked: true };
          });
          return summary(result);
        },
      };
    },
  };
  return api;
}
