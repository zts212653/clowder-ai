import type { MemberCallbackIdentity } from './callback.js';
import type { MemberRouterServices } from './router.js';
import type { createPluginMemberSessions } from './service.js';
import type {
  CreateMemberSession,
  EnsureMemberThread,
  MemberExecutionClaim,
  MemberResourceDescription,
  MemberSessionExecution,
  MemberSessionRecord,
  MemberSessionScope,
  MemberSessionSummary,
  MemberThreadBinding,
  PluginMemberSessions,
} from './types.js';
import { executeInput, memberExecutionKey } from './validation.js';

/** Optional generic module port. Owner authority is supplied by the Host's
 * existing Settings/HTTP context, never a boolean in these method arguments. */
export interface PluginMemberSessionsHost extends PluginMemberSessions {
  create(input: CreateMemberSession): Promise<MemberSessionSummary>;
  ensureThread(input: EnsureMemberThread): Promise<MemberThreadBinding>;
  describe(input: { readonly catId: string }): Promise<MemberResourceDescription>;
}
interface ExecutionScope {
  readonly sessionId: string;
  readonly generation: number;
  readonly scope: MemberSessionScope;
  readonly controller: AbortController;
  readonly signal: AbortSignal;
}

/** Process-local permission handles. Inputs and results live in persistent Host
 * storage; an API restart cannot revive an old native child's permission. */
export function createMemberSessionHost(sessions: ReturnType<typeof createPluginMemberSessions>) {
  const scopes = new Map<string, ExecutionScope>();
  const callbacks = new Map<
    string,
    { claim: MemberExecutionClaim; assert: (caller: MemberCallbackIdentity) => Promise<void> }
  >();
  const execution = (row: MemberSessionRecord, run: MemberSessionExecution) => {
    const active = scopes.get(memberExecutionKey({ ...run, sessionId: row.sessionId, generation: row.generation }));
    if (
      !active ||
      active.scope.pluginInstanceId !== row.pluginInstanceId ||
      active.scope.packageDigest !== row.packageDigest ||
      active.scope.ownerUserId !== row.ownerUserId
    )
      throw new Error('member_original_admission_scope_unavailable');
    return active;
  };
  return {
    forInstance(input: MemberSessionScope, activationSignal?: AbortSignal): PluginMemberSessionsHost {
      const scope = { ...input, assertCurrent: input.assertCurrent.bind(input) };
      const port = sessions.forInstance(scope);
      return {
        create: sessions.hostCreateForInstance(scope),
        ensureThread: sessions.hostEnsureThreadForInstance(scope),
        describe: sessions.hostDescribeForInstance(scope),
        async prepare(input) {
          const binding = await sessions.hostThreadBinding(input.threadId);
          if (
            !binding ||
            binding.pluginInstanceId !== scope.pluginInstanceId ||
            binding.ownerUserId !== scope.ownerUserId ||
            binding.catId !== input.catId
          )
            throw new Error('member_thread_is_not_controlled');
          return port.prepare(input);
        },
        async execute(value) {
          const input = executeInput(value);
          await sessions.hostGrantForInstance(scope)(input.sessionId, input.generation);
          await sessions.hostReconcileForInstance(scope)(input);
          const grant = await sessions.hostGrantForInstance(scope)(input.sessionId, input.generation);
          if (
            Object.values(grant.executions).some(
              (run) => ['admitting', 'queued', 'running'].includes(run.phase) && run.executionId !== input.executionId,
            )
          )
            throw new Error('member_execution_pending');
          const key = memberExecutionKey(input);
          let active = scopes.get(key);
          if (active) {
            await active.scope.assertCurrent();
            if (active.signal.aborted) throw new Error('member_original_admission_stopped');
          } else {
            await scope.assertCurrent();
            const controller = new AbortController();
            active = {
              sessionId: input.sessionId,
              generation: input.generation,
              scope,
              controller,
              signal: activationSignal ? AbortSignal.any([activationSignal, controller.signal]) : controller.signal,
            };
            scopes.set(key, active);
          }
          const result = await port.execute(input);
          if (!['admitting', 'queued', 'running'].includes(result.phase)) scopes.delete(key);
          return result;
        },
        get: port.get,
        getExecution: port.getExecution,
        async revoke(sessionId) {
          const result = await port.revoke(sessionId);
          for (const active of scopes.values()) {
            if (
              active.scope.pluginInstanceId !== scope.pluginInstanceId ||
              active.scope.ownerUserId !== scope.ownerUserId
            )
              continue;
            if (active.sessionId === sessionId && active.generation === result.generation)
              active.controller.abort('user_cancel');
          }
          return result;
        },
      };
    },
    executionScope(row: MemberSessionRecord, run: MemberSessionExecution) {
      return execution(row, run).scope;
    },
    executionSignal(row: MemberSessionRecord, run: MemberSessionExecution) {
      return execution(row, run).signal;
    },
    registerCallback: ((claim, assert) => {
      if (callbacks.has(claim.invocationId)) throw new Error('member_child_callback_already_bound');
      const binding = { claim: { ...claim }, assert };
      callbacks.set(claim.invocationId, binding);
      return () => {
        if (callbacks.get(claim.invocationId) === binding) callbacks.delete(claim.invocationId);
      };
    }) satisfies MemberRouterServices['registerCallback'],
    finishExecution(claim: MemberExecutionClaim): void {
      const key = memberExecutionKey(claim);
      scopes.get(key)?.controller.abort('execution_finished');
      scopes.delete(key);
    },
    async assertCallback(caller: MemberCallbackIdentity): Promise<void> {
      const binding = callbacks.get(caller.invocationId),
        lease =
          caller.toolExecutionPolicy?.mode === 'plugin_native' ? caller.toolExecutionPolicy.memberSession : undefined;
      if (!binding || !lease || memberExecutionKey(binding.claim) !== memberExecutionKey(lease))
        throw new Error('member_original_callback_scope_unavailable');
      await binding.assert(caller);
    },
  };
}
