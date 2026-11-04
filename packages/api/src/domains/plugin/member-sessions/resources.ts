import { type AccountConfig, builtinAccountIdForClient, type CatConfig, type ClientId } from '@cat-cafe/shared';
import { type RuntimeProviderProfile, resolveBuiltinClientForProvider } from '../../../config/account-resolver.js';
import { readAccountStoreSnapshot } from '../../../config/account-store-snapshot.js';
import { resolveBoundAccountRefForCat } from '../../../config/cat-account-binding.js';
import { freezeExecutionAccountBinding } from '../../cats/services/agents/invocation/execution-account-binding.js';
import type { AgentService } from '../../cats/services/types.js';
import type { MemberResourceDescription, MemberSessionScope, MemberSessionServices } from './types.js';

type Account = MemberResourceDescription['accounts'][number];
interface ResourceServices {
  readonly projectRoot: string;
  config(catId: string): CatConfig;
  service(catId: string, config: CatConfig): AgentService;
  memory(catId: string, scope: MemberSessionScope): Promise<MemberResourceDescription['memory']>;
  /** The ordinary execution resolver is also used here; credentials never leave this frame. */
  readonly freezeAccount?: typeof freezeExecutionAccountBinding;
  readonly readAccounts?: typeof readAccountStoreSnapshot;
  readonly defaultAccount?: typeof resolveBoundAccountRefForCat;
}
interface Discovery {
  readonly catId: string;
  readonly config: CatConfig;
  readonly service: AgentService;
  readonly supported: boolean;
  readonly defaultAccountRef: string | null | undefined;
}
function unavailable(ref: string, metadata: AccountConfig | undefined, reason: string): Account | undefined {
  // Unknown/rejected metadata must not invent an authentication method.
  return metadata
    ? {
        accountRef: ref,
        displayName: metadata.displayName ?? ref,
        authType: metadata.authType,
        available: false,
        reason,
      }
    : undefined;
}
function accountOption(
  deps: ResourceServices,
  frame: Discovery,
  ref: string,
  metadata: AccountConfig | undefined,
  nativeAccount?: RuntimeProviderProfile,
): Account | undefined {
  if (!frame.supported) return unavailable(ref, metadata, 'member_native_carrier_unavailable');
  try {
    const binding = (deps.freezeAccount ?? freezeExecutionAccountBinding)({
      catId: frame.catId,
      catConfig: frame.config,
      model: frame.config.defaultModel,
      workspace: {
        workingDirectory: deps.projectRoot,
        workingProjectRoot: deps.projectRoot,
        usesDefaultWorkspace: false,
      },
      ...(nativeAccount ? { nativeAccount } : {}),
      ...(ref === frame.defaultAccountRef
        ? {}
        : { accountSelection: { accountRef: ref, authType: metadata?.authType ?? 'oauth' } }),
    });
    const account = binding.executionAccount;
    if (!account || account.accountRef !== ref) throw new Error('member_account_changed');
    frame.service.assertScopedMemberAccount?.(account);
    return {
      accountRef: account.accountRef,
      displayName: account.displayName,
      authType: account.authType,
      accountRevision: account.accountRevision,
      available: true,
      ...(!binding.resolvedAccount?.syntheticNative
        ? {
            selection: {
              accountRef: account.accountRef,
              authType: account.authType,
              expectedRevision: account.accountRevision,
            },
          }
        : {}),
    };
  } catch {
    // Resolver errors can contain credential coordinates. Plugins receive only this safe code.
    return unavailable(ref, metadata, 'member_account_unavailable');
  }
}
async function accountOptions(deps: ResourceServices, frame: Discovery): Promise<readonly Account[]> {
  const family = resolveBuiltinClientForProvider(frame.config.clientId);
  if (!family) {
    if (!frame.supported) return [];
    try {
      const native = await frame.service.resolveScopedNativeAccount?.({ workingDirectory: deps.projectRoot });
      if (!native) return [];
      const option = accountOption(
        deps,
        { ...frame, defaultAccountRef: frame.defaultAccountRef ?? native.id },
        native.id,
        { clientId: frame.config.clientId, authType: native.authType, displayName: native.displayName },
        native,
      );
      return option ? [option] : [];
    } catch {
      return [];
    }
  }
  const catalog = (deps.readAccounts ?? readAccountStoreSnapshot)(deps.projectRoot);
  const refs = new Set([...(frame.defaultAccountRef ? [frame.defaultAccountRef] : []), ...catalog.refs]);
  const options = await Promise.all(
    [...refs].map(async (ref) => {
      const inspected = catalog.inspect(ref);
      if (inspected.state === 'rejected') return [];
      const metadata = inspected.entry.account;
      if (
        (metadata?.clientId && resolveBuiltinClientForProvider(metadata.clientId as ClientId) !== family) ||
        (!metadata && ref !== frame.defaultAccountRef)
      )
        return [];
      try {
        const native = frame.supported
          ? await frame.service.resolveScopedNativeAccount?.({
              workingDirectory: deps.projectRoot,
              accountRef: ref,
            })
          : undefined;
        const option = accountOption(deps, frame, ref, metadata, native ?? undefined);
        return option ? [option] : [];
      } catch {
        const option = unavailable(ref, metadata, 'member_account_unavailable');
        return option ? [option] : [];
      }
    }),
  );
  return options.flat();
}

/** Owner discovery is descriptive: no thread, grant, login, child or model is created. */
export function createMemberResourceDescription(
  deps: ResourceServices,
): NonNullable<MemberSessionServices['describeResources']> {
  return async (catId, scope) => {
    const config = structuredClone(deps.config(catId));
    const service = deps.service(catId, config);
    const policy = {
      mode: 'plugin_native' as const,
      pluginInstanceId: scope.pluginInstanceId,
      contributionId: 'capability-preflight',
      memberSession: {
        sessionId: 'capability-preflight',
        generation: 1,
        executionId: 'capability-preflight',
      },
    };
    const supported = service.supportsToolExecutionPolicy?.(policy) === true;
    const contextCarrier = service.contextCapability?.().carrier;
    const carrier =
      contextCarrier === 'acp' ? 'acp' : (service.freshnessCarrierCapability?.().carrier ?? contextCarrier);
    const family = resolveBuiltinClientForProvider(config.clientId);
    let defaultAccountRef =
      (deps.defaultAccount ?? resolveBoundAccountRefForCat)(deps.projectRoot, catId, config) ??
      (family ? builtinAccountIdForClient(family) : undefined);
    const accounts = await accountOptions(deps, { catId, config, service, supported, defaultAccountRef });
    if (!family && !defaultAccountRef) defaultAccountRef = accounts.find((account) => account.available)?.accountRef;
    const memory = (await deps.memory(catId, scope)).map(({ sourceRef, revision, bytes }) => ({
      sourceRef,
      revision,
      bytes,
    }));
    await scope.assertCurrent();
    const available = supported && accounts.some((account) => account.available);
    return {
      schema: 'host.member-resources.v1',
      catId,
      ...(carrier ? { runtime: { clientId: config.clientId, model: config.defaultModel, carrier } } : {}),
      ...(defaultAccountRef ? { defaultAccountRef } : {}),
      available,
      ...(!available ? { reason: supported ? 'member_account_unavailable' : 'member_native_carrier_unavailable' } : {}),
      accounts,
      memory,
    };
  };
}
