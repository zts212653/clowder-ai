import type { PluginCallContext } from '../carrier/plugin-call-context.js';
import type { MemberSessionStore } from './store.js';
import type { HostMemberExecutions, MemberSessionScope } from './types.js';

export type MemberCallbackIdentity = Pick<
  PluginCallContext,
  'catId' | 'userId' | 'threadId' | 'invocationId' | 'originTriggerMessageId' | 'toolExecutionPolicy'
>;

/** Resolves the response from the Host's lease, never from the tool body. */
export function createHostMemberCallback(
  store: MemberSessionStore,
  scope: MemberSessionScope,
  executions: HostMemberExecutions,
) {
  return async (caller: MemberCallbackIdentity): Promise<void> => {
    const policy = caller.toolExecutionPolicy;
    if (policy?.mode !== 'plugin_native' || !policy.memberSession) throw new Error('member_callback_scope_required');
    const lease = policy.memberSession;
    const row = (await store.get(lease.sessionId))?.value;
    if (
      !row ||
      row.ownerUserId !== caller.userId ||
      row.ownerUserId !== scope.ownerUserId ||
      row.pluginInstanceId !== scope.pluginInstanceId ||
      row.pluginInstanceId !== policy.pluginInstanceId ||
      row.packageDigest !== scope.packageDigest ||
      row.contributionId !== policy.contributionId ||
      row.catId !== caller.catId ||
      row.threadId !== caller.threadId
    )
      throw new Error('member_callback_scope_mismatch');
    const run = Object.hasOwn(row.executions, lease.executionId) ? row.executions[lease.executionId] : undefined;
    if (
      !run ||
      !run.responseMessageId ||
      run.messageId !== caller.originTriggerMessageId ||
      run.invocationId !== caller.invocationId
    )
      throw new Error('member_callback_execution_mismatch');
    await executions.assertCurrent({
      ...lease,
      invocationId: caller.invocationId,
      responseMessageId: run.responseMessageId,
    });
  };
}
