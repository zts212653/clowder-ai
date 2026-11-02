import type { CatConfig } from '@cat-cafe/shared';
import {
  type FrozenExecutionBinding,
  freezeExecutionAccountBinding,
} from '../../cats/services/agents/invocation/execution-account-binding.js';
import type { FrozenExecutionWorkspace } from '../../cats/services/agents/invocation/execution-workspace.js';
import { InvocationServiceScope } from '../../cats/services/agents/invocation/invocation-service-scope.js';
import type { AgentService } from '../../cats/services/types.js';
import type { MemberRuntimeSnapshot, MemberSessionGrant, MemberSessionScope, PrepareMemberSession } from './types.js';

type Input = PrepareMemberSession | MemberSessionGrant;
export interface MemberRuntimeFrame {
  readonly service: AgentService;
  readonly binding: FrozenExecutionBinding;
  readonly runtime: MemberRuntimeSnapshot;
  release(): Promise<void>;
}

/** Uses the normal account resolver in memory. Revalidation pins the original
 * grant's account, independently of changes to the member's outside default. */
export function createMemberRuntime(deps: {
  config(catId: string): CatConfig;
  service(catId: string, config: CatConfig): AgentService;
  workspace(
    input: PrepareMemberSession,
    scope: MemberSessionScope,
    config: CatConfig,
  ): Promise<FrozenExecutionWorkspace>;
}) {
  const acquire = async (value: Input, scope: MemberSessionScope): Promise<MemberRuntimeFrame> => {
    const input = structuredClone(value);
    const config = structuredClone(deps.config(input.catId));
    const services = new InvocationServiceScope();
    try {
      await scope.assertCurrent();
      const service = services.pin(deps.service(input.catId, config));
      const policy = {
        mode: 'plugin_native' as const,
        pluginInstanceId: scope.pluginInstanceId,
        contributionId: input.contributionId,
        memberSession: { sessionId: 'capability-preflight', generation: 1, executionId: 'capability-preflight' },
      };
      if (!service.supportsToolExecutionPolicy?.(policy)) throw new Error('member_native_carrier_unavailable');
      const workspace = await deps.workspace(input, scope, config);
      await scope.assertCurrent();
      if (!workspace.workingDirectory) throw new Error('member_thread_workspace_unavailable');
      const stored = 'schema' in input && input.schema === 'host.member-session.v1' ? input.runtime : undefined;
      const binding = freezeExecutionAccountBinding({
        catId: input.catId,
        catConfig: config,
        model: config.defaultModel,
        workspace,
        nativeAccount: await service.resolveScopedNativeAccount?.({
          workingDirectory: workspace.workingDirectory,
          accountRef: stored?.account.accountRef ?? input.accountSelection?.accountRef,
        }),
        accountSelection: stored
          ? {
              accountRef: stored.account.accountRef,
              authType: stored.account.authType,
              expectedRevision: stored.account.accountRevision,
            }
          : input.accountSelection,
      });
      const account = binding.executionAccount;
      if (account) service.assertScopedMemberAccount?.(account);
      const capability = service.freshnessCarrierCapability?.();
      const carrier = service.contextCapability?.().carrier === 'acp' ? 'acp' : capability?.carrier;
      if (!account || !carrier || !config.clientId || !config.defaultModel)
        throw new Error('member_runtime_snapshot_unavailable');
      await scope.assertCurrent();
      const runtime: MemberRuntimeSnapshot = Object.freeze({
        clientId: config.clientId,
        model: config.defaultModel,
        carrier,
        account: Object.freeze({
          accountRef: account.accountRef,
          authType: account.authType,
          accountRevision: account.accountRevision,
        }),
      });
      return { service, binding, runtime, release: () => services.dispose() };
    } catch (error) {
      try {
        await services.dispose();
      } catch (releaseError) {
        throw new AggregateError([error, releaseError], 'member runtime preparation failed');
      }
      throw error;
    }
  };
  return {
    acquire,
    async snapshot(input: Input, scope: MemberSessionScope): Promise<MemberRuntimeSnapshot> {
      const frame = await acquire(input, scope);
      try {
        return frame.runtime;
      } finally {
        await frame.release();
      }
    },
  };
}
